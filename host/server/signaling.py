"""
WebRTC signaling relay.

Forwards SDP offers/answers and ICE candidates between edge robots
(GStreamer webrtcbin) and web viewer browsers (RTCPeerConnection).

The relay buffers the robot's ICE candidates so that a viewer connecting
after the robot still receives them immediately.  When a new viewer joins,
the relay also notifies the robot so it can send a fresh SDP offer.
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
        self._peers: dict[str, dict[str, WebSocketResponse]] = defaultdict(dict)
        self._ice_buffer: dict[str, list[str]] = defaultdict(list)

    def register(self, robot_id: str, role: str, ws: WebSocketResponse):
        self._peers[robot_id][role] = ws
        log.info("Signaling: %s registered as %s", robot_id, role)

    def unregister(self, robot_id: str, role: str, ws: WebSocketResponse):
        peers = self._peers.get(robot_id)
        if peers:
            if peers.get(role) is ws:
                peers.pop(role, None)
            if not peers:
                del self._peers[robot_id]
        if role == "robot":
            self._ice_buffer.pop(robot_id, None)
        log.info("Signaling: %s unregistered %s", robot_id, role)

    async def notify_robot_viewer_joined(self, robot_id: str):
        """Tell the robot a (new) viewer just connected so it can re-offer."""
        peers = self._peers.get(robot_id, {})
        robot_ws = peers.get("robot")
        if robot_ws and not robot_ws.closed:
            self._ice_buffer.pop(robot_id, None)
            msg = json.dumps({"kind": "viewer-joined"})
            await robot_ws.send_str(msg)
            log.info("Sent viewer-joined notification to robot for %s", robot_id)

    async def replay_ice_buffer(self, robot_id: str, viewer_ws: WebSocketResponse):
        """Send buffered robot ICE candidates to a newly connected viewer."""
        buf = self._ice_buffer.get(robot_id)
        if not buf:
            return
        log.info("Replaying %d buffered ICE candidates to viewer for %s", len(buf), robot_id)
        for ice_msg in buf:
            await viewer_ws.send_str(ice_msg)

    async def relay(self, robot_id: str, from_role: str, message: str):
        """Forward a signaling message to the other peer."""
        to_role = "viewer" if from_role == "robot" else "robot"
        peers = self._peers.get(robot_id, {})
        target = peers.get(to_role)

        if from_role == "robot":
            parsed = json.loads(message)
            kind = parsed.get("kind")
            if kind == "ice":
                self._ice_buffer[robot_id].append(message)
            elif kind == "offer":
                self._ice_buffer.pop(robot_id, None)

        if target and not target.closed:
            await target.send_str(message)
        else:
            log.debug("No %s peer for %s, message dropped", to_role, robot_id)


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
    if role == "viewer":
        await relay.notify_robot_viewer_joined(robot_id)
        await relay.replay_ice_buffer(robot_id, ws)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                await relay.relay(robot_id, role, msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                log.warning("Signaling WS error for %s/%s: %s", robot_id, role, ws.exception())
    finally:
        relay.unregister(robot_id, role, ws)

    return ws
