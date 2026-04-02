"""
WebRTC signaling relay.

Forwards SDP offers/answers and ICE candidates between edge robots
(GStreamer webrtcbin) and web viewer browsers (RTCPeerConnection).
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from typing import TYPE_CHECKING

from aiohttp import web

if TYPE_CHECKING:
    from aiohttp.web import WebSocketResponse

log = logging.getLogger("signaling")


class SignalingRelay:
    """Manages paired WebSocket connections for per-robot signaling."""

    def __init__(self):
        # robot_id -> {"robot": ws, "viewer": ws}
        self._peers: dict[str, dict[str, WebSocketResponse]] = defaultdict(dict)

    def register(self, robot_id: str, role: str, ws: WebSocketResponse):
        self._peers[robot_id][role] = ws
        log.info("Signaling: %s registered as %s", robot_id, role)

    def unregister(self, robot_id: str, role: str):
        peers = self._peers.get(robot_id)
        if peers:
            peers.pop(role, None)
            if not peers:
                del self._peers[robot_id]
        log.info("Signaling: %s unregistered %s", robot_id, role)

    async def relay(self, robot_id: str, from_role: str, message: str):
        """Forward a signaling message to the other peer."""
        to_role = "viewer" if from_role == "robot" else "robot"
        peers = self._peers.get(robot_id, {})
        target = peers.get(to_role)
        if target and not target.closed:
            await target.send_str(message)
        else:
            log.debug("No %s peer for %s, dropping signaling message", to_role, robot_id)


async def handle_signaling_ws(request: web.Request) -> web.WebSocketResponse:
    """
    WebSocket handler for signaling at /ws/signaling/{robot_id}.

    Query param ?role=robot|viewer selects which side this connection represents.
    """
    robot_id = request.match_info["robot_id"]
    role = request.query.get("role", "robot")
    relay: SignalingRelay = request.app["signaling_relay"]

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    relay.register(robot_id, role, ws)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                await relay.relay(robot_id, role, msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                log.warning("Signaling WS error for %s/%s: %s", robot_id, role, ws.exception())
    finally:
        relay.unregister(robot_id, role)

    return ws
