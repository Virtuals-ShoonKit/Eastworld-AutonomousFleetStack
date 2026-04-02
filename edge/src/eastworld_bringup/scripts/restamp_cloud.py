#!/usr/bin/env python3
"""Re-stamp a PointCloud2 topic so downstream TF lookups succeed.

FAST-LIVO2 publishes /cloud_registered with timestamps that may drift
from the TF clock.  This node stamps each cloud with the timestamp of
the latest odom->base_link TF so that downstream nodes can always look
up the transform.
"""

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from sensor_msgs.msg import PointCloud2
import tf2_ros


class RestampCloud(Node):
    def __init__(self):
        super().__init__("restamp_cloud")
        self.declare_parameter("target_rate", 15.0)
        self._min_interval = 1.0 / self.get_parameter("target_rate").value

        self._tf_buffer = tf2_ros.Buffer(cache_time=rclpy.duration.Duration(seconds=30))
        self._tf_listener = tf2_ros.TransformListener(self._tf_buffer, self)

        sub_qos = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        pub_qos = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE,
        )
        self.pub = self.create_publisher(PointCloud2, "cloud_out", pub_qos)
        self.sub = self.create_subscription(
            PointCloud2, "cloud_in", self._cb, sub_qos
        )
        self._last_pub = 0.0

    def _cb(self, msg: PointCloud2):
        now_ns = self.get_clock().now().nanoseconds
        if (now_ns / 1e9 - self._last_pub) < self._min_interval:
            return

        try:
            tf = self._tf_buffer.lookup_transform(
                "map", "base_link", rclpy.time.Time()
            )
            msg.header.stamp = tf.header.stamp
        except (tf2_ros.LookupException,
                tf2_ros.ConnectivityException,
                tf2_ros.ExtrapolationException):
            return

        self._last_pub = now_ns / 1e9
        self.pub.publish(msg)


def main():
    rclpy.init()
    rclpy.spin(RestampCloud())
    rclpy.shutdown()


if __name__ == "__main__":
    main()
