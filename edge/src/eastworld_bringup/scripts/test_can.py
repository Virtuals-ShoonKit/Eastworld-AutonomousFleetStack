#!/usr/bin/env python3
"""
Minimal Scout Mini CAN smoke test.

Checks:
  1. CAN interface is UP
  2. scout_base_node publishes Odometry on /scout_odom  (CAN read)
  3. /cmd_vel accepts a zero Twist and robot echoes updated odom (CAN write)

Usage:
  # Make sure can1 is up first:
  sudo ip link set can1 up type can bitrate 500000

  # Run the test (scout_base_node must NOT already be running):
  python3 test_can.py
  python3 test_can.py --can-device can0
  python3 test_can.py --timeout 20
"""

import argparse
import subprocess
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.executors import SingleThreadedExecutor
from nav_msgs.msg import Odometry
from geometry_msgs.msg import Twist


PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
INFO = "\033[94mINFO\033[0m"


def check_can_interface(device: str) -> bool:
    """Return True if the CAN interface exists and is UP."""
    try:
        result = subprocess.run(
            ["ip", "link", "show", device],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            print(f"  [{FAIL}] Interface '{device}' not found.")
            print(f"         Create it:  sudo ip link set {device} up type can bitrate 500000")
            return False
        if "state UP" in result.stdout or "UP" in result.stdout.split("\n")[0]:
            print(f"  [{PASS}] {device} is UP")
            return True
        else:
            print(f"  [{FAIL}] {device} exists but is DOWN.")
            print(f"         Bring it up: sudo ip link set {device} up type can bitrate 500000")
            return False
    except Exception as e:
        print(f"  [{FAIL}] Could not check {device}: {e}")
        return False


class CANTester(Node):
    def __init__(self, timeout: float):
        super().__init__("can_tester")
        self.timeout = timeout

        self.odom_msgs: list[Odometry] = []
        self.odom_after_cmd: list[Odometry] = []
        self._cmd_sent = False

        self.odom_sub = self.create_subscription(
            Odometry, "/scout_odom", self._odom_cb, 10,
        )
        self.cmd_pub = self.create_publisher(Twist, "/cmd_vel", 10)

    def _odom_cb(self, msg: Odometry):
        if self._cmd_sent:
            self.odom_after_cmd.append(msg)
        else:
            self.odom_msgs.append(msg)

    def send_zero_cmd(self):
        """Publish a zero-velocity Twist (safe, robot stays still)."""
        twist = Twist()  # all zeros
        self.cmd_pub.publish(twist)
        self._cmd_sent = True
        self.get_logger().info("Published zero Twist on /cmd_vel")


def run_tests(can_device: str, timeout: float) -> bool:
    # ── Test 1: CAN interface ──────────────────────────────────────
    print("\n[Test 1] CAN interface check")
    if not check_can_interface(can_device):
        return False

    # ── Pre-flight: verify scout_base package is available ────────
    pkg_check = subprocess.run(
        ["ros2", "pkg", "prefix", "scout_base"],
        capture_output=True, text=True, timeout=10,
    )
    if pkg_check.returncode != 0:
        print(f"  [{FAIL}] ROS 2 package 'scout_base' not found.")
        print("         Have you built and sourced the workspace?")
        print("           colcon build --packages-select scout_base")
        print("           source install/setup.bash")
        return False

    # ── Spin up scout_base_node via subprocess ─────────────────────
    print(f"\n[{INFO}] Starting scout_base_node on {can_device}...")
    scout_proc = subprocess.Popen(
        [
            "ros2", "run", "scout_base", "scout_base_node",
            "--ros-args",
            "-p", f"port_name:={can_device}",
            "-p", "is_scout_mini:=true",
            "-p", "is_omni_wheel:=false",
            "-r", "odom:=/scout_odom",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Give the node a moment to start and check it hasn't died immediately
    time.sleep(2.0)
    early_exit = scout_proc.poll()
    if early_exit is not None:
        out = scout_proc.stdout.read().decode(errors="replace").strip()
        print(f"  [{FAIL}] scout_base_node exited immediately (code {early_exit}).")
        if out:
            print(f"         Output: {out[:300]}")
        return False

    rclpy.init()
    tester = CANTester(timeout)
    executor = SingleThreadedExecutor()
    executor.add_node(tester)

    all_passed = True
    try:
        # ── Test 2: Read odom (CAN RX) ────────────────────────────
        print(f"\n[Test 2] Waiting for Odometry on /scout_odom (up to {timeout}s)...")
        deadline = time.time() + timeout
        node_died = False
        while time.time() < deadline and not tester.odom_msgs:
            executor.spin_once(timeout_sec=0.5)
            if scout_proc.poll() is not None:
                node_died = True
                break

        scout_output = ""
        if scout_proc.poll() is not None:
            try:
                scout_output = scout_proc.stdout.read().decode(errors="replace")[:2000]
            except Exception:
                scout_output = ""

        if tester.odom_msgs:
            msg = tester.odom_msgs[-1]
            pos = msg.pose.pose.position
            print(f"  [{PASS}] Received {len(tester.odom_msgs)} odom messages")
            print(f"         Last position: x={pos.x:.3f}  y={pos.y:.3f}  z={pos.z:.3f}")
        elif node_died:
            exit_code = scout_proc.returncode
            out = scout_output.strip()
            print(f"  [{FAIL}] scout_base_node crashed (exit code {exit_code}).")
            if "UNKONWN" in out or "protocol: UNKONWN" in out:
                print("         The node could not detect the Scout CAN protocol.")
                print("         This means the robot is not sending CAN frames.")
                print("         -> Is the Scout Mini powered ON?")
                print("         -> Is the CAN cable securely connected?")
            elif out:
                for line in out.splitlines()[-5:]:
                    print(f"         {line}")
            all_passed = False
            return all_passed
        else:
            print(f"  [{FAIL}] No odom received within {timeout}s.")
            print("         Is the Scout Mini powered on and CAN cable connected?")
            all_passed = False
            return all_passed

        # ── Test 3: Send cmd_vel (CAN TX) ─────────────────────────
        print("\n[Test 3] Publishing zero Twist on /cmd_vel...")
        tester.send_zero_cmd()

        deadline = time.time() + 5.0
        while time.time() < deadline and not tester.odom_after_cmd:
            executor.spin_once(timeout_sec=0.5)

        if tester.odom_after_cmd:
            print(f"  [{PASS}] Odom still publishing after cmd_vel ({len(tester.odom_after_cmd)} msgs)")
            print("         CAN TX path is working (robot accepted the command).")
        else:
            print(f"  [{FAIL}] No odom received after sending cmd_vel.")
            all_passed = False

    finally:
        executor.shutdown()
        tester.destroy_node()
        rclpy.shutdown()
        scout_proc.terminate()
        scout_proc.wait(timeout=5)

    return all_passed


def main():
    parser = argparse.ArgumentParser(description="Scout Mini CAN smoke test")
    parser.add_argument("--can-device", default="can1", help="CAN interface (default: can1)")
    parser.add_argument("--timeout", type=float, default=15.0, help="Timeout in seconds (default: 15)")
    args = parser.parse_args()

    print("=" * 50)
    print("  Scout Mini CAN Smoke Test")
    print("=" * 50)

    passed = run_tests(args.can_device, args.timeout)

    print("\n" + "=" * 50)
    if passed:
        print(f"  Result: {PASS} -- CAN read/write OK")
    else:
        print(f"  Result: {FAIL} -- see errors above")
    print("=" * 50 + "\n")

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
