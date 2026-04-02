#!/usr/bin/python3
"""
Integration test: EKF odometry fusion.

Launches the robot_localization EKF node and verifies:
  1. /odometry/filtered is published
  2. odom -> base_link TF is broadcast

This test publishes synthetic Odometry on /scout_odom and
/flio_odom_corrected to drive the EKF without real hardware.

Run standalone:
  ros2 launch eastworld_bringup test_ekf.launch.py

Run via colcon:
  colcon test --packages-select eastworld_bringup --ctest-args -R test_ekf
"""

import os
import unittest
import time

import launch
import launch_testing
import launch_testing.actions
from launch_ros.actions import Node

import rclpy
from rclpy.node import Node as RclpyNode
from nav_msgs.msg import Odometry
from geometry_msgs.msg import TransformStamped
from tf2_ros import Buffer, TransformListener

from ament_index_python.packages import get_package_share_directory


FILTERED_TOPIC = "/odometry/filtered"
TIMEOUT_SEC = 15.0


def generate_test_description():
    bringup_dir = get_package_share_directory("eastworld_bringup")
    ekf_config = os.path.join(bringup_dir, "config", "ekf.yaml")

    ekf_node = Node(
        package="robot_localization",
        executable="ekf_node",
        name="ekf_filter_node",
        output="screen",
        parameters=[ekf_config],
    )

    return (
        launch.LaunchDescription([
            ekf_node,
            launch_testing.actions.ReadyToTest(),
        ]),
        {"ekf_node": ekf_node},
    )


class TestEKF(unittest.TestCase):
    """Verify EKF node produces fused odometry and TF."""

    @classmethod
    def setUpClass(cls):
        rclpy.init()
        cls.node = RclpyNode("test_ekf")
        cls.tf_buffer = Buffer()
        cls.tf_listener = TransformListener(cls.tf_buffer, cls.node)
        cls.odom_pub_scout = cls.node.create_publisher(Odometry, "/scout_odom", 10)
        cls.odom_pub_livo = cls.node.create_publisher(Odometry, "/flio_odom_corrected", 10)

    @classmethod
    def tearDownClass(cls):
        cls.node.destroy_node()
        rclpy.shutdown()

    def _make_odom(self, frame_id="odom", child_frame_id="base_link"):
        msg = Odometry()
        msg.header.stamp = self.node.get_clock().now().to_msg()
        msg.header.frame_id = frame_id
        msg.child_frame_id = child_frame_id
        msg.pose.pose.orientation.w = 1.0
        msg.pose.covariance[0] = 0.1
        msg.pose.covariance[7] = 0.1
        msg.pose.covariance[35] = 0.1
        return msg

    def _pump_odom(self, duration_sec=5.0):
        """Publish synthetic odom messages to feed the EKF."""
        deadline = time.time() + duration_sec
        while time.time() < deadline:
            self.odom_pub_scout.publish(self._make_odom())
            self.odom_pub_livo.publish(self._make_odom())
            rclpy.spin_once(self.node, timeout_sec=0.05)
            time.sleep(0.02)

    def test_filtered_odom_published(self):
        """/odometry/filtered must be published by the EKF."""
        received = []

        def _cb(msg):
            received.append(msg)

        sub = self.node.create_subscription(Odometry, FILTERED_TOPIC, _cb, 10)
        try:
            self._pump_odom(duration_sec=TIMEOUT_SEC)
            self.assertGreater(
                len(received), 0,
                f"No messages on {FILTERED_TOPIC} within {TIMEOUT_SEC}s.",
            )
        finally:
            self.node.destroy_subscription(sub)

    def test_odom_to_base_link_tf(self):
        """EKF must broadcast odom -> base_link transform."""
        self._pump_odom(duration_sec=TIMEOUT_SEC)
        try:
            transform = self.tf_buffer.lookup_transform(
                "odom", "base_link", rclpy.time.Time(),
            )
            self.assertIsNotNone(transform)
        except Exception as e:
            self.fail(f"odom -> base_link TF not available: {e}")


@launch_testing.post_shutdown_test()
class TestEKFShutdown(unittest.TestCase):
    def test_exit_code(self, proc_info):
        launch_testing.asserts.assertExitCodes(proc_info)
