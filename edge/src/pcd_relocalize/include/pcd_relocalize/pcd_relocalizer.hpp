#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <utility>
#include <vector>

#include <Eigen/Core>
#include <Eigen/Geometry>

#include <pcl/point_cloud.h>
#include <pcl/point_types.h>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_srvs/srv/trigger.hpp>
#include <tf2_msgs/msg/tf_message.hpp>
#include <tf2_ros/static_transform_broadcaster.h>
#include <tf2_ros/transform_broadcaster.h>

namespace pcd_relocalize {

class PcdRelocalizer : public rclcpp::Node {
public:
  explicit PcdRelocalizer(const rclcpp::NodeOptions& options = rclcpp::NodeOptions());

private:
  bool loadReferenceMap();
  void publishIdentityTf();

  void startAccumulation();
  void cloudCallback(const sensor_msgs::msg::PointCloud2::SharedPtr msg);
  void runRelocalization(pcl::PointCloud<pcl::PointXYZ>::Ptr accumulated_snapshot);

  void triggerCallback(
      const std::shared_ptr<std_srvs::srv::Trigger::Request> request,
      std::shared_ptr<std_srvs::srv::Trigger::Response> response);

  Eigen::Isometry3d globalRegistration(
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& target);
  Eigen::Isometry3d icpRefine(
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
      const pcl::PointCloud<pcl::PointXYZ>::Ptr& target,
      const Eigen::Isometry3d& initial_guess);

  static Eigen::Isometry3d projectToSE2(const Eigen::Isometry3d& T);
  void publishMapToOdom(const Eigen::Isometry3d& T);
  void publishAlignedCloud(const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
                           const Eigen::Isometry3d& T);
  void tfRepublishCallback();

  // Parameters
  std::string map_pcd_path_;
  std::string cloud_topic_;
  std::string tf_parent_frame_;
  std::string tf_child_frame_;
  double voxel_size_;
  double accumulate_duration_;
  double accumulate_warmup_skip_s_;
  double fpfh_radius_;
  double normal_radius_;
  double teaser_noise_bound_;
  double teaser_cbar2_;
  int teaser_rotation_max_iterations_;
  double teaser_rotation_cost_threshold_;
  double matcher_similarity_threshold_;
  double matcher_tuple_scale_;
  bool matcher_use_crosscheck_;
  bool matcher_use_tuple_test_;
  double yaw_hypothesis_step_deg_;
  double gicp_max_corr_dist_;
  int gicp_max_iterations_;
  int gicp_num_threads_;
  int min_fpfh_correspondences_;
  bool auto_relocalize_;

  // State
  pcl::PointCloud<pcl::PointXYZ>::Ptr ref_cloud_;
  pcl::PointCloud<pcl::PointXYZ>::Ptr accumulated_cloud_;
  std::mutex cloud_mutex_;
  rclcpp::Time accumulation_start_;
  std::atomic<bool> accumulating_{false};
  bool accum_warmup_done_{true};
  bool accum_warmup_clock_started_{false};
  rclcpp::Time accum_warmup_t0_;
  bool map_loaded_ = false;
  bool relocalized_ = false;
  geometry_msgs::msg::TransformStamped last_map_to_odom_;

  // TF cache: latch all external dynamic TFs so they survive bag stop
  std::mutex tf_cache_mutex_;
  std::map<std::pair<std::string, std::string>,
           geometry_msgs::msg::TransformStamped> tf_cache_;

  // ROS interfaces
  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr cloud_sub_;
  rclcpp::Subscription<tf2_msgs::msg::TFMessage>::SharedPtr tf_sub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr relocalize_srv_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr reloc_status_pub_;
  std::shared_ptr<tf2_ros::TransformBroadcaster> tf_broadcaster_;
  std::shared_ptr<tf2_ros::StaticTransformBroadcaster> static_tf_broadcaster_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr aligned_cloud_pub_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr live_cloud_pub_;
  rclcpp::TimerBase::SharedPtr tf_republish_timer_;
};

}  // namespace pcd_relocalize
