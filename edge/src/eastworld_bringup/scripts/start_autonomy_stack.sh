#!/usr/bin/env bash
set -e

source /opt/ros/humble/setup.bash
source /home/nvidia/EastWorld-AutonomyStack/install/setup.bash

export ROS_DOMAIN_ID=69
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
unset CYCLONEDDS_URI

exec ros2 launch eastworld_bringup scout_mini.launch.py "$@"
