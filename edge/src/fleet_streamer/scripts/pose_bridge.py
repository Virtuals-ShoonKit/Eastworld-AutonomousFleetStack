#!/usr/bin/env python3
"""
ROS 2 TF -> WebSocket pose bridge.

Listens for the odom->base_link transform from FAST-LIVO2 and streams
compact msgpack-encoded pose messages to the host fleet server at ~50 Hz.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path

import msgpack
import rclpy
import websockets
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from tf2_ros import Buffer, TransformListener

_shared_dir = None
for _p in Path(__file__).resolve().parents:
    _candidate = _p / "shared" / "protocol.py"
    if _candidate.exists():
        _shared_dir = _candidate.parent
        break
if _shared_dir is None:
    _shared_dir = Path(__file__).resolve().parents[4] / "shared"
sys.path.insert(0, str(_shared_dir))
from protocol import PoseMsg  # noqa: E402


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


class PoseBridge(Node):
    def __init__(self):
        super().__init__("pose_bridge")

        self.declare_parameter("robot_id", "robot_0")
        self.declare_parameter("host_url", "ws://192.168.1.100:8800")
        self.declare_parameter("source_frame", "base_link")
        self.declare_parameter("target_frame", "odom")
        self.declare_parameter("rate_hz", 50.0)

        self.robot_id = self.get_parameter("robot_id").value
        self.host_url = self.get_parameter("host_url").value
        self.source_frame = self.get_parameter("source_frame").value
        self.target_frame = self.get_parameter("target_frame").value
        rate_hz = self.get_parameter("rate_hz").value

        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        self._ws: websockets.WebSocketClientProtocol | None = None
        self._ws_lock = threading.Lock()

        self._timer = self.create_timer(1.0 / rate_hz, self._on_timer)
        self.get_logger().info(
            f"PoseBridge: {self.target_frame}->{self.source_frame} @ {rate_hz}Hz "
            f"-> {self.host_url}"
        )

    def _on_timer(self):
        try:
            t = self.tf_buffer.lookup_transform(
                self.target_frame, self.source_frame, rclpy.time.Time(),
            )
        except Exception:
            return

        tr = t.transform.translation
        ro = t.transform.rotation
        msg = PoseMsg(
            robot_id=self.robot_id,
            ts=time.time(),
            position=(tr.x, tr.y, tr.z),
            quaternion=(ro.x, ro.y, ro.z, ro.w),
        )
        packed = msg.pack()

        with self._ws_lock:
            ws = self._ws
        if _ws_is_open(ws):
            asyncio.run_coroutine_threadsafe(ws.send(packed), self._async_loop)

    def set_ws(self, ws, loop):
        with self._ws_lock:
            self._ws = ws
            self._async_loop = loop


async def ws_connect_loop(node: PoseBridge):
    """Maintain a persistent WebSocket connection to the host."""
    url = f"{node.host_url}/ws/robot/{node.robot_id}"
    loop = asyncio.get_event_loop()
    async for ws in websockets.connect(url, ping_interval=10, ping_timeout=30):
        try:
            node.set_ws(ws, loop)
            node.get_logger().info(f"Connected to {url}")
            reg = msgpack.packb({"type": "register", "robot_id": node.robot_id})
            await ws.send(reg)
            async for _ in ws:
                pass  # keep connection alive; host may send heartbeats
        except websockets.ConnectionClosed:
            node.get_logger().warn("WebSocket disconnected -- reconnecting")
            node.set_ws(None, loop)


def main(args=None):
    rclpy.init(args=args)
    node = PoseBridge()

    loop = asyncio.new_event_loop()
    ws_thread = threading.Thread(
        target=lambda: loop.run_until_complete(ws_connect_loop(node)),
        daemon=True,
    )
    ws_thread.start()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            if rclpy.ok():
                rclpy.shutdown()
        except Exception:
            pass
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:
            pass


if __name__ == "__main__":
    main()
