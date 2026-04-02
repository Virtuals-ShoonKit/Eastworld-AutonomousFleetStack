"""
Broadcasts robot data (pose, cloud) from edge robots to connected web viewers.
"""

from __future__ import annotations

import logging
import struct
from typing import TYPE_CHECKING

from aiohttp import web

if TYPE_CHECKING:
    from aiohttp.web import WebSocketResponse

log = logging.getLogger("web_relay")


class WebRelay:
    """Fan-out relay: receives binary frames from robots, broadcasts to viewers."""

    def __init__(self):
        self._viewers: set[WebSocketResponse] = set()

    def add_viewer(self, ws: WebSocketResponse):
        self._viewers.add(ws)
        log.info("Viewer connected (total: %d)", len(self._viewers))

    def remove_viewer(self, ws: WebSocketResponse):
        self._viewers.discard(ws)
        log.info("Viewer disconnected (total: %d)", len(self._viewers))

    async def broadcast(self, data: bytes):
        """Send a binary frame to all connected viewers."""
        dead = []
        for ws in self._viewers:
            try:
                if not ws.closed:
                    await ws.send_bytes(data)
                else:
                    dead.append(ws)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._viewers.discard(ws)


async def handle_viewer_ws(request: web.Request) -> web.WebSocketResponse:
    """
    WebSocket handler for web viewers at /ws/viewer.

    Receives binary pose/cloud frames from the relay and forwards to the viewer.
    """
    relay: WebRelay = request.app["web_relay"]
    robot_sessions = request.app["robot_sessions"]

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    relay.add_viewer(ws)

    # Send current fleet state on connect
    import msgpack
    fleet_state = {
        "type": "fleet_state",
        "robots": [s.to_dict() for s in robot_sessions.values()],
    }
    await ws.send_bytes(struct.pack("B", 0x30) + msgpack.packb(fleet_state))

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.ERROR:
                log.warning("Viewer WS error: %s", ws.exception())
    finally:
        relay.remove_viewer(ws)

    return ws
