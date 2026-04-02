#!/usr/bin/python3
"""
Lightweight TF tree viewer — no hardware required.

Spins up:
  - robot_state_publisher  (URDF → static TF frames)
  - joint_state_publisher  (publishes 0-position for continuous wheel joints)
  - static map→odom TF     (stand-in for SLAM/AMCL)

Use alongside:
  ros2 run tf2_tools view_frames          # PDF snapshot
  rqt --standalone rqt_tf_tree            # live GUI
  rviz2 (TF display)                      # 3-D view

Run:
  ros2 launch eastworld_bringup view_tf_tree.launch.py
"""

from launch import LaunchDescription
from launch.substitutions import Command
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    bringup_dir = get_package_share_directory("eastworld_bringup")
    urdf_xacro = os.path.join(bringup_dir, "urdf", "scout_mini.urdf.xacro")

    robot_description = ParameterValue(
        Command(["xacro ", urdf_xacro]), value_type=str
    )

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

    # Stand-in for SLAM/AMCL so the full map→odom→base_link chain exists
    map_to_odom_tf = Node(
        package="tf2_ros",
        executable="static_transform_publisher",
        name="map_to_odom_tf",
        output="screen",
        arguments=["0", "0", "0", "0", "0", "0", "map", "odom"],
    )

    # camera_init = map (identity)
    map_to_camera_init_tf = Node(
        package="tf2_ros",
        executable="static_transform_publisher",
        name="map_to_camera_init_tf",
        output="screen",
        arguments=["0", "0", "0", "0", "0", "0", "map", "camera_init"],
    )

    return LaunchDescription([
        robot_state_publisher,
        joint_state_publisher,
        map_to_odom_tf,
        map_to_camera_init_tf,
    ])
