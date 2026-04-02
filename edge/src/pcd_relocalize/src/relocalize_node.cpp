#include <rclcpp/rclcpp.hpp>
#include "pcd_relocalize/pcd_relocalizer.hpp"

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<pcd_relocalize::PcdRelocalizer>());
  rclcpp::shutdown();
  return 0;
}
