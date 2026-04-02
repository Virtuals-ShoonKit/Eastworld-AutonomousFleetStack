#!/usr/bin/env bash
# Launch Scout Mini stack with Nav2 mapping (slam_toolbox) and RViz.
# Run from workspace root, or set EW_UGV_WS to your workspace path.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="${EW_UGV_WS:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

source /opt/ros/humble/setup.bash
source "$WS_ROOT/install/setup.bash"

# Match scout_mini.launch.py if you use domain/rmw there
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}"
export RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
unset CYCLONEDDS_URI

echo "Workspace: $WS_ROOT"
echo "Starting Scout Mini with Nav2 (SLAM mode) and RViz..."
exec ros2 launch eastworld_bringup scout_mini.launch.py \
  use_nav:=true \
  nav_mode:=slam \
  use_rviz:=true \
  "$@"
