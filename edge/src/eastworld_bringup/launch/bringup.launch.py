#!/usr/bin/python3
"""
EastWorld AutonomyStack bringup launch composition.

Launches the full stack in one command:
  1. Livox MID360 driver  (LiDAR + IMU @ 20 Hz)
  2. FAST-LIVO2 LIO-only  (pose estimation, IMU-propagated odom @ 50 Hz, TF odom->base_link)
  3. Robot state publisher (URDF TF tree)
  4. Scout Mini base driver (CAN motor control, /cmd_vel, /scout_odom)
  5. Fleet streamer        (optional: ZED WebRTC + pose/cloud bridges to host)
  6. RViz2 (optional)
Usage:
  ros2 launch eastworld_bringup bringup.launch.py
  ros2 launch eastworld_bringup bringup.launch.py use_rviz:=false use_scout_base:=false
  ros2 launch eastworld_bringup bringup.launch.py use_fleet_streaming:=true robot_id:=robot_0 host_url:=ws://192.168.1.100:8800
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition, UnlessCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, Command
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from ament_index_python.packages import get_package_share_directory

os.environ["RCUTILS_COLORIZED_OUTPUT"] = "1"

_bringup_share = get_package_share_directory("eastworld_bringup")
os.environ.setdefault(
    "CYCLONEDDS_URI",
    "file://" + os.path.join(_bringup_share, "config", "cyclonedds.xml"),
)

NODE_ENV = {
    "ROS_DOMAIN_ID": "91",
    "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
    "CYCLONEDDS_URI": "file://" + os.path.join(_bringup_share, "config", "cyclonedds.xml"),
}

def generate_launch_description():

    # ── Package paths ──────────────────────────────────────────────────
    bringup_dir = get_package_share_directory("eastworld_bringup")
    fast_livo_dir = get_package_share_directory("fast_livo")
    livox_dir = get_package_share_directory("livox_ros_driver2")
    fleet_streamer_dir = get_package_share_directory("fleet_streamer")

    # ── Config file paths ──────────────────────────────────────────────
    mid360_config = os.path.join(bringup_dir, "config", "mid360.yaml")
    rviz_config = os.path.join(bringup_dir, "config", "fast-livo.rviz")
    camera_config = os.path.join(fast_livo_dir, "config", "camera_pinhole.yaml")
    livox_json = os.path.join(livox_dir, "config", "MID360_config.json")

    # ── Launch arguments ───────────────────────────────────────────────
    use_rviz_arg = DeclareLaunchArgument(
        "use_rviz",
        default_value="false",
        description="Launch RViz2 for visualization",
    )

    stack_log_level_arg = DeclareLaunchArgument(
        "stack_log_level",
        default_value="warn",
        description="Log level for Livox, FAST-LIVO2",
    )

    rviz_log_level_arg = DeclareLaunchArgument(
        "rviz_log_level",
        default_value="error",
        description="RViz log level",
    )

    use_scout_base_arg = DeclareLaunchArgument(
        "use_scout_base",
        default_value="true",
        description="Launch Scout Mini base driver (CAN motor control)",
    )

    can_port_arg = DeclareLaunchArgument(
        "can_port",
        default_value="can1",
        description="CAN interface for Scout Mini base driver",
    )

    # ── 1. Livox MID360 driver ─────────────────────────────────────────
    livox_driver = Node(
        package="livox_ros_driver2",
        executable="livox_ros_driver2_node",
        name="livox_lidar_publisher",
        output="screen",
        additional_env=NODE_ENV,
        arguments=["--ros-args", "--log-level", LaunchConfiguration("stack_log_level")],
        parameters=[
            {"use_sim_time": False},
            {"xfer_format": 1},
            {"multi_topic": 0},
            {"data_src": 0},
            {"publish_freq": 20.0},
            {"output_data_type": 0},
            {"frame_id": "livox_frame"},
            {"user_config_path": livox_json},
            {"cmdline_input_bd_code": "47MCNAA0034579"},
        ],
    )

    # ── 2. FAST-LIVO2 (LIO-only, no camera) ───────────────────────────
    fast_livo2 = Node(
        package="fast_livo",
        executable="fastlivo_mapping",
        name="laserMapping",
        output="screen",
        respawn=True,
        additional_env=NODE_ENV,
        arguments=["--ros-args", "--log-level", LaunchConfiguration("stack_log_level")],
        parameters=[
            mid360_config,
            {"camera_config": camera_config},
            {"use_sim_time": False},
        ],
    )
    # ── 3. Robot state publisher (URDF TF tree) ─────────────────────
    urdf_path = os.path.join(bringup_dir, "urdf", "scout_mini.urdf.xacro")
    robot_description = ParameterValue(Command(["xacro ", urdf_path]), value_type=str)

    robot_state_publisher = Node(
        package="robot_state_publisher",
        executable="robot_state_publisher",
        name="robot_state_publisher",
        output="screen",
        additional_env=NODE_ENV,
        parameters=[{"robot_description": robot_description, "use_sim_time": False}],
        arguments=["--ros-args", "--log-level", LaunchConfiguration("stack_log_level")],
    )

    joint_state_publisher = Node(
        package="joint_state_publisher",
        executable="joint_state_publisher",
        name="joint_state_publisher",
        output="screen",
        additional_env=NODE_ENV,
        parameters=[{"use_sim_time": False}],
        arguments=["--ros-args", "--log-level", LaunchConfiguration("stack_log_level")],
    )

    # ── map → odom TF ────────────────────────────────────────────
    use_relocalize_arg = DeclareLaunchArgument(
        "use_relocalize", default_value="false",
        description="Launch PCD relocalizer for automatic map→odom on startup",
    )
    map_pcd_path_arg = DeclareLaunchArgument(
        "map_pcd_path", default_value="",
        description="Path to reference PCD map for relocalization",
    )

    map_to_odom_tf = Node(
        condition=UnlessCondition(LaunchConfiguration("use_relocalize")),
        package="tf2_ros",
        executable="static_transform_publisher",
        name="map_to_odom_tf",
        output="log",
        additional_env=NODE_ENV,
        arguments=["0", "0", "0", "0", "0", "0", "map", "odom"],
    )

    relocalize_config = os.path.join(bringup_dir, "config", "relocalize_params.yaml")
    pcd_relocalizer = Node(
        condition=IfCondition(LaunchConfiguration("use_relocalize")),
        package="pcd_relocalize",
        executable="pcd_relocalizer_node",
        name="pcd_relocalizer",
        output="screen",
        additional_env=NODE_ENV,
        parameters=[
            relocalize_config,
            {"map_pcd_path": LaunchConfiguration("map_pcd_path")},
        ],
    )

    # ── 4. Scout Mini base driver (CAN motor control) ─────────────
    scout_base_node = Node(
        condition=IfCondition(LaunchConfiguration("use_scout_base")),
        package="scout_base",
        executable="scout_base_node",
        name="scout_base_node",
        output="screen",
        additional_env=NODE_ENV,
        parameters=[{
            "use_sim_time": False,
            "port_name": LaunchConfiguration("can_port"),
            "odom_frame": "odom",
            "base_frame": "base_link",
            "odom_topic_name": "/scout_odom_raw",
            "publish_odom_tf": False,
            "is_scout_mini": True,
            "is_omni_wheel": False,
            "simulated_robot": False,
            "control_rate": 50,
        }],
        remappings=[("/tf", "/scout_tf")],
        arguments=["--ros-args", "--log-level", LaunchConfiguration("stack_log_level")],
    )

    # ── 5. Fleet streamer (ZED WebRTC + pose/cloud bridges) ───────
    use_fleet_streaming_arg = DeclareLaunchArgument(
        "use_fleet_streaming",
        default_value="false",
        description="Launch fleet streaming bridge (ZED WebRTC, pose, cloud to host)",
    )
    robot_id_arg = DeclareLaunchArgument(
        "robot_id", default_value="robot_0",
        description="Unique robot identifier for fleet management",
    )
    host_url_arg = DeclareLaunchArgument(
        "host_url", default_value="ws://192.168.1.100:8800",
        description="Host fleet server WebSocket URL",
    )

    fleet_streamer_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(fleet_streamer_dir, "launch", "fleet_streamer.launch.py")
        ),
        condition=IfCondition(LaunchConfiguration("use_fleet_streaming")),
        launch_arguments={
            "robot_id": LaunchConfiguration("robot_id"),
            "host_url": LaunchConfiguration("host_url"),
        }.items(),
    )

    # ── 6. RViz2 (optional) ───────────────────────────────────────────
    rviz2 = Node(
        condition=IfCondition(LaunchConfiguration("use_rviz")),
        package="rviz2",
        executable="rviz2",
        name="rviz2",
        output="screen",
        additional_env=NODE_ENV,
        arguments=[
            "-d", rviz_config,
            "--ros-args", "--log-level", LaunchConfiguration("rviz_log_level"),
        ],
    )

    # ── Compose ───────────────────────────────────────────────────────
    return LaunchDescription([
        use_rviz_arg,
        stack_log_level_arg,
        rviz_log_level_arg,
        use_scout_base_arg,
        can_port_arg,
        use_relocalize_arg,
        map_pcd_path_arg,
        use_fleet_streaming_arg,
        robot_id_arg,
        host_url_arg,
        livox_driver,
        fast_livo2,
        robot_state_publisher,
        joint_state_publisher,
        map_to_odom_tf,
        pcd_relocalizer,
        scout_base_node,
        fleet_streamer_launch,
        rviz2,
    ])
