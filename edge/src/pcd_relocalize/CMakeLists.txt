cmake_minimum_required(VERSION 3.16)
project(pcd_relocalize)

set(CMAKE_CXX_STANDARD 17)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(std_srvs REQUIRED)
find_package(tf2_msgs REQUIRED)
find_package(tf2_ros REQUIRED)
find_package(pcl_conversions REQUIRED)
find_package(PCL REQUIRED COMPONENTS common io features filters kdtree search)
find_package(Eigen3 REQUIRED)
find_package(OpenMP)
find_package(Boost REQUIRED)

# ---------------------------------------------------------------------------
# TEASER++ (built from submodule)
# ---------------------------------------------------------------------------
set(BUILD_TEASER_FPFH ON CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_PYTHON_BINDINGS OFF CACHE BOOL "" FORCE)
set(BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_MATLAB_BINDINGS OFF CACHE BOOL "" FORCE)
set(ENABLE_DIAGNOSTIC_PRINT OFF CACHE BOOL "" FORCE)

set(TEASERPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/TEASER-plusplus")
add_subdirectory(${TEASERPP_DIR} ${CMAKE_CURRENT_BINARY_DIR}/teaser_build EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# small_gicp (built from submodule)
# ---------------------------------------------------------------------------
set(BUILD_HELPER ON CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(BUILD_WITH_PCL OFF CACHE BOOL "" FORCE)

set(SMALL_GICP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/small_gicp")
add_subdirectory(${SMALL_GICP_DIR} ${CMAKE_CURRENT_BINARY_DIR}/small_gicp_build EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
# Relocalizer node
# ---------------------------------------------------------------------------
add_executable(pcd_relocalizer_node
  src/relocalize_node.cpp
  src/pcd_relocalizer.cpp
)
target_include_directories(pcd_relocalizer_node PRIVATE
  include
  ${PCL_INCLUDE_DIRS}
  ${TEASERPP_DIR}/teaser/include
  ${SMALL_GICP_DIR}/include
)
target_link_libraries(pcd_relocalizer_node
  ${PCL_LIBRARIES}
  teaser_registration
  teaser_features
  small_gicp
  Eigen3::Eigen
)
set_target_properties(pcd_relocalizer_node PROPERTIES
  BUILD_RPATH "${CMAKE_CURRENT_BINARY_DIR}/teaser_build/teaser;${CMAKE_CURRENT_BINARY_DIR}/small_gicp_build"
  INSTALL_RPATH "${CMAKE_CURRENT_BINARY_DIR}/teaser_build/teaser;${CMAKE_CURRENT_BINARY_DIR}/small_gicp_build"
)
if(OpenMP_CXX_FOUND)
  target_link_libraries(pcd_relocalizer_node OpenMP::OpenMP_CXX)
endif()
ament_target_dependencies(pcd_relocalizer_node
  rclcpp sensor_msgs std_msgs geometry_msgs std_srvs tf2_msgs tf2_ros pcl_conversions
)

# ---------------------------------------------------------------------------
# pcd_to_map offline CLI
# ---------------------------------------------------------------------------
add_executable(pcd_to_map src/pcd_to_map.cpp)
target_include_directories(pcd_to_map PRIVATE ${PCL_INCLUDE_DIRS})
target_link_libraries(pcd_to_map ${PCL_LIBRARIES})

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install(TARGETS pcd_relocalizer_node pcd_to_map
  DESTINATION lib/${PROJECT_NAME}
)
install(FILES
  ${CMAKE_CURRENT_BINARY_DIR}/teaser_build/teaser/libteaser_registration.so
  ${CMAKE_CURRENT_BINARY_DIR}/teaser_build/teaser/libteaser_features.so
  ${CMAKE_CURRENT_BINARY_DIR}/small_gicp_build/libsmall_gicp.so
  DESTINATION lib
)
install(DIRECTORY config/
  DESTINATION share/${PROJECT_NAME}/config
)

ament_package()
