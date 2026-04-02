#!/usr/bin/python3
"""
Nav2 navigation launch for Scout Mini UGV.

Launches the Nav2 stack (controller, planner, behavior, BT navigator,
velocity smoother, lifecycle manager).  Designed to run alongside
bringup.launch.py which provides sensors, FAST-LIVO2, robot_state_publisher,
and scout_base_node.

Usage:
  ros2 launch eastworld_bringup navigation.launch.py
  ros2 launch eastworld_bringup navigation.launch.py params_file:=/path/to/custom_nav2.yaml
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, GroupAction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node, SetRemap, PushRosNamespace
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():

    bringup_dir = get_package_share_directory("eastworld_bringup")

    params_file_arg = DeclareLaunchArgument(
        "params_file",
        default_value=os.path.join(bringup_dir, "config", "nav2_params.yaml"),
        description="Full path to Nav2 parameters file",
    )

    autostart_arg = DeclareLaunchArgument(
        "autostart",
        default_value="true",
        description="Automatically start Nav2 lifecycle nodes",
    )

    log_level_arg = DeclareLaunchArgument(
        "log_level",
        default_value="warn",
        description="Log level for Nav2 nodes",
    )

    params_file = LaunchConfiguration("params_file")
    log_level = LaunchConfiguration("log_level")

    nav2_nodes = GroupAction(
        actions=[
            SetRemap(src="/cmd_vel", dst="/cmd_vel_nav"),

            Node(
                package="nav2_controller",
                executable="controller_server",
                name="controller_server",
                output="screen",
                respawn=True,
                respawn_delay=2.0,
                parameters=[params_file],
                arguments=["--ros-args", "--log-level", log_level],
                remappings=[("cmd_vel", "cmd_vel_nav")],
            ),

            Node(
                package="nav2_planner",
                executable="planner_server",
                name="planner_server",
                output="screen",
                respawn=True,
                respawn_delay=2.0,
                parameters=[params_file],
                arguments=["--ros-args", "--log-level", log_level],
            ),

            Node(
                package="nav2_behaviors",
                executable="behavior_server",
                name="behavior_server",
                output="screen",
                respawn=True,
                respawn_delay=2.0,
                parameters=[params_file],
                arguments=["--ros-args", "--log-level", log_level],
            ),

            Node(
                package="nav2_bt_navigator",
                executable="bt_navigator",
                name="bt_navigator",
                output="screen",
                respawn=True,
                respawn_delay=2.0,
                parameters=[params_file],
                arguments=["--ros-args", "--log-level", log_level],
            ),

            Node(
                package="nav2_velocity_smoother",
                executable="velocity_smoother",
                name="velocity_smoother",
                output="screen",
                respawn=True,
                respawn_delay=2.0,
                parameters=[params_file],
                arguments=["--ros-args", "--log-level", log_level],
                remappings=[
                    ("cmd_vel", "cmd_vel_nav"),
                    ("cmd_vel_smoothed", "cmd_vel"),
                ],
            ),

            Node(
                package="nav2_lifecycle_manager",
                executable="lifecycle_manager",
                name="lifecycle_manager_navigation",
                output="screen",
                arguments=["--ros-args", "--log-level", log_level],
                parameters=[
                    params_file,
                    {"autostart": LaunchConfiguration("autostart")},
                ],
            ),
        ]
    )

    return LaunchDescription([
        params_file_arg,
        autostart_arg,
        log_level_arg,
        nav2_nodes,
    ])
