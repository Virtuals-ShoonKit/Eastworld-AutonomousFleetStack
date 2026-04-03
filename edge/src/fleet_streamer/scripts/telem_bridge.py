#!/usr/bin/env python3
"""
ROS 2 ScoutStatus -> WebSocket telemetry bridge.

Subscribes to /scout_status, extracts battery voltage, maps it to a
percentage (7S Li-ion: ~22 V empty, ~29.4 V full), and streams compact
TELEMETRY messages to the host fleet server at ~1 Hz.
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

_shared_dir = None
for _p in Path(__file__).resolve().parents:
    _candidate = _p / "shared" / "protocol.py"
    if _candidate.exists():
        _shared_dir = _candidate.parent
        break
if _shared_dir is None:
    _shared_dir = Path(__file__).resolve().parents[4] / "shared"
sys.path.insert(0, str(_shared_dir))
from protocol import TelemetryMsg  # noqa: E402

# Scout Mini 7S Li-ion pack voltage range
_BATT_V_MIN = 22.0
_BATT_V_MAX = 29.4


def _voltage_to_pct(voltage: float) -> int:
    """Linear interpolation clamped to 0-100."""
    pct = (voltage - _BATT_V_MIN) / (_BATT_V_MAX - _BATT_V_MIN) * 100.0
    return max(0, min(100, int(round(pct))))


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


class TelemBridge(Node):
    def __init__(self):
        super().__init__("telem_bridge")

        self.declare_parameter("robot_id", "robot_0")
        self.declare_parameter("host_url", "ws://192.168.1.100:8800")
        self.declare_parameter("input_topic", "/scout_status")
        self.declare_parameter("rate_hz", 1.0)

        self.robot_id = self.get_parameter("robot_id").value
        self.host_url = self.get_parameter("host_url").value
        input_topic = self.get_parameter("input_topic").value
        self.min_period = 1.0 / self.get_parameter("rate_hz").value

        self._last_send = 0.0
        self._ws = None
        self._ws_lock = threading.Lock()
        self._async_loop: asyncio.AbstractEventLoop | None = None

        try:
            from scout_msgs.msg import ScoutStatus
            self._msg_type = ScoutStatus
        except ImportError:
            self.get_logger().error(
                "scout_msgs not found -- cannot subscribe to ScoutStatus"
            )
            raise

        qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=10,
        )
        self.create_subscription(self._msg_type, input_topic, self._on_status, qos)
        self.get_logger().info(
            f"TelemBridge: {input_topic} @ {1/self.min_period:.0f}Hz -> {self.host_url}"
        )

    def _on_status(self, msg):
        now = time.monotonic()
        if now - self._last_send < self.min_period:
            return
        self._last_send = now

        voltage = float(msg.battery_voltage)
        pct = _voltage_to_pct(voltage)

        telem = TelemetryMsg(
            robot_id=self.robot_id,
            battery_voltage=round(voltage, 2),
            battery_pct=pct,
        )
        packed = telem.pack()

        with self._ws_lock:
            ws = self._ws
            loop = self._async_loop
        if _ws_is_open(ws) and loop:
            asyncio.run_coroutine_threadsafe(ws.send(packed), loop)

    def set_ws(self, ws, loop):
        with self._ws_lock:
            self._ws = ws
            self._async_loop = loop


async def ws_connect_loop(node: TelemBridge):
    """Maintain a persistent WebSocket to the host."""
    url = f"{node.host_url}/ws/robot/{node.robot_id}"
    loop = asyncio.get_event_loop()
    async for ws in websockets.connect(url, ping_interval=10, ping_timeout=30):
        try:
            node.set_ws(ws, loop)
            node.get_logger().info(f"Telem bridge connected to {url}")
            async for _ in ws:
                pass
        except websockets.ConnectionClosed:
            node.get_logger().warn("Telem WS disconnected -- reconnecting")
            node.set_ws(None, loop)


def main(args=None):
    rclpy.init(args=args)
    node = TelemBridge()

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
