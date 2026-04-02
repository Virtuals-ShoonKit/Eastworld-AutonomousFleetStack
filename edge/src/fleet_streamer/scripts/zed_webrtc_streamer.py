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
import re
import signal
import threading
from pathlib import Path

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstSdp", "1.0")
gi.require_version("GstWebRTC", "1.0")
from gi.repository import Gst, GstSdp, GstWebRTC, GLib  # noqa: E402

import websockets  # noqa: E402
import yaml  # noqa: E402

log = logging.getLogger("zed_webrtc")


_H264_FMTP = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"


def _inject_h264_fmtp(sdp: str) -> str:
    """Ensure the SDP offer includes a=fmtp for H264 payload 96.

    GStreamer's webrtcbin omits the fmtp line, which causes Chrome to
    default to packetization-mode=0.  The robot's rtph264pay sends
    mode 1 (aggregate-mode=zero-latency), so we must advertise it.
    Injecting here (before set-local-description) keeps the local
    description consistent with what the viewer sees.
    """
    if "a=fmtp:96" in sdp:
        return sdp
    return re.sub(
        r"(a=rtpmap:96 H264/90000\r\n)",
        rf"\1a=fmtp:96 {_H264_FMTP}\r\n",
        sdp,
    )


def _ws_is_open(ws) -> bool:
    if ws is None:
        return False
    if hasattr(ws, "open"):
        return bool(ws.open)
    if hasattr(ws, "closed"):
        return not bool(ws.closed)
    state = getattr(ws, "state", None)
    if state is not None:
        return str(state).lower().endswith("open")
    return True

# ---------------------------------------------------------------------------
# GStreamer pipeline
# ---------------------------------------------------------------------------

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
        self._offer_pending = False
        self._answer_received = False
        self._last_offer_sdp: str | None = None

    # -- pipeline -----------------------------------------------------------

    def _cfg_int(self, key: str, default: int, minimum: int | None = None) -> int:
        value = self.zed_cfg.get(key, default)
        try:
            value = int(value)
        except (TypeError, ValueError):
            value = default
        if minimum is not None:
            value = max(minimum, value)
        return value

    def _cfg_bool(self, key: str, default: bool) -> bool:
        value = self.zed_cfg.get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _build_pipeline(self):
        stream_type = self._cfg_int("stream_type", 0, minimum=0)
        resolution = self._cfg_int("camera_resolution", 3, minimum=0)
        fps = self._cfg_int("camera_fps", 30, minimum=1)
        bitrate = self._cfg_int("bitrate", 2_000_000, minimum=1)
        gop = self._cfg_int("iframeinterval", 30, minimum=1)
        idr = self._cfg_int("idrinterval", gop, minimum=1)
        queue_max_buffers = self._cfg_int("queue_max_buffers", 1, minimum=1)
        rtp_mtu = self._cfg_int("rtp_mtu", 1200, minimum=200)
        webrtc_latency_ms = self._cfg_int("webrtc_latency_ms", 30, minimum=0)
        rtp_config_interval = self._cfg_int("rtp_config_interval", -1, minimum=-1)
        drop_when_congested = self._cfg_bool("drop_when_congested", True)

        queue_leaky = "downstream" if drop_when_congested else "no"
        desc = (
            f"zedsrc stream-type={stream_type} camera-resolution={resolution} camera-fps={fps} "
            f"! queue leaky={queue_leaky} max-size-buffers={queue_max_buffers} max-size-bytes=0 max-size-time=0 "
            "! nvvideoconvert "
            "! video/x-raw(memory:NVMM),format=NV12 "
            f"! nvv4l2h264enc bitrate={bitrate} iframeinterval={gop} idrinterval={idr} "
            "insert-sps-pps=true insert-aud=true maxperf-enable=true preset-level=1 control-rate=1 num-B-Frames=0 "
            f"! rtph264pay config-interval={rtp_config_interval} aggregate-mode=zero-latency mtu={rtp_mtu} pt=96 "
            "! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000 "
            f"! webrtcbin name=webrtc bundle-policy=max-bundle async-handling=true latency={webrtc_latency_ms}"
        )
        log.info("GStreamer pipeline: %s", desc)
        self.pipeline = Gst.parse_launch(desc)
        self.webrtcbin = self.pipeline.get_by_name("webrtc")

        self.webrtcbin.connect("on-negotiation-needed", self._on_negotiation_needed)
        self.webrtcbin.connect("on-ice-candidate", self._on_ice_candidate)
        self.webrtcbin.connect("pad-added", self._on_pad_added)

        # #region agent log
        self._sink_buf_count = 0
        for pad in self.webrtcbin.sinkpads:
            pad.add_probe(Gst.PadProbeType.BUFFER, self._sink_probe_cb, None)
            log.info("Probe added on webrtcbin pad: %s (direction=%s)", pad.get_name(), pad.get_direction())
        if not self.webrtcbin.sinkpads:
            log.warning("webrtcbin has NO sink pads after parse_launch!")
        # #endregion

    def _request_offer(self, reason: str):
        if not self.webrtcbin:
            return
        if self._offer_pending:
            return
        if not _ws_is_open(self.ws):
            log.info("Skipping offer request (%s): signaling not connected", reason)
            return
        self._offer_pending = True
        log.info("Creating SDP offer (%s)", reason)
        promise = Gst.Promise.new_with_change_func(self._on_offer_created)
        self.webrtcbin.emit("create-offer", None, promise)

    def _on_negotiation_needed(self, _webrtc):
        self._request_offer("negotiation-needed")

    def _on_offer_created(self, promise):
        promise.wait()
        self._offer_pending = False
        reply = promise.get_reply()
        if reply is None:
            log.warning("Offer creation returned no reply")
            return
        offer = reply.get_value("offer")
        sdp_text = _inject_h264_fmtp(offer.sdp.as_text())

        _, patched_sdp = GstSdp.SDPMessage.new_from_text(sdp_text)
        patched_offer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.OFFER, patched_sdp,
        )
        self.webrtcbin.emit("set-local-description", patched_offer, None)
        self._last_offer_sdp = sdp_text

        log.info("SDP offer created (%d bytes, fmtp=%s)",
                 len(sdp_text), "a=fmtp:96" in sdp_text)
        asyncio.run_coroutine_threadsafe(
            self._send_signaling({"kind": "offer", "sdp": sdp_text}),
            self._loop,
        )

    def _on_ice_candidate(self, _webrtc, mline_index, candidate):
        log.info("Local ICE candidate generated (mline=%s)", mline_index)
        asyncio.run_coroutine_threadsafe(
            self._send_signaling({
                "kind": "ice",
                "candidate": candidate,
                "sdpMLineIndex": mline_index,
            }),
            self._loop,
        )

    # #region agent log
    def _sink_probe_cb(self, pad, info, data):
        self._sink_buf_count += 1
        if self._sink_buf_count <= 3 or self._sink_buf_count % 300 == 0:
            log.info("webrtcbin sink probe: buffer #%d", self._sink_buf_count)
        return Gst.PadProbeReturn.OK
    # #endregion

    # #region agent log
    def _on_bus_error(self, _bus, msg):
        err, dbg = msg.parse_error()
        log.error("BUS ERROR from %s: %s (%s)", msg.src.get_name() if msg.src else "?", err, dbg)

    def _on_bus_warning(self, _bus, msg):
        warn, dbg = msg.parse_warning()
        log.warning("BUS WARNING from %s: %s (%s)", msg.src.get_name() if msg.src else "?", warn, dbg)

    def _on_bus_eos(self, _bus, _msg):
        log.warning("BUS EOS received!")
    # #endregion

    def _on_pad_added(self, _webrtc, pad):
        log.debug("Pad added: %s", pad.get_name())

    def start_pipeline(self):
        self._build_pipeline()
        self._offer_pending = False
        self._answer_received = False
        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            bus = self.pipeline.get_bus()
            msg = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.WARNING) if bus else None
            camera_start_failed = False
            camera_error_text = ""
            if msg:
                if msg.type == Gst.MessageType.ERROR:
                    err, dbg = msg.parse_error()
                    camera_error_text = str(err)
                    if "CAMERA STREAM FAILED TO START" in camera_error_text:
                        camera_start_failed = True
                    log.error(
                        "Pipeline bus error from %s: %s (%s)",
                        msg.src.get_name() if msg.src else "unknown",
                        err,
                        dbg,
                    )
                elif msg.type == Gst.MessageType.WARNING:
                    warn, dbg = msg.parse_warning()
                    log.warning(
                        "Pipeline bus warning from %s: %s (%s)",
                        msg.src.get_name() if msg.src else "unknown",
                        warn,
                        dbg,
                    )
            if camera_start_failed:
                raise RuntimeError(f"Camera start failure: {camera_error_text}")
            raise RuntimeError("Failed to start GStreamer pipeline")
        log.info("Pipeline PLAYING")
        # #region agent log
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error)
        bus.connect("message::warning", self._on_bus_warning)
        bus.connect("message::eos", self._on_bus_eos)
        # #endregion
        self._request_offer("pipeline-start")

    def stop_pipeline(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            log.info("Pipeline stopped")
        self.webrtcbin = None
        self.pipeline = None

    # -- signaling ----------------------------------------------------------

    async def _send_signaling(self, msg: dict):
        if _ws_is_open(self.ws):
            msg["robot_id"] = self.robot_id
            await self.ws.send(json.dumps(msg))

    async def _handle_signaling(self):
        url = f"{self.host_url}/ws/signaling/{self.robot_id}"
        log.info("Connecting to signaling server: %s", url)
        async for ws in websockets.connect(url, ping_interval=10, ping_timeout=30):
            offer_retry_task: asyncio.Task | None = None
            # #region agent log
            monitor_task: asyncio.Task | None = None
            # #endregion
            try:
                self.ws = ws
                log.info("Signaling connected")
                self.start_pipeline()
                offer_retry_task = asyncio.create_task(self._retry_offer_until_answer())
                # #region agent log
                monitor_task = asyncio.create_task(self._monitor_webrtc_state())
                # #endregion
                async for raw in ws:
                    msg = json.loads(raw)
                    self._dispatch_signaling(msg)
            except websockets.ConnectionClosed:
                log.warning("Signaling connection lost -- reconnecting")
            except Exception as exc:
                if "Camera start failure:" in str(exc):
                    raise
                log.exception("WebRTC stream loop failed -- reconnecting")
            finally:
                if offer_retry_task:
                    offer_retry_task.cancel()
                # #region agent log
                if monitor_task:
                    monitor_task.cancel()
                # #endregion
                self.stop_pipeline()
                self.ws = None

    def _dispatch_signaling(self, msg: dict):
        kind = msg.get("kind")
        if kind == "answer":
            self._answer_received = True
            sdp_text = msg["sdp"]
            # #region agent log
            has_fmtp = "a=fmtp:96" in sdp_text
            has_h264 = "H264" in sdp_text
            has_video = "m=video" in sdp_text
            local_desc = self.webrtcbin.get_property("local-description")
            local_has_fmtp = "a=fmtp:96" in local_desc.sdp.as_text() if local_desc else False
            log.info("Received SDP answer: size=%d has_video=%s has_h264=%s has_fmtp=%s local_has_fmtp=%s",
                     len(sdp_text), has_video, has_h264, has_fmtp, local_has_fmtp)
            # #endregion
            _, sdpmsg = GstSdp.SDPMessage.new_from_text(sdp_text)
            answer = GstWebRTC.WebRTCSessionDescription.new(
                GstWebRTC.WebRTCSDPType.ANSWER, sdpmsg,
            )
            self.webrtcbin.emit("set-remote-description", answer, None)
            log.info("Remote description set successfully")
        elif kind == "ice":
            log.info("Remote ICE candidate received (mline=%s)", msg.get("sdpMLineIndex"))
            self.webrtcbin.emit(
                "add-ice-candidate",
                msg["sdpMLineIndex"],
                msg["candidate"],
            )
        else:
            log.warning("Unknown signaling message kind: %s", kind)

    async def _retry_offer_until_answer(self):
        while _ws_is_open(self.ws) and not self._answer_received:
            await asyncio.sleep(2.0)
            if self._answer_received or not _ws_is_open(self.ws):
                break
            if self._last_offer_sdp:
                log.info("Resending SDP offer (retry-no-answer)")
                await self._send_signaling({"kind": "offer", "sdp": self._last_offer_sdp})
            else:
                self._request_offer("retry-no-answer")

    # #region agent log
    async def _monitor_webrtc_state(self):
        """Periodically log webrtcbin and pipeline state for diagnostics."""
        await asyncio.sleep(1.0)
        for _ in range(20):
            if not self.webrtcbin or not self.pipeline:
                break
            try:
                ice = self.webrtcbin.get_property("ice-connection-state")
                conn = self.webrtcbin.get_property("connection-state")
                _, state, pending = self.pipeline.get_state(0)
                log.info("Monitor: ice=%s conn=%s pipeline=%s pending=%s answer=%s bufs=%d",
                         ice, conn, state, pending, self._answer_received,
                         getattr(self, '_sink_buf_count', 0))
            except Exception as e:
                log.warning("Monitor error: %s", e)
            await asyncio.sleep(3.0)
    # #endregion

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
        zed_cfg = cfg.get("fleet_streamer", {}).get("zed", {})
        return zed_cfg
    return {}


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="[%(levelname)s] %(name)s: %(message)s",
    )
    args = parse_args()
    Gst.init(None)

    glib_loop = GLib.MainLoop()
    glib_thread = threading.Thread(target=glib_loop.run, daemon=True, name="glib-mainloop")
    glib_thread.start()
    log.info("GLib main loop thread started")

    has_zedsrc = Gst.ElementFactory.find("zedsrc") is not None
    has_webrtcbin = Gst.ElementFactory.find("webrtcbin") is not None
    has_nice_plugin = Gst.Registry.get().find_plugin("nice") is not None
    if not has_zedsrc:
        log.error("Missing GStreamer plugin 'zedsrc'. Install/source ZED GStreamer plugins.")
        return
    if not has_webrtcbin:
        log.error("Missing GStreamer plugin 'webrtcbin'. Install gst-plugins-bad.")
        return
    if not has_nice_plugin:
        log.error("Missing GStreamer plugin 'nice' (libgstnice). Install gstreamer1.0-nice.")
        return

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
