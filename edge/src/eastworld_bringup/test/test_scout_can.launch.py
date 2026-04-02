#!/usr/bin/python3
"""
Integration test: Scout Mini CAN communication.

Verifies that scout_base_node starts, subscribes to /cmd_vel,
and publishes odometry on /scout_odom within a timeout.

Run standalone:
  ros2 launch eastworld_bringup test_scout_can.launch.py

Run via colcon:
  colcon test --packages-select eastworld_bringup --ctest-args -R test_scout_can
"""

import os
import unittest
import time

import launch
import launch_testing
import launch_testing.actions
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

import rclpy
from rclpy.node import Node as RclpyNode
from nav_msgs.msg import Odometry
from geometry_msgs.msg import Twist


NODE_ENV = {
    "ROS_DOMAIN_ID": "69",
    "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
}

SCOUT_ODOM_TOPIC = "/scout_odom"
CMD_VEL_TOPIC = "/cmd_vel"
TIMEOUT_SEC = 15.0


def generate_test_description():
    can_device_arg = DeclareLaunchArgument(
        "can_device", default_value="can0",
        description="CAN bus device name",
    )

    scout_base_node = Node(
        package="scout_base",
        executable="scout_base_node",
        name="scout_base_node",
        output="screen",
        emulate_tty=True,
        additional_env=NODE_ENV,
        remappings=[("odom", SCOUT_ODOM_TOPIC)],
        parameters=[{
            "port_name": LaunchConfiguration("can_device"),
            "odom_frame": "odom",
            "base_frame": "base_link",
            "odom_topic_name": "odom",
            "is_scout_mini": True,
            "is_omni_wheel": False,
            "simulated_robot": False,
            "control_rate": 50,
        }],
    )

    return (
        launch.LaunchDescription([
            can_device_arg,
            scout_base_node,
            launch_testing.actions.ReadyToTest(),
        ]),
        {"scout_base_node": scout_base_node},
    )


class TestScoutCAN(unittest.TestCase):
    """Verify Scout Mini CAN communication is healthy."""

    @classmethod
    def setUpClass(cls):
        rclpy.init()
        cls.node = RclpyNode("test_scout_can")

    @classmethod
    def tearDownClass(cls):
        cls.node.destroy_node()
        rclpy.shutdown()

    def test_odom_published(self):
        """scout_base_node must publish Odometry on /scout_odom."""
        received = []

        def _cb(msg):
            received.append(msg)

        sub = self.node.create_subscription(Odometry, SCOUT_ODOM_TOPIC, _cb, 10)
        try:
            deadline = time.time() + TIMEOUT_SEC
            while time.time() < deadline and not received:
                rclpy.spin_once(self.node, timeout_sec=0.5)
            self.assertGreater(
                len(received), 0,
                f"No Odometry messages received on {SCOUT_ODOM_TOPIC} within {TIMEOUT_SEC}s. "
                "Check CAN interface (ip link show can0) and cable connection.",
            )
        finally:
            self.node.destroy_subscription(sub)

    def test_cmd_vel_subscriber_exists(self):
        """scout_base_node must be subscribed to /cmd_vel."""
        deadline = time.time() + TIMEOUT_SEC
        found = False
        while time.time() < deadline and not found:
            topic_list = self.node.get_topic_names_and_types()
            for name, types in topic_list:
                if name == CMD_VEL_TOPIC:
                    found = True
                    break
            if not found:
                rclpy.spin_once(self.node, timeout_sec=0.5)
        self.assertTrue(
            found,
            f"{CMD_VEL_TOPIC} topic not found. scout_base_node may not have started.",
        )


@launch_testing.post_shutdown_test()
class TestScoutCANShutdown(unittest.TestCase):
    def test_exit_code(self, proc_info):
        launch_testing.asserts.assertExitCodes(proc_info)
