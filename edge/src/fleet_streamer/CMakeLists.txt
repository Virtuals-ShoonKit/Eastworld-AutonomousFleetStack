cmake_minimum_required(VERSION 3.8)
project(fleet_streamer)

find_package(ament_cmake REQUIRED)

install(DIRECTORY launch/ DESTINATION share/${PROJECT_NAME}/launch)
install(DIRECTORY config/ DESTINATION share/${PROJECT_NAME}/config)

install(PROGRAMS
  scripts/zed_webrtc_streamer.py
  scripts/pose_bridge.py
  scripts/cloud_bridge.py
  DESTINATION lib/${PROJECT_NAME}
)

ament_package()
