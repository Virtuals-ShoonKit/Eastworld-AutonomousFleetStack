"""
WebRTC signaling relay.

Forwards SDP offers/answers and ICE candidates between edge robots
(GStreamer webrtcbin) and web viewer browsers (RTCPeerConnection).

The relay buffers the robot's ICE candidates so that a viewer connecting
after the robot still receives them immediately.
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
        # robot_id -> [ice_message_str, ...]
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

    async def replay_ice_buffer(self, robot_id: str, viewer_ws: WebSocketResponse):
        """Send buffered robot ICE candidates to a newly connected viewer.

        The viewer queues these until it receives a live offer from the robot
        (the retry loop sends one every ~2 s).  This ensures the viewer has
        the robot's ICE candidates that were generated before it connected.
        """
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

        # #region agent log
        import time as _t
        _parsed = json.loads(message)
        _is_sdp = _parsed.get("kind") in ("offer", "answer")
        _debug_data = {"sessionId":"3d3ed7","location":"signaling.py:relay","message":"relay","data":{"robot_id":robot_id,"from":from_role,"to":to_role,"hasTarget":target is not None and not getattr(target,'closed',True),"kind":_parsed.get("kind"),"fullSdp":_parsed.get("sdp","") if _is_sdp else None},"timestamp":int(_t.time()*1000)}
        try:
            open("/home/robo/EW/EW_UGV_SK/.cursor/debug-3d3ed7.log","a").write(json.dumps(_debug_data)+"\n")
        except Exception:
            pass
        # #endregion

        if target and not target.closed:
            await target.send_str(message)
        else:
            log.debug("No %s peer for %s, buffered for later", to_role, robot_id)


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
