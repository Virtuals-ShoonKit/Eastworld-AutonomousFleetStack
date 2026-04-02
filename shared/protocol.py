"""
Fleet Management Protocol -- shared message schemas.

All messages are serialized with msgpack. Binary WebSocket frames carry
a 1-byte type tag followed by the msgpack payload.

Used identically on edge (Python 3.10 / Jetson) and host (Python 3.10+).
The TypeScript counterpart lives in host/web/src/lib/protocol.ts.
"""

from __future__ import annotations

import struct
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional

import msgpack

# ---------------------------------------------------------------------------
# Message type tags (first byte of every binary WS frame)
# ---------------------------------------------------------------------------

class MsgType(IntEnum):
    REGISTER = 0x01
    HEARTBEAT = 0x02
    POSE = 0x10
    CLOUD = 0x11
    SIGNALING = 0x20
    FLEET_STATE = 0x30


# ---------------------------------------------------------------------------
# Edge -> Host messages
# ---------------------------------------------------------------------------

@dataclass
class RegisterMsg:
    """Sent once when a robot connects to the host."""
    robot_id: str
    hardware: str = "orin_nx"

    def pack(self) -> bytes:
        payload = msgpack.packb({
            "robot_id": self.robot_id,
            "hardware": self.hardware,
        })
        return struct.pack("B", MsgType.REGISTER) + payload

    @classmethod
    def unpack(cls, data: bytes) -> "RegisterMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(**d)


@dataclass
class HeartbeatMsg:
    """Periodic keep-alive (edge -> host, host -> edge)."""
    robot_id: str
    ts: float = field(default_factory=time.time)

    def pack(self) -> bytes:
        payload = msgpack.packb({
            "robot_id": self.robot_id,
            "ts": self.ts,
        })
        return struct.pack("B", MsgType.HEARTBEAT) + payload

    @classmethod
    def unpack(cls, data: bytes) -> "HeartbeatMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(**d)


@dataclass
class PoseMsg:
    """Robot pose update (50 Hz, ~60 bytes on the wire)."""
    robot_id: str
    ts: float
    position: tuple[float, float, float]        # x, y, z
    quaternion: tuple[float, float, float, float] # x, y, z, w

    def pack(self) -> bytes:
        payload = msgpack.packb({
            "r": self.robot_id,
            "t": self.ts,
            "p": self.position,
            "q": self.quaternion,
        })
        return struct.pack("B", MsgType.POSE) + payload

    @classmethod
    def unpack(cls, data: bytes) -> "PoseMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(
            robot_id=d["r"],
            ts=d["t"],
            position=tuple(d["p"]),
            quaternion=tuple(d["q"]),
        )


@dataclass
class CloudMsg:
    """Draco-compressed point cloud chunk."""
    robot_id: str
    ts: float
    num_points: int
    draco_bytes: bytes

    def pack(self) -> bytes:
        payload = msgpack.packb({
            "r": self.robot_id,
            "t": self.ts,
            "n": self.num_points,
            "d": self.draco_bytes,
        })
        return struct.pack("B", MsgType.CLOUD) + payload

    @classmethod
    def unpack(cls, data: bytes) -> "CloudMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(
            robot_id=d["r"],
            ts=d["t"],
            num_points=d["n"],
            draco_bytes=d["d"],
        )


# ---------------------------------------------------------------------------
# WebRTC signaling (relayed through host)
# ---------------------------------------------------------------------------

@dataclass
class SignalingMsg:
    """SDP offer/answer or ICE candidate, relayed via host signaling server."""
    robot_id: str
    target: str  # "robot" | "viewer"
    kind: str    # "offer" | "answer" | "ice"
    payload: dict

    def pack(self) -> bytes:
        body = msgpack.packb({
            "robot_id": self.robot_id,
            "target": self.target,
            "kind": self.kind,
            "payload": self.payload,
        })
        return struct.pack("B", MsgType.SIGNALING) + body

    @classmethod
    def unpack(cls, data: bytes) -> "SignalingMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(**d)


# ---------------------------------------------------------------------------
# Host -> Viewer messages
# ---------------------------------------------------------------------------

@dataclass
class FleetStateMsg:
    """Broadcast to web viewers: list of connected robots and status."""
    robots: list[dict]  # [{robot_id, connected, last_heartbeat}, ...]

    def pack(self) -> bytes:
        payload = msgpack.packb({"robots": self.robots})
        return struct.pack("B", MsgType.FLEET_STATE) + payload

    @classmethod
    def unpack(cls, data: bytes) -> "FleetStateMsg":
        d = msgpack.unpackb(data[1:], raw=False)
        return cls(**d)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def msg_type(data: bytes) -> MsgType:
    """Extract the message type tag from a binary frame."""
    return MsgType(data[0])


_UNPACKERS = {
    MsgType.REGISTER: RegisterMsg.unpack,
    MsgType.HEARTBEAT: HeartbeatMsg.unpack,
    MsgType.POSE: PoseMsg.unpack,
    MsgType.CLOUD: CloudMsg.unpack,
    MsgType.SIGNALING: SignalingMsg.unpack,
    MsgType.FLEET_STATE: FleetStateMsg.unpack,
}


def unpack(data: bytes):
    """Unpack any protocol message from a binary WebSocket frame."""
    tag = msg_type(data)
    return _UNPACKERS[tag](data)
