#!/usr/bin/env python3
"""
ROS 2 ScoutStatus -> WebSocket telemetry bridge.

Subscribes to /scout_status, extracts battery voltage, maps it to a
percentage (7S Li-ion: ~22 V empty, ~29.4 V full), and streams compact
TELEMETRY messages to the host fleet server at ~1 Hz.

Optionally reads CPU/GPU/memory stats via jetson-stats (jtop) if available.
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


_GPU_LOAD_PATHS = [
    "/sys/devices/gpu.0/load",
    "/sys/devices/17000000.gpu/load",
    "/sys/devices/platform/gpu.0/load",
    "/sys/devices/platform/17000000.gpu/load",
]


class JetsonMonitor:
    """Reads CPU/GPU/memory stats from /proc and /sys (no jtop needed).

    Works on any Jetson (JetPack 5/6) and any generic Linux host.
    Polls at ~1 Hz in a background daemon thread.
    """

    def __init__(self, logger=None):
        self._lock = threading.Lock()
        self._cpu_pct: float = 0.0
        self._gpu_pct: float = 0.0
        self._mem_used_mb: int = 0
        self._mem_total_mb: int = 0
        self._available = False
        self._log = logger

        self._prev_idle: int = 0
        self._prev_total: int = 0
        self._gpu_path: str | None = None

        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    def _find_gpu_path(self) -> str | None:
        for p in _GPU_LOAD_PATHS:
            if Path(p).exists():
                return p
        return None

    def _read_cpu(self) -> float:
        """Overall CPU usage % from /proc/stat (delta between samples)."""
        try:
            with open("/proc/stat") as f:
                fields = f.readline().split()
            # user nice system idle iowait irq softirq steal
            vals = [int(v) for v in fields[1:9]]
            idle = vals[3] + vals[4]  # idle + iowait
            total = sum(vals)

            d_idle = idle - self._prev_idle
            d_total = total - self._prev_total
            self._prev_idle = idle
            self._prev_total = total

            if d_total == 0:
                return 0.0
            return round((1.0 - d_idle / d_total) * 100.0, 1)
        except Exception:
            return 0.0

    def _read_gpu(self) -> float:
        """GPU load % from Jetson sysfs (0-1000 scale -> 0-100%)."""
        if self._gpu_path is None:
            return 0.0
        try:
            with open(self._gpu_path) as f:
                raw = int(f.read().strip())
            return round(raw / 10.0, 1)
        except Exception:
            return 0.0

    @staticmethod
    def _read_mem() -> tuple[int, int]:
        """(used_mb, total_mb) from /proc/meminfo."""
        try:
            info: dict[str, int] = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    parts = line.split()
                    if parts[0] in ("MemTotal:", "MemAvailable:"):
                        info[parts[0]] = int(parts[1])  # kB
                    if len(info) == 2:
                        break
            total_kb = info.get("MemTotal:", 0)
            avail_kb = info.get("MemAvailable:", 0)
            used_mb = (total_kb - avail_kb) // 1024
            total_mb = total_kb // 1024
            return used_mb, total_mb
        except Exception:
            return 0, 0

    def _loop(self) -> None:
        self._gpu_path = self._find_gpu_path()
        # Prime the CPU delta counters with an initial read
        self._read_cpu()
        self._available = True
        if self._log:
            gpu_status = self._gpu_path or "not found"
            self._log.info(f"JetsonMonitor: started (gpu sysfs: {gpu_status})")

        while True:
            cpu = self._read_cpu()
            gpu = self._read_gpu()
            used_mb, total_mb = self._read_mem()

            with self._lock:
                self._cpu_pct = cpu
                self._gpu_pct = gpu
                self._mem_used_mb = used_mb
                self._mem_total_mb = total_mb

            time.sleep(1.0)

    @property
    def available(self) -> bool:
        return self._available

    def snapshot(self) -> dict | None:
        if not self._available:
            return None
        with self._lock:
            return {
                "cpu_pct": self._cpu_pct,
                "gpu_pct": self._gpu_pct,
                "mem_used_mb": self._mem_used_mb,
                "mem_total_mb": self._mem_total_mb,
            }


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
        self._pending: bytes | None = None
        self._drain_scheduled = False

        self._jetson = JetsonMonitor(logger=self.get_logger())

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

        js = self._jetson.snapshot()
        telem = TelemetryMsg(
            robot_id=self.robot_id,
            battery_voltage=round(voltage, 2),
            battery_pct=pct,
            cpu_pct=js["cpu_pct"] if js else None,
            gpu_pct=js["gpu_pct"] if js else None,
            mem_used_mb=js["mem_used_mb"] if js else None,
            mem_total_mb=js["mem_total_mb"] if js else None,
        )
        packed = telem.pack()

        with self._ws_lock:
            self._pending = packed
            ws = self._ws
            loop = self._async_loop
            should_schedule = bool(loop and _ws_is_open(ws) and not self._drain_scheduled)
            if should_schedule:
                self._drain_scheduled = True
        if should_schedule:
            asyncio.run_coroutine_threadsafe(self._drain(), loop)

    async def _drain(self):
        with self._ws_lock:
            data = self._pending
            self._pending = None
            ws = self._ws
        if data and _ws_is_open(ws):
            try:
                await ws.send(data)
            except Exception:
                pass
        with self._ws_lock:
            self._drain_scheduled = False

    def set_ws(self, ws, loop):
        schedule_drain = False
        with self._ws_lock:
            self._ws = ws
            self._async_loop = loop
            if ws is not None and self._pending is not None and not self._drain_scheduled:
                self._drain_scheduled = True
                schedule_drain = True
        if schedule_drain:
            asyncio.run_coroutine_threadsafe(self._drain(), loop)


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
