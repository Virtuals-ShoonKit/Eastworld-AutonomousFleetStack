cmake_minimum_required(VERSION 3.8)
project(eastworld_bringup)

find_package(ament_cmake REQUIRED)

# Install launch files, configs, URDF, systemd unit, test launches, and maps
install(DIRECTORY
  launch
  config
  urdf
  scripts
  systemd
  test
  behavior_trees
  DESTINATION share/${PROJECT_NAME}
)

# Install maps (keepout masks, saved SLAM maps) from workspace root
install(DIRECTORY
  ${CMAKE_CURRENT_SOURCE_DIR}/../../maps/
  DESTINATION share/${PROJECT_NAME}/maps
  FILES_MATCHING
    PATTERN "*.yaml"
    PATTERN "*.pgm"
    PATTERN "*.png"
)

# Install wrapper scripts as executables
install(PROGRAMS
  scripts/start_autonomy_stack.sh
  scripts/restamp_cloud.py
  DESTINATION lib/${PROJECT_NAME}
)

ament_package()
