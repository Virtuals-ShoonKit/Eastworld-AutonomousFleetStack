#!/usr/bin/env python3
"""
Standalone ZED -> WebRTC streamer for Jetson Orin NX.

Pipeline:  zedsrc -> nvvideoconvert -> nvv4l2h264enc -> rtph264pay -> webrtcbin
Signaling: WebSocket to host fleet server

No ROS dependency -- runs as a plain process alongside the ROS stack.
Requires: ZED SDK + ZED GStreamer plugins, JetPack 6 (GStreamer 1.20+,
gst-plugins-bad with webrtcbin, NVENC via nvv4l2h264enc).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from pathlib import Path

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstSdp", "1.0")
gi.require_version("GstWebRTC", "1.0")
from gi.repository import Gst, GstSdp, GstWebRTC, GLib  # noqa: E402

import websockets  # noqa: E402
import yaml  # noqa: E402

log = logging.getLogger("zed_webrtc")

# ---------------------------------------------------------------------------
# GStreamer pipeline
# ---------------------------------------------------------------------------

PIPELINE_TPL = (
    "zedsrc stream-type={stream_type} camera-resolution={resolution} camera-fps={fps} "
    "! queue leaky=downstream max-size-buffers=1 "
    "! nvvideoconvert "
    '! "video/x-raw(memory:NVMM),format=NV12" '
    "! nvv4l2h264enc bitrate={bitrate} iframeinterval={gop} "
    "insert-sps-pps=true maxperf-enable=true preset-level=1 control-rate=1 "
    "! rtph264pay config-interval=1 pt=96 "
    '! "application/x-rtp,media=video,encoding-name=H264,payload=96" '
    "! webrtcbin name=webrtc bundle-policy=max-bundle"
)


class ZedWebRTCStreamer:
    """Manages the GStreamer pipeline and WebSocket signaling."""

    def __init__(self, robot_id: str, host_url: str, zed_cfg: dict):
        self.robot_id = robot_id
        self.host_url = host_url
        self.zed_cfg = zed_cfg
        self.pipeline: Gst.Pipeline | None = None
        self.webrtcbin: Gst.Element | None = None
        self.ws: websockets.WebSocketClientProtocol | None = None
        self._loop = asyncio.get_event_loop()

    # -- pipeline -----------------------------------------------------------

    def _build_pipeline(self):
        desc = PIPELINE_TPL.format(
            stream_type=self.zed_cfg.get("stream_type", 0),
            resolution=self.zed_cfg.get("camera_resolution", 3),
            fps=self.zed_cfg.get("camera_fps", 30),
            bitrate=self.zed_cfg.get("bitrate", 2_000_000),
            gop=self.zed_cfg.get("iframeinterval", 30),
        )
        log.info("GStreamer pipeline: %s", desc)
        self.pipeline = Gst.parse_launch(desc)
        self.webrtcbin = self.pipeline.get_by_name("webrtc")

        self.webrtcbin.connect("on-negotiation-needed", self._on_negotiation_needed)
        self.webrtcbin.connect("on-ice-candidate", self._on_ice_candidate)
        self.webrtcbin.connect("pad-added", self._on_pad_added)

    def _on_negotiation_needed(self, _webrtc):
        log.info("Negotiation needed -- creating offer")
        promise = Gst.Promise.new_with_change_func(self._on_offer_created)
        self.webrtcbin.emit("create-offer", None, promise)

    def _on_offer_created(self, promise):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value("offer")
        self.webrtcbin.emit("set-local-description", offer, None)
        sdp_text = offer.sdp.as_text()
        log.info("SDP offer created (%d bytes)", len(sdp_text))
        asyncio.run_coroutine_threadsafe(
            self._send_signaling({"kind": "offer", "sdp": sdp_text}),
            self._loop,
        )

    def _on_ice_candidate(self, _webrtc, mline_index, candidate):
        asyncio.run_coroutine_threadsafe(
            self._send_signaling({
                "kind": "ice",
                "candidate": candidate,
                "sdpMLineIndex": mline_index,
            }),
            self._loop,
        )

    def _on_pad_added(self, _webrtc, pad):
        log.debug("Pad added: %s", pad.get_name())

    def start_pipeline(self):
        self._build_pipeline()
        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            log.fatal("Failed to start GStreamer pipeline")
            sys.exit(1)
        log.info("Pipeline PLAYING")

    def stop_pipeline(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            log.info("Pipeline stopped")

    # -- signaling ----------------------------------------------------------

    async def _send_signaling(self, msg: dict):
        if self.ws and self.ws.open:
            msg["robot_id"] = self.robot_id
            await self.ws.send(json.dumps(msg))

    async def _handle_signaling(self):
        url = f"{self.host_url}/ws/signaling/{self.robot_id}"
        log.info("Connecting to signaling server: %s", url)
        async for ws in websockets.connect(url, ping_interval=10, ping_timeout=30):
            try:
                self.ws = ws
                log.info("Signaling connected")
                self.start_pipeline()
                async for raw in ws:
                    msg = json.loads(raw)
                    self._dispatch_signaling(msg)
            except websockets.ConnectionClosed:
                log.warning("Signaling connection lost -- reconnecting")
                self.stop_pipeline()
                continue

    def _dispatch_signaling(self, msg: dict):
        kind = msg.get("kind")
        if kind == "answer":
            log.info("Received SDP answer")
            _, sdpmsg = GstSdp.SDPMessage.new_from_text(msg["sdp"])
            answer = GstWebRTC.WebRTCSessionDescription.new(
                GstWebRTC.WebRTCSDPType.ANSWER, sdpmsg,
            )
            self.webrtcbin.emit("set-remote-description", answer, None)
        elif kind == "ice":
            self.webrtcbin.emit(
                "add-ice-candidate",
                msg["sdpMLineIndex"],
                msg["candidate"],
            )
        else:
            log.warning("Unknown signaling message kind: %s", kind)

    # -- lifecycle ----------------------------------------------------------

    async def run(self):
        await self._handle_signaling()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="ZED WebRTC streamer")
    p.add_argument("--robot-id", default="robot_0")
    p.add_argument("--host-url", default="ws://192.168.1.100:8800")
    p.add_argument("--config", default=None, help="fleet_streamer.yaml path")
    return p.parse_args()


def load_zed_config(config_path: str | None) -> dict:
    if config_path and Path(config_path).is_file():
        with open(config_path) as f:
            cfg = yaml.safe_load(f)
        return cfg.get("fleet_streamer", {}).get("zed", {})
    return {}


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="[%(levelname)s] %(name)s: %(message)s",
    )
    args = parse_args()
    Gst.init(None)

    zed_cfg = load_zed_config(args.config)
    streamer = ZedWebRTCStreamer(args.robot_id, args.host_url, zed_cfg)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    streamer._loop = loop

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: loop.stop())

    try:
        loop.run_until_complete(streamer.run())
    except KeyboardInterrupt:
        pass
    finally:
        streamer.stop_pipeline()
        loop.close()


if __name__ == "__main__":
    main()
