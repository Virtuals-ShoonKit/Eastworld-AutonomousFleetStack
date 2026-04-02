#!/usr/bin/env python3
"""
Fleet management server.

Endpoints:
  ws://host:8800/ws/robot/{robot_id}       -- robot data (pose + cloud)
  ws://host:8800/ws/signaling/{robot_id}    -- WebRTC signaling relay
  ws://host:8800/ws/viewer                  -- web viewer data feed
  GET /maps/{name}                          -- Draco-compressed map files
  GET /                                     -- serves web viewer (static)
"""

from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import msgpack
import yaml
from aiohttp import web

from robot_session import RobotSession
from signaling import SignalingRelay, handle_signaling_ws
from web_relay import WebRelay, handle_viewer_ws

log = logging.getLogger("fleet_server")


async def handle_robot_ws(request: web.Request) -> web.WebSocketResponse:
    """
    WebSocket handler for robot data at /ws/robot/{robot_id}.

    Receives binary msgpack frames (pose, cloud, heartbeat) from edge robots
    and relays them to all connected web viewers.
    """
    robot_id = request.match_info["robot_id"]
    sessions: dict[str, RobotSession] = request.app["robot_sessions"]
    relay: WebRelay = request.app["web_relay"]

    ws = web.WebSocketResponse(max_msg_size=10 * 1024 * 1024)  # 10 MB for clouds
    await ws.prepare(request)

    session = sessions.get(robot_id)
    if session is None:
        session = RobotSession(robot_id=robot_id)
        sessions[robot_id] = session
    session.connected = True
    session.touch()

    log.info("Robot connected: %s", robot_id)

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                data = msg.data
                session.touch()

                tag = data[0]
                if tag == 0x10:  # POSE
                    session.last_pose_bytes = data
                await relay.broadcast(data)

            elif msg.type == web.WSMsgType.TEXT:
                try:
                    parsed = msgpack.unpackb(msg.data if isinstance(msg.data, bytes) else msg.data.encode())
                    if parsed.get("type") == "register":
                        session.hardware = parsed.get("hardware", "orin_nx")
                        log.info("Robot %s registered (hw=%s)", robot_id, session.hardware)
                except Exception:
                    pass

            elif msg.type == web.WSMsgType.ERROR:
                log.warning("Robot WS error %s: %s", robot_id, ws.exception())
    finally:
        session.connected = False
        log.info("Robot disconnected: %s", robot_id)

    return ws


def build_app(config: dict) -> web.Application:
    app = web.Application()

    app["robot_sessions"] = {}
    app["signaling_relay"] = SignalingRelay()
    app["web_relay"] = WebRelay()

    app.router.add_get("/ws/robot/{robot_id}", handle_robot_ws)
    app.router.add_get("/ws/signaling/{robot_id}", handle_signaling_ws)
    app.router.add_get("/ws/viewer", handle_viewer_ws)

    server_dir = Path(__file__).parent
    web_dist = server_dir.parent / "web" / "dist"

    # Maps can come from the built web dist or a configured directory
    maps_dir_cfg = config.get("maps", {}).get("directory", "")
    maps_dir = Path(maps_dir_cfg) if maps_dir_cfg else None
    if maps_dir and not maps_dir.is_absolute():
        maps_dir = server_dir / maps_dir

    # Prefer maps from dist (copied from public/ during vite build)
    dist_maps = web_dist / "maps"
    if dist_maps.is_dir():
        app.router.add_static("/maps", dist_maps, show_index=False)
        log.info("Serving maps from %s", dist_maps)
    elif maps_dir and maps_dir.is_dir():
        app.router.add_static("/maps", maps_dir, show_index=False)
        log.info("Serving maps from %s", maps_dir)

    if web_dist.is_dir():
        app.router.add_static("/", web_dist, show_index=True)
        log.info("Serving web viewer from %s", web_dist)

    return app


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="Fleet management server")
    parser.add_argument("--config", default=str(Path(__file__).parent / "config.yaml"))
    args = parser.parse_args()

    config_path = Path(args.config)
    if config_path.is_file():
        with open(config_path) as f:
            config = yaml.safe_load(f)
    else:
        config = {}

    srv = config.get("server", {})
    app = build_app(config)
    host = srv.get("host", "0.0.0.0")
    port = srv.get("port", 8800)

    log.info("Starting fleet server on %s:%d", host, port)
    web.run_app(app, host=host, port=port)


if __name__ == "__main__":
    main()
