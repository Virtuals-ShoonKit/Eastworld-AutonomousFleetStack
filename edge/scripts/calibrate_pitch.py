#!/usr/bin/env python3
"""Capture N IMU samples on flat ground, compute pitch offset, update mid360.yaml."""

import math
import re
from pathlib import Path

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Imu

YAML_PATH = Path(__file__).resolve().parents[1] / "src" / "eastworld_bringup" / "config" / "mid360.yaml"
N_SAMPLES = 50


class PitchCalibrator(Node):
    def __init__(self):
        super().__init__("pitch_calibrator")
        self.samples = []
        self.sub = self.create_subscription(Imu, "/livox/imu", self._cb, 10)
        self.get_logger().info(f"Waiting for {N_SAMPLES} IMU samples on /livox/imu …")

    def _cb(self, msg):
        ax = msg.linear_acceleration.x
        az = msg.linear_acceleration.z
        self.samples.append((ax, az))

        if len(self.samples) % 10 == 0:
            self.get_logger().info(f"  collected {len(self.samples)}/{N_SAMPLES}")

        if len(self.samples) >= N_SAMPLES:
            self.sub.destroy()
            self._finish()

    def _finish(self):
        avg_ax = sum(s[0] for s in self.samples) / len(self.samples)
        avg_az = sum(s[1] for s in self.samples) / len(self.samples)
        raw_pitch = math.degrees(math.atan2(avg_ax, avg_az))
        compensation = round(-raw_pitch, 2)

        self.get_logger().info(f"  avg accel  x={avg_ax:.4f}  z={avg_az:.4f}")
        self.get_logger().info(f"  raw pitch  = {raw_pitch:.3f}°")
        self.get_logger().info(f"  compensation (sensor_pitch_deg) = {compensation}")

        if not YAML_PATH.exists():
            self.get_logger().error(f"YAML not found: {YAML_PATH}")
            raise SystemExit(1)

        text = YAML_PATH.read_text()
        new_text, count = re.subn(
            r"(sensor_pitch_deg:\s*)[\d.eE+-]+",
            rf"\g<1>{compensation}",
            text,
        )
        if count == 0:
            self.get_logger().error("sensor_pitch_deg key not found in YAML")
            raise SystemExit(1)

        YAML_PATH.write_text(new_text)
        self.get_logger().info(f"  ✓ updated {YAML_PATH.name}  →  sensor_pitch_deg: {compensation}")
        raise SystemExit(0)


def main():
    rclpy.init()
    node = PitchCalibrator()
    try:
        rclpy.spin(node)
    except SystemExit:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
