#!/usr/bin/env python3
"""
ROS 2 PointCloud2 -> Draco-compressed WebSocket bridge.

Subscribes to /cloud_registered, throttles to ~5 Hz, compresses with
Draco (optionally + zstd), and sends to the host fleet server.
"""

from __future__ import annotations

import asyncio
import struct
import sys
import threading
import time

import DracoPy
import msgpack
import numpy as np
import rclpy
import websockets
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import PointCloud2
import sensor_msgs_py.point_cloud2 as pc2

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[4] / "shared"))
from protocol import CloudMsg  # noqa: E402

try:
    import zstandard as zstd
except ImportError:
    zstd = None


class CloudBridge(Node):
    def __init__(self):
        super().__init__("cloud_bridge")

        self.declare_parameter("robot_id", "robot_0")
        self.declare_parameter("host_url", "ws://192.168.1.100:8800")
        self.declare_parameter("input_topic", "/cloud_registered")
        self.declare_parameter("rate_hz", 5.0)
        self.declare_parameter("draco_quantization_bits", 11)
        self.declare_parameter("use_zstd", False)

        self.robot_id = self.get_parameter("robot_id").value
        self.host_url = self.get_parameter("host_url").value
        input_topic = self.get_parameter("input_topic").value
        self.min_period = 1.0 / self.get_parameter("rate_hz").value
        self.quant_bits = self.get_parameter("draco_quantization_bits").value
        self.use_zstd = self.get_parameter("use_zstd").value

        self._last_send = 0.0
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._ws_lock = threading.Lock()
        self._async_loop: asyncio.AbstractEventLoop | None = None

        if self.use_zstd and zstd is None:
            self.get_logger().warn("zstandard not installed -- falling back to raw Draco")
            self.use_zstd = False

        self._zstd_comp = zstd.ZstdCompressor(level=3) if self.use_zstd else None

        qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        self.create_subscription(PointCloud2, input_topic, self._on_cloud, qos)
        self.get_logger().info(
            f"CloudBridge: {input_topic} @ {1/self.min_period:.0f}Hz "
            f"(draco q={self.quant_bits}, zstd={self.use_zstd}) -> {self.host_url}"
        )

    def _on_cloud(self, msg: PointCloud2):
        now = time.monotonic()
        if now - self._last_send < self.min_period:
            return
        self._last_send = now

        points = np.array(
            [(p[0], p[1], p[2]) for p in pc2.read_points(msg, field_names=("x", "y", "z"), skip_nans=True)],
            dtype=np.float32,
        )
        if points.size == 0:
            return

        num_points = len(points)
        draco_bytes = DracoPy.encode(
            points,
            quantization_bits=self.quant_bits,
            compression_level=1,
        )

        if self._zstd_comp:
            draco_bytes = self._zstd_comp.compress(draco_bytes)

        cloud_msg = CloudMsg(
            robot_id=self.robot_id,
            ts=time.time(),
            num_points=num_points,
            draco_bytes=draco_bytes,
        )
        packed = cloud_msg.pack()

        with self._ws_lock:
            ws = self._ws
            loop = self._async_loop
        if ws and ws.open and loop:
            asyncio.run_coroutine_threadsafe(ws.send(packed), loop)

    def set_ws(self, ws, loop):
        with self._ws_lock:
            self._ws = ws
            self._async_loop = loop


async def ws_connect_loop(node: CloudBridge):
    """Maintain a persistent WebSocket to the host."""
    url = f"{node.host_url}/ws/robot/{node.robot_id}"
    loop = asyncio.get_event_loop()
    async for ws in websockets.connect(url, ping_interval=10, ping_timeout=30):
        try:
            node.set_ws(ws, loop)
            node.get_logger().info(f"Cloud bridge connected to {url}")
            async for _ in ws:
                pass
        except websockets.ConnectionClosed:
            node.get_logger().warn("Cloud WS disconnected -- reconnecting")
            node.set_ws(None, loop)


def main(args=None):
    rclpy.init(args=args)
    node = CloudBridge()

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
        node.destroy_node()
        rclpy.shutdown()
        loop.call_soon_threadsafe(loop.stop)


if __name__ == "__main__":
    main()
