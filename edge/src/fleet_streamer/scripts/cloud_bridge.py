#!/usr/bin/env python3
"""
ROS 2 PointCloud2 -> Draco-compressed WebSocket bridge.

Subscribes to /cloud_registered, throttles to ~5 Hz, compresses with
Draco (optionally + zstd), and sends to the host fleet server.

After relocalization the cloud is transformed from the LIVO odometry
frame (``cloud_frame``, default ``odom``) into the global map frame
(``map_frame``, default ``map``) using the TF published by the
pcd_relocalizer, so the viewer sees the live scan aligned with the
static map and robot pose.
"""

from __future__ import annotations

import asyncio
import struct
import sys
import threading
import time
from pathlib import Path

import DracoPy
import msgpack
import numpy as np
import rclpy
import tf2_ros
import websockets
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy, DurabilityPolicy
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import Bool
import sensor_msgs_py.point_cloud2 as pc2

_shared_dir = None
for _p in Path(__file__).resolve().parents:
    _candidate = _p / "shared" / "protocol.py"
    if _candidate.exists():
        _shared_dir = _candidate.parent
        break
if _shared_dir is None:
    _shared_dir = Path(__file__).resolve().parents[4] / "shared"
sys.path.insert(0, str(_shared_dir))
from protocol import CloudMsg  # noqa: E402

try:
    import zstandard as zstd
except ImportError:
    zstd = None


def _quat_to_rotation_matrix(x: float, y: float, z: float, w: float) -> np.ndarray:
    """Quaternion (x, y, z, w) -> 3x3 rotation matrix (float32)."""
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float32)


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


class CloudBridge(Node):
    def __init__(self):
        super().__init__("cloud_bridge")

        self.declare_parameter("robot_id", "robot_0")
        self.declare_parameter("host_url", "ws://192.168.1.100:8800")
        self.declare_parameter("input_topic", "/cloud_registered")
        self.declare_parameter("rate_hz", 5.0)
        self.declare_parameter("draco_quantization_bits", 11)
        self.declare_parameter("use_zstd", False)
        self.declare_parameter("cloud_frame", "odom")
        self.declare_parameter("map_frame", "map")

        self.robot_id = self.get_parameter("robot_id").value
        self.host_url = self.get_parameter("host_url").value
        input_topic = self.get_parameter("input_topic").value
        self.min_period = 1.0 / self.get_parameter("rate_hz").value
        self.quant_bits = self.get_parameter("draco_quantization_bits").value
        self.use_zstd = self.get_parameter("use_zstd").value
        self._cloud_frame = self.get_parameter("cloud_frame").value
        self._map_frame = self.get_parameter("map_frame").value

        self._last_send = 0.0
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._ws_lock = threading.Lock()
        self._async_loop: asyncio.AbstractEventLoop | None = None

        if self.use_zstd and zstd is None:
            self.get_logger().warn("zstandard not installed -- falling back to raw Draco")
            self.use_zstd = False

        self._zstd_comp = zstd.ZstdCompressor(level=3) if self.use_zstd else None

        # TF2 for transforming cloud from LIVO odometry frame to global map
        self._tf_buffer = tf2_ros.Buffer()
        self._tf_listener = tf2_ros.TransformListener(self._tf_buffer, self)
        self._cached_R = np.eye(3, dtype=np.float32)
        self._cached_t = np.zeros(3, dtype=np.float32)

        self._relocalized = False
        reloc_qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        self.create_subscription(Bool, "/relocalization_status", self._on_reloc_status, reloc_qos)

        cloud_qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=10,
        )
        self.create_subscription(PointCloud2, input_topic, self._on_cloud, cloud_qos)
        self.get_logger().info(
            f"CloudBridge: {input_topic} @ {1/self.min_period:.0f}Hz "
            f"(draco q={self.quant_bits}, zstd={self.use_zstd}, "
            f"tf {self._cloud_frame}->{self._map_frame}) -> {self.host_url}"
        )

    def _update_odom_to_map(self):
        """Cache the latest odom->map transform from the TF tree."""
        try:
            ts = self._tf_buffer.lookup_transform(
                self._map_frame, self._cloud_frame, rclpy.time.Time()
            )
            q = ts.transform.rotation
            t = ts.transform.translation
            self._cached_R = _quat_to_rotation_matrix(q.x, q.y, q.z, q.w)
            self._cached_t = np.array([t.x, t.y, t.z], dtype=np.float32)
        except (tf2_ros.LookupException, tf2_ros.ConnectivityException,
                tf2_ros.ExtrapolationException):
            pass

    def _on_reloc_status(self, msg: Bool):
        if msg.data and not self._relocalized:
            self.get_logger().info("Relocalization complete — enabling Draco compression")
            self._update_odom_to_map()
        self._relocalized = msg.data

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

        if self._relocalized:
            self._update_odom_to_map()
            points = (points @ self._cached_R.T) + self._cached_t

            draco_bytes = DracoPy.encode(
                points,
                quantization_bits=self.quant_bits,
                compression_level=1,
            )
            if self._zstd_comp:
                draco_bytes = self._zstd_comp.compress(draco_bytes)
        else:
            draco_bytes = points.tobytes()

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
        if _ws_is_open(ws) and loop:
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
