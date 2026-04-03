#include "pcd_relocalize/pcd_relocalizer.hpp"

#include <array>
#include <cmath>
#include <limits>

#include <pcl/common/transforms.h>
#include <pcl/features/fpfh_omp.h>
#include <pcl/features/normal_3d_omp.h>
#include <pcl/filters/voxel_grid.h>
#include <pcl/io/pcd_io.h>
#include <pcl/search/kdtree.h>
#include <pcl_conversions/pcl_conversions.h>

#include <teaser/fpfh.h>
#include <teaser/matcher.h>
#include <teaser/registration.h>

#include <small_gicp/registration/registration_helper.hpp>

#include <geometry_msgs/msg/transform_stamped.hpp>
#include <std_msgs/msg/bool.hpp>

namespace pcd_relocalize {

PcdRelocalizer::PcdRelocalizer(const rclcpp::NodeOptions& options)
    : Node("pcd_relocalizer", options) {
  declare_parameter("map_pcd_path", "");
  declare_parameter("cloud_topic", "/cloud_registered");
  declare_parameter("tf_parent_frame", "map");
  declare_parameter("tf_child_frame", "odom");
  declare_parameter("voxel_size", 0.5);
  declare_parameter("accumulate_duration", 3.0);
  declare_parameter("accumulate_warmup_skip_s", 0.0);
  declare_parameter("fpfh_radius", 1.5);
  declare_parameter("normal_radius", 1.0);
  declare_parameter("teaser_noise_bound", 0.1);
  declare_parameter("teaser_cbar2", 1.0);
  declare_parameter("teaser_rotation_max_iterations", 100);
  declare_parameter("teaser_rotation_cost_threshold", 0.005);
  declare_parameter("min_fpfh_correspondences", 40);
  declare_parameter("matcher_similarity_threshold", 0.9);
  declare_parameter("matcher_use_crosscheck", false);
  declare_parameter("matcher_use_tuple_test", false);
  declare_parameter("matcher_tuple_scale", 0.95);
  declare_parameter("yaw_hypothesis_step_deg", 45.0);
  declare_parameter("gicp_max_correspondence_distance", 2.0);
  declare_parameter("gicp_max_iterations", 30);
  declare_parameter("gicp_num_threads", 4);
  declare_parameter("auto_relocalize", true);

  map_pcd_path_ = get_parameter("map_pcd_path").as_string();
  cloud_topic_ = get_parameter("cloud_topic").as_string();
  tf_parent_frame_ = get_parameter("tf_parent_frame").as_string();
  tf_child_frame_ = get_parameter("tf_child_frame").as_string();
  voxel_size_ = get_parameter("voxel_size").as_double();
  accumulate_duration_ = get_parameter("accumulate_duration").as_double();
  accumulate_warmup_skip_s_ = get_parameter("accumulate_warmup_skip_s").as_double();
  fpfh_radius_ = get_parameter("fpfh_radius").as_double();
  normal_radius_ = get_parameter("normal_radius").as_double();
  teaser_noise_bound_ = get_parameter("teaser_noise_bound").as_double();
  teaser_cbar2_ = get_parameter("teaser_cbar2").as_double();
  teaser_rotation_max_iterations_ = get_parameter("teaser_rotation_max_iterations").as_int();
  teaser_rotation_cost_threshold_ = get_parameter("teaser_rotation_cost_threshold").as_double();
  min_fpfh_correspondences_ = get_parameter("min_fpfh_correspondences").as_int();
  matcher_similarity_threshold_ = get_parameter("matcher_similarity_threshold").as_double();
  matcher_use_crosscheck_ = get_parameter("matcher_use_crosscheck").as_bool();
  matcher_use_tuple_test_ = get_parameter("matcher_use_tuple_test").as_bool();
  matcher_tuple_scale_ = get_parameter("matcher_tuple_scale").as_double();
  yaw_hypothesis_step_deg_ = get_parameter("yaw_hypothesis_step_deg").as_double();
  gicp_max_corr_dist_ = get_parameter("gicp_max_correspondence_distance").as_double();
  gicp_max_iterations_ = get_parameter("gicp_max_iterations").as_int();
  gicp_num_threads_ = get_parameter("gicp_num_threads").as_int();
  auto_relocalize_ = get_parameter("auto_relocalize").as_bool();

  tf_broadcaster_ = std::make_shared<tf2_ros::TransformBroadcaster>(this);
  static_tf_broadcaster_ = std::make_shared<tf2_ros::StaticTransformBroadcaster>(this);

  reloc_status_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/relocalization_status", rclcpp::QoS(1).transient_local());
  {
    std_msgs::msg::Bool status;
    status.data = false;
    reloc_status_pub_->publish(status);
  }

  auto aligned_qos = rclcpp::QoS(rclcpp::KeepLast(1)).transient_local().reliable();
  aligned_cloud_pub_ = create_publisher<sensor_msgs::msg::PointCloud2>("~/aligned_cloud", aligned_qos);

  auto live_qos = rclcpp::QoS(rclcpp::KeepLast(10)).reliable();
  live_cloud_pub_ = create_publisher<sensor_msgs::msg::PointCloud2>("~/live_cloud", live_qos);

  cloud_sub_ = create_subscription<sensor_msgs::msg::PointCloud2>(
      cloud_topic_, rclcpp::SensorDataQoS(),
      std::bind(&PcdRelocalizer::cloudCallback, this, std::placeholders::_1));
  RCLCPP_INFO(get_logger(), "Subscribing to cloud topic: %s", cloud_topic_.c_str());

  tf_sub_ = create_subscription<tf2_msgs::msg::TFMessage>(
      "/tf", rclcpp::QoS(100),
      [this](const tf2_msgs::msg::TFMessage::SharedPtr msg) {
        std::lock_guard<std::mutex> lock(tf_cache_mutex_);
        for (const auto& t : msg->transforms) {
          if (t.header.frame_id == tf_parent_frame_ &&
              t.child_frame_id == tf_child_frame_)
            continue;
          tf_cache_[{t.header.frame_id, t.child_frame_id}] = t;
        }
      });

  publishIdentityTf();

  if (!loadReferenceMap()) {
    RCLCPP_FATAL(get_logger(), "Failed to load reference PCD. Relocalization disabled.");
    return;
  }

  relocalize_srv_ = create_service<std_srvs::srv::Trigger>(
      "~/relocalize",
      std::bind(&PcdRelocalizer::triggerCallback, this,
                std::placeholders::_1, std::placeholders::_2));
  RCLCPP_INFO(get_logger(), "Service ~/relocalize ready");

  if (auto_relocalize_) {
    startAccumulation();
  }
}

bool PcdRelocalizer::loadReferenceMap() {
  if (map_pcd_path_.empty()) {
    RCLCPP_ERROR(get_logger(), "map_pcd_path is empty");
    return false;
  }

  pcl::PointCloud<pcl::PointXYZ>::Ptr raw(new pcl::PointCloud<pcl::PointXYZ>());
  if (pcl::io::loadPCDFile(map_pcd_path_, *raw) < 0) {
    RCLCPP_ERROR(get_logger(), "Cannot read PCD file: %s", map_pcd_path_.c_str());
    return false;
  }
  RCLCPP_INFO(get_logger(), "Loaded reference PCD: %zu points from %s",
              raw->size(), map_pcd_path_.c_str());

  pcl::VoxelGrid<pcl::PointXYZ> vg;
  vg.setInputCloud(raw);
  vg.setLeafSize(voxel_size_, voxel_size_, voxel_size_);
  ref_cloud_.reset(new pcl::PointCloud<pcl::PointXYZ>());
  vg.filter(*ref_cloud_);

  RCLCPP_INFO(get_logger(), "Reference map downsampled to %zu points (voxel=%.2fm)",
              ref_cloud_->size(), voxel_size_);
  map_loaded_ = true;
  return true;
}

void PcdRelocalizer::publishIdentityTf() {
  geometry_msgs::msg::TransformStamped t;
  t.header.stamp = now();
  t.header.frame_id = tf_parent_frame_;
  t.child_frame_id = tf_child_frame_;
  t.transform.rotation.w = 1.0;
  static_tf_broadcaster_->sendTransform(t);
}

void PcdRelocalizer::startAccumulation() {
  if (accumulating_.load()) {
    RCLCPP_WARN(get_logger(), "Accumulation already in progress");
    return;
  }

  {
    std::lock_guard<std::mutex> lock(cloud_mutex_);
    accumulated_cloud_.reset(new pcl::PointCloud<pcl::PointXYZ>());
  }
  accum_warmup_done_ = (accumulate_warmup_skip_s_ <= 0.0);
  accum_warmup_clock_started_ = false;
  accumulating_.store(true);
  if (accum_warmup_done_) {
    RCLCPP_INFO(get_logger(), "Accumulating scans for %.1fs...", accumulate_duration_);
  } else {
    RCLCPP_INFO(get_logger(),
                "Skipping first %.1fs of clouds (LIO warmup), then accumulating %.1fs...",
                accumulate_warmup_skip_s_, accumulate_duration_);
  }
}

void PcdRelocalizer::triggerCallback(
    const std::shared_ptr<std_srvs::srv::Trigger::Request> /*request*/,
    std::shared_ptr<std_srvs::srv::Trigger::Response> response) {

  if (!map_loaded_) {
    response->success = false;
    response->message = "Reference map not loaded";
    return;
  }
  if (accumulating_.load()) {
    response->success = false;
    response->message = "Relocalization already in progress";
    return;
  }

  startAccumulation();
  response->success = true;
  response->message = "Relocalization started — accumulating scans";
}

void PcdRelocalizer::cloudCallback(const sensor_msgs::msg::PointCloud2::SharedPtr msg) {
  auto out = *msg;
  out.header.frame_id = tf_child_frame_;
  live_cloud_pub_->publish(out);

  if (!accumulating_.load()) return;

  if (!accum_warmup_done_) {
    if (!accum_warmup_clock_started_) {
      accum_warmup_clock_started_ = true;
      accum_warmup_t0_ = now();
    }
    if ((now() - accum_warmup_t0_).seconds() < accumulate_warmup_skip_s_) {
      return;
    }
    accum_warmup_done_ = true;
    RCLCPP_INFO(get_logger(), "Warmup done — accumulating scans for %.1fs...", accumulate_duration_);
  }

  pcl::PointCloud<pcl::PointXYZ> incoming;
  pcl::fromROSMsg(*msg, incoming);

  pcl::PointCloud<pcl::PointXYZ>::Ptr reg_cloud;
  double elapsed = 0.0;
  {
    std::lock_guard<std::mutex> lock(cloud_mutex_);
    if (accumulated_cloud_->empty()) {
      accumulation_start_ = now();
    }
    *accumulated_cloud_ += incoming;

    elapsed = (now() - accumulation_start_).seconds();
    if (elapsed < accumulate_duration_) {
      return;
    }

    reg_cloud.reset(new pcl::PointCloud<pcl::PointXYZ>(*accumulated_cloud_));
    accumulated_cloud_->clear();
    accumulating_.store(false);
  }

  RCLCPP_INFO(get_logger(), "Accumulated %zu points in %.1fs — running relocalization",
              reg_cloud->size(), elapsed);
  runRelocalization(reg_cloud);
}

void PcdRelocalizer::runRelocalization(pcl::PointCloud<pcl::PointXYZ>::Ptr accumulated_snapshot) {
  pcl::VoxelGrid<pcl::PointXYZ> vg;
  vg.setInputCloud(accumulated_snapshot);
  vg.setLeafSize(voxel_size_, voxel_size_, voxel_size_);
  pcl::PointCloud<pcl::PointXYZ>::Ptr source(new pcl::PointCloud<pcl::PointXYZ>());
  vg.filter(*source);

  RCLCPP_INFO(get_logger(), "Source cloud downsampled to %zu points", source->size());

  if (source->size() < 50) {
    RCLCPP_WARN(get_logger(), "Too few points for registration, keeping current TF");
    return;
  }

  Eigen::Isometry3d T_coarse = globalRegistration(source, ref_cloud_);
  RCLCPP_INFO(get_logger(),
              "TEASER++ coarse: t=(%.3f, %.3f, %.3f)",
              T_coarse.translation().x(),
              T_coarse.translation().y(),
              T_coarse.translation().z());

  Eigen::Isometry3d T_refined = icpRefine(source, ref_cloud_, T_coarse);
  RCLCPP_INFO(get_logger(),
              "GICP refined: t=(%.3f, %.3f, %.3f)",
              T_refined.translation().x(),
              T_refined.translation().y(),
              T_refined.translation().z());

  Eigen::Isometry3d T_se2 = projectToSE2(T_refined);
  RCLCPP_INFO(get_logger(),
              "SE(2) projected: t=(%.3f, %.3f, 0) yaw=%.3f deg",
              T_se2.translation().x(),
              T_se2.translation().y(),
              std::atan2(T_se2.rotation()(1, 0), T_se2.rotation()(0, 0)) * 180.0 / M_PI);

  publishMapToOdom(T_se2);
  publishAlignedCloud(source, T_se2);

  {
    std_msgs::msg::Bool status;
    status.data = true;
    reloc_status_pub_->publish(status);
  }

  RCLCPP_INFO(get_logger(), "Relocalization complete.");
}

Eigen::Isometry3d PcdRelocalizer::globalRegistration(
    const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
    const pcl::PointCloud<pcl::PointXYZ>::Ptr& target) {

  teaser::PointCloud src_teaser, tgt_teaser;
  src_teaser.reserve(source->size());
  for (const auto& p : source->points)
    src_teaser.push_back({p.x, p.y, p.z});
  tgt_teaser.reserve(target->size());
  for (const auto& p : target->points)
    tgt_teaser.push_back({p.x, p.y, p.z});

  teaser::FPFHEstimation fpfh;
  auto src_features = fpfh.computeFPFHFeatures(src_teaser, normal_radius_, fpfh_radius_);
  auto tgt_features = fpfh.computeFPFHFeatures(tgt_teaser, normal_radius_, fpfh_radius_);

  teaser::Matcher matcher;
  auto correspondences = matcher.calculateCorrespondences(
      src_teaser, tgt_teaser, *src_features, *tgt_features,
      true, matcher_use_crosscheck_, matcher_use_tuple_test_,
      static_cast<float>(matcher_tuple_scale_));

  RCLCPP_INFO(get_logger(), "FPFH correspondences: %zu", correspondences.size());
  if (correspondences.size() < static_cast<size_t>(min_fpfh_correspondences_)) {
    RCLCPP_WARN(get_logger(),
                "Low FPFH correspondences (%zu < %d). Consider increasing "
                "accumulate_duration or relaxing matcher settings.",
                correspondences.size(), min_fpfh_correspondences_);
  }

  teaser::RobustRegistrationSolver::Params params;
  params.noise_bound = teaser_noise_bound_;
  params.cbar2 = teaser_cbar2_;
  params.estimate_scaling = false;
  params.rotation_estimation_algorithm =
      teaser::RobustRegistrationSolver::ROTATION_ESTIMATION_ALGORITHM::GNC_TLS;
  params.rotation_max_iterations = teaser_rotation_max_iterations_;
  params.rotation_cost_threshold = teaser_rotation_cost_threshold_;

  teaser::RobustRegistrationSolver solver(params);
  auto solution = solver.solve(src_teaser, tgt_teaser, correspondences);

  Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
  if (solution.valid) {
    T.linear() = solution.rotation;
    T.translation() = solution.translation;
  } else {
    RCLCPP_WARN(get_logger(), "TEASER++ solution invalid — falling back to identity");
  }
  return T;
}

Eigen::Isometry3d PcdRelocalizer::icpRefine(
    const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
    const pcl::PointCloud<pcl::PointXYZ>::Ptr& target,
    const Eigen::Isometry3d& initial_guess) {

  std::vector<Eigen::Vector3d> src_pts, tgt_pts;
  src_pts.reserve(source->size());
  for (const auto& p : source->points)
    src_pts.emplace_back(p.x, p.y, p.z);
  tgt_pts.reserve(target->size());
  for (const auto& p : target->points)
    tgt_pts.emplace_back(p.x, p.y, p.z);

  small_gicp::RegistrationSetting setting;
  setting.type = small_gicp::RegistrationSetting::GICP;
  setting.max_correspondence_distance = gicp_max_corr_dist_;
  setting.num_threads = gicp_num_threads_;
  setting.max_iterations = gicp_max_iterations_;
  setting.downsampling_resolution = voxel_size_;

  std::array<double, 7> yaw_hypotheses_deg{0.0, 90.0, -90.0, 180.0, 45.0, -45.0, 135.0};
  if (yaw_hypothesis_step_deg_ > 0.0 && std::abs(yaw_hypothesis_step_deg_ - 45.0) > 1e-6) {
    yaw_hypotheses_deg = {0.0,
                          yaw_hypothesis_step_deg_,
                          -yaw_hypothesis_step_deg_,
                          2.0 * yaw_hypothesis_step_deg_,
                          -2.0 * yaw_hypothesis_step_deg_,
                          3.0 * yaw_hypothesis_step_deg_,
                          -3.0 * yaw_hypothesis_step_deg_};
  }

  size_t best_inliers = 0;
  bool best_converged = false;
  Eigen::Isometry3d best_T = initial_guess;
  const double deg_to_rad = M_PI / 180.0;

  for (double yaw_deg : yaw_hypotheses_deg) {
    Eigen::Isometry3d guess = initial_guess;
    guess.linear() =
        (Eigen::AngleAxisd(yaw_deg * deg_to_rad, Eigen::Vector3d::UnitZ()) *
         Eigen::Quaterniond(initial_guess.rotation()))
            .toRotationMatrix();

    auto result = small_gicp::align(tgt_pts, src_pts, guess, setting);
    if (result.converged && (!best_converged || result.num_inliers > best_inliers)) {
      best_converged = true;
      best_inliers = result.num_inliers;
      best_T = result.T_target_source;
    } else if (!best_converged && result.num_inliers > best_inliers) {
      best_inliers = result.num_inliers;
      best_T = result.T_target_source;
    }
  }

  if (!best_converged) {
    RCLCPP_WARN(get_logger(),
                "GICP did not converge for any yaw hypothesis — using best available (%zu inliers)",
                best_inliers);
  } else {
    RCLCPP_INFO(get_logger(), "GICP converged with %zu inliers", best_inliers);
  }
  return best_T;
}

Eigen::Isometry3d PcdRelocalizer::projectToSE2(const Eigen::Isometry3d& T) {
  double yaw = std::atan2(T.rotation()(1, 0), T.rotation()(0, 0));

  Eigen::Isometry3d T_se2 = Eigen::Isometry3d::Identity();
  T_se2.linear() = Eigen::AngleAxisd(yaw, Eigen::Vector3d::UnitZ()).toRotationMatrix();
  T_se2.translation() = Eigen::Vector3d(T.translation().x(), T.translation().y(), 0.0);
  return T_se2;
}

void PcdRelocalizer::publishMapToOdom(const Eigen::Isometry3d& T) {
  Eigen::Quaterniond q(T.rotation());

  geometry_msgs::msg::TransformStamped t;
  t.header.stamp = now();
  t.header.frame_id = tf_parent_frame_;
  t.child_frame_id = tf_child_frame_;
  t.transform.translation.x = T.translation().x();
  t.transform.translation.y = T.translation().y();
  t.transform.translation.z = T.translation().z();
  t.transform.rotation.x = q.x();
  t.transform.rotation.y = q.y();
  t.transform.rotation.z = q.z();
  t.transform.rotation.w = q.w();

  last_map_to_odom_ = t;
  relocalized_ = true;

  static_tf_broadcaster_->sendTransform(t);
  tf_broadcaster_->sendTransform(t);

  if (!tf_republish_timer_) {
    tf_republish_timer_ = create_wall_timer(
        std::chrono::milliseconds(200),
        std::bind(&PcdRelocalizer::tfRepublishCallback, this));
  }

  RCLCPP_INFO(get_logger(),
              "Published %s->%s TF: t=(%.3f, %.3f, %.3f) q=(%.4f, %.4f, %.4f, %.4f)",
              tf_parent_frame_.c_str(), tf_child_frame_.c_str(),
              T.translation().x(), T.translation().y(), T.translation().z(),
              q.x(), q.y(), q.z(), q.w());
}

void PcdRelocalizer::tfRepublishCallback() {
  if (!relocalized_) return;
  auto stamp = now();

  last_map_to_odom_.header.stamp = stamp;
  tf_broadcaster_->sendTransform(last_map_to_odom_);

  std::lock_guard<std::mutex> lock(tf_cache_mutex_);
  for (auto& [key, t] : tf_cache_) {
    t.header.stamp = stamp;
    tf_broadcaster_->sendTransform(t);
  }
}

void PcdRelocalizer::publishAlignedCloud(
    const pcl::PointCloud<pcl::PointXYZ>::Ptr& source,
    const Eigen::Isometry3d& T) {
  pcl::PointCloud<pcl::PointXYZ>::Ptr aligned(new pcl::PointCloud<pcl::PointXYZ>());
  pcl::transformPointCloud(*source, *aligned, T.matrix().cast<float>());

  sensor_msgs::msg::PointCloud2 msg;
  pcl::toROSMsg(*aligned, msg);
  msg.header.stamp = now();
  msg.header.frame_id = tf_parent_frame_;
  aligned_cloud_pub_->publish(msg);

  RCLCPP_INFO(get_logger(), "Published aligned cloud (%zu pts) in '%s' frame on ~/aligned_cloud",
              aligned->size(), tf_parent_frame_.c_str());
}

}  // namespace pcd_relocalize
