"""Per-robot session: tracks connection state, latest pose, and health."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class RobotSession:
    robot_id: str
    connected: bool = True
    last_heartbeat: float = field(default_factory=time.time)
    hardware: str = "orin_nx"

    # Latest cached pose for new viewer connections
    last_pose_bytes: bytes | None = None

    # Battery telemetry (updated via TELEMETRY messages)
    battery_voltage: float | None = None
    battery_pct: int | None = None

    def touch(self):
        self.last_heartbeat = time.time()

    def is_alive(self, timeout_s: float = 10.0) -> bool:
        return self.connected and (time.time() - self.last_heartbeat) < timeout_s

    def to_dict(self) -> dict:
        return {
            "robot_id": self.robot_id,
            "connected": self.connected,
            "last_heartbeat": self.last_heartbeat,
            "hardware": self.hardware,
            "alive": self.is_alive(),
            "battery_voltage": self.battery_voltage,
            "battery_pct": self.battery_pct,
        }
