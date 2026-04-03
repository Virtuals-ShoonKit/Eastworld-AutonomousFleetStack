"""Launch the fleet streaming bridge (ZED WebRTC + pose + cloud bridges)."""

import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import yaml


def generate_launch_description():
    pkg_dir = get_package_share_directory("fleet_streamer")
    default_config = os.path.join(pkg_dir, "config", "fleet_streamer.yaml")
    default_robot_id = "robot_0"
    default_host_url = "ws://192.168.1.100:8800"
    pose_cfg = {"source_frame": "base_link", "target_frame": "map", "rate_hz": 50}
    cloud_cfg = {
        "input_topic": "/cloud_registered",
        "rate_hz": 5,
        "draco_quantization_bits": 11,
        "use_zstd": False,
    }
    try:
        with open(default_config, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        fleet_cfg = cfg.get("fleet_streamer", {})
        default_robot_id = str(fleet_cfg.get("robot_id", default_robot_id))
        default_host_url = str(fleet_cfg.get("host_url", default_host_url))
        pose_cfg.update(fleet_cfg.get("pose", {}))
        cloud_cfg.update(fleet_cfg.get("cloud", {}))
    except Exception:
        pass

    robot_id_arg = DeclareLaunchArgument(
        "robot_id", default_value=default_robot_id,
        description="Unique identifier for this robot in the fleet",
    )
    host_url_arg = DeclareLaunchArgument(
        "host_url", default_value=default_host_url,
        description="Host fleet server WebSocket URL",
    )
    config_arg = DeclareLaunchArgument(
        "fleet_config", default_value=default_config,
        description="Path to fleet_streamer config YAML",
    )

    zed_webrtc = ExecuteProcess(
        cmd=[
            "/usr/bin/python3",
            os.path.join(pkg_dir, "..", "..", "lib", "fleet_streamer", "zed_webrtc_streamer.py"),
            "--robot-id", LaunchConfiguration("robot_id"),
            "--host-url", LaunchConfiguration("host_url"),
            "--config", LaunchConfiguration("fleet_config"),
        ],
        output="screen",
        name="zed_webrtc_streamer",
        respawn=True,
        respawn_delay=5.0,
    )

    pose_bridge = Node(
        package="fleet_streamer",
        executable="pose_bridge.py",
        name="pose_bridge",
        output="screen",
        parameters=[{
            "robot_id": LaunchConfiguration("robot_id"),
            "host_url": LaunchConfiguration("host_url"),
            "source_frame": str(pose_cfg["source_frame"]),
            "target_frame": str(pose_cfg["target_frame"]),
            "rate_hz": float(pose_cfg["rate_hz"]),
        }],
    )

    cloud_bridge = Node(
        package="fleet_streamer",
        executable="cloud_bridge.py",
        name="cloud_bridge",
        output="screen",
        parameters=[{
            "robot_id": LaunchConfiguration("robot_id"),
            "host_url": LaunchConfiguration("host_url"),
            "input_topic": str(cloud_cfg["input_topic"]),
            "rate_hz": float(cloud_cfg["rate_hz"]),
            "draco_quantization_bits": int(cloud_cfg["draco_quantization_bits"]),
            "use_zstd": bool(cloud_cfg["use_zstd"]),
            "cloud_frame": str(cloud_cfg.get("cloud_frame", "odom")),
            "map_frame": str(cloud_cfg.get("map_frame", "map")),
        }],
    )

    telem_bridge = Node(
        package="fleet_streamer",
        executable="telem_bridge.py",
        name="telem_bridge",
        output="screen",
        parameters=[{
            "robot_id": LaunchConfiguration("robot_id"),
            "host_url": LaunchConfiguration("host_url"),
        }],
    )

    return LaunchDescription([
        robot_id_arg,
        host_url_arg,
        config_arg,
        zed_webrtc,
        pose_bridge,
        cloud_bridge,
        telem_bridge,
    ])
