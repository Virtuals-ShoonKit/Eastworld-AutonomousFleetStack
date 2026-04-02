#!/usr/bin/python3
"""
Integration test: TF tree connectivity.

Launches robot_state_publisher (URDF) + EKF and verifies the
complete TF chain:
  map -> odom -> base_link -> imu_link

A static map->odom publisher stands in for AMCL/slam_toolbox,
and synthetic odom feeds the EKF to produce odom->base_link.

Run standalone:
  ros2 launch eastworld_bringup test_tf_tree.launch.py

Run via colcon:
  colcon test --packages-select eastworld_bringup --ctest-args -R test_tf_tree
"""

import os
import unittest
import time

import launch
import launch_testing
import launch_testing.actions
from launch.substitutions import Command
from launch_ros.actions import Node

import rclpy
from rclpy.node import Node as RclpyNode
from nav_msgs.msg import Odometry
from tf2_ros import Buffer, TransformListener

from ament_index_python.packages import get_package_share_directory


TIMEOUT_SEC = 15.0

EXPECTED_CHAINS = [
    ("map", "odom"),
    ("odom", "base_link"),
    ("base_link", "imu_link"),
    ("base_link", "livox_frame"),
    ("base_link", "base_footprint"),
    ("base_link", "front_left_wheel_link"),
]


def generate_test_description():
    bringup_dir = get_package_share_directory("eastworld_bringup")
    ekf_config = os.path.join(bringup_dir, "config", "ekf.yaml")
    urdf_xacro = os.path.join(bringup_dir, "urdf", "scout_mini.urdf.xacro")
    robot_description = Command(["xacro ", urdf_xacro])

    robot_state_publisher = Node(
        package="robot_state_publisher",
        executable="robot_state_publisher",
        name="robot_state_publisher",
        output="screen",
        parameters=[{"robot_description": robot_description}],
    )

    joint_state_publisher = Node(
        package="joint_state_publisher",
        executable="joint_state_publisher",
        name="joint_state_publisher",
        output="screen",
    )

    ekf_node = Node(
        package="robot_localization",
        executable="ekf_node",
        name="ekf_filter_node",
        output="screen",
        parameters=[ekf_config],
    )

    # Stand-in for AMCL/slam_toolbox: static map -> odom
    map_to_odom_tf = Node(
        package="tf2_ros",
        executable="static_transform_publisher",
        name="map_to_odom_tf",
        output="screen",
        arguments=["0", "0", "0", "0", "0", "0", "map", "odom"],
    )

    return (
        launch.LaunchDescription([
            robot_state_publisher,
            joint_state_publisher,
            ekf_node,
            map_to_odom_tf,
            launch_testing.actions.ReadyToTest(),
        ]),
        {
            "robot_state_publisher": robot_state_publisher,
            "ekf_node": ekf_node,
        },
    )


class TestTFTree(unittest.TestCase):
    """Verify the full TF chain is connected."""

    @classmethod
    def setUpClass(cls):
        rclpy.init()
        cls.node = RclpyNode("test_tf_tree")
        cls.tf_buffer = Buffer()
        cls.tf_listener = TransformListener(cls.tf_buffer, cls.node)
        cls.odom_pub = cls.node.create_publisher(Odometry, "/scout_odom", 10)
        cls.livo_pub = cls.node.create_publisher(Odometry, "/flio_odom_corrected", 10)

    @classmethod
    def tearDownClass(cls):
        cls.node.destroy_node()
        rclpy.shutdown()

    def _make_odom(self):
        msg = Odometry()
        msg.header.stamp = self.node.get_clock().now().to_msg()
        msg.header.frame_id = "odom"
        msg.child_frame_id = "base_link"
        msg.pose.pose.orientation.w = 1.0
        msg.pose.covariance[0] = 0.1
        msg.pose.covariance[7] = 0.1
        msg.pose.covariance[35] = 0.1
        return msg

    def _pump_odom(self, duration_sec=5.0):
        deadline = time.time() + duration_sec
        while time.time() < deadline:
            self.odom_pub.publish(self._make_odom())
            self.livo_pub.publish(self._make_odom())
            rclpy.spin_once(self.node, timeout_sec=0.05)
            time.sleep(0.02)

    def test_tf_chains(self):
        """All expected TF links must be resolvable."""
        self._pump_odom(duration_sec=TIMEOUT_SEC)

        failures = []
        for parent, child in EXPECTED_CHAINS:
            try:
                self.tf_buffer.lookup_transform(parent, child, rclpy.time.Time())
            except Exception as e:
                failures.append(f"  {parent} -> {child}: {e}")

        if failures:
            self.fail(
                "TF chain broken. Missing transforms:\n" + "\n".join(failures)
            )


@launch_testing.post_shutdown_test()
class TestTFTreeShutdown(unittest.TestCase):
    def test_exit_code(self, proc_info):
        launch_testing.asserts.assertExitCodes(proc_info)
