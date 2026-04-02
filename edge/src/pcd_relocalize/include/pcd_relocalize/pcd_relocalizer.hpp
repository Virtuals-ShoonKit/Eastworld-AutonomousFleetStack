#pragma once

#include <atomic>
#include <mutex>
#include <vector>

#include <Eigen/Core>
#include <Eigen/Geometry>

#include <pcl/point_cloud.h>
#include <pcl/point_types.h>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <std_srvs/srv/trigger.hpp>
#include <tf2_ros/static_transform_broadcaster.h>

namespace pcd_relocalize {

class PcdRelocalizer : public rclcpp::Node {
public:
  explicit PcdRelocalizer(const rclcpp::NodeOptions& options = rclcpp::NodeOptions());

private:
  bool loadReferenceMap();
  void publishIdentityTf();

  // Accumulation + registration pipeline (reusable)
  void startAccumulation();
  void cloudCallback(const sensor_msgs::msg::PointCloud2::SharedPtr msg);
  void runRelocalization();

  // Service handler
  void triggerCallback(
      const std::shared_ptr<std_srvs::srv::Trigger::Request> request,
      std::shared_ptr<std_srvs::srv::Trigger::Response> response);

  // Registration helpers
  Eigen::Isometry3d globalRegistration(
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& target);
  Eigen::Isometry3d icpRefine(
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& target,
      const Eigen::Isometry3d& initial_guess);

  static Eigen::Isometry3d projectToSE2(const Eigen::Isometry3d& T);
  void publishMapToOdom(const Eigen::Isometry3d& T);

  // Parameters
  std::string map_pcd_path_;
  double voxel_size_;
  double accumulate_duration_;
  double fpfh_radius_;
  double normal_radius_;
  double teaser_noise_bound_;
  double gicp_max_corr_dist_;
  int gicp_num_threads_;
  bool auto_relocalize_;

  // State
  pcl::PointCloud<pcl::PointXYZ>::Ptr ref_cloud_;
  pcl::PointCloud<pcl::PointXYZ>::Ptr accumulated_cloud_;
  std::mutex cloud_mutex_;
  rclcpp::Time accumulation_start_;
  std::atomic<bool> accumulating_{false};
  bool map_loaded_ = false;

  // ROS interfaces
  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr cloud_sub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr relocalize_srv_;
  std::shared_ptr<tf2_ros::StaticTransformBroadcaster> tf_broadcaster_;
};

}  // namespace pcd_relocalize
