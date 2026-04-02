# EastWorld UGV Fleet Management

Fleet management system for multiple autonomous robots.
Each robot runs a Jetson Orin NX with Livox MID360 + ZED Mini / Intel Realsense. A central
RTX 4090 host renders the 3D map, robot poses, and live video in a web viewer.

## Architecture

```
edge/ (Jetson Orin NX x5)              host/ (RTX 4090)            browser
┌──────────────────────┐               ┌──────────────────┐       ┌────────────┐
│ Livox → FAST-LIVO2   │               │ fleet_server.py  │       │ Three.js   │
│  ├─ /tf (pose)       │──WebSocket───>│   ├─ signaling   │       │ 3D map +   │
│  └─ /cloud_registered│──Draco+WS──>│    ├─ data relay  │──WS──>│ robot poses│
│                      │               │   └─ robot reg.  │       │            │
│ zedsrc → NVENC       │               │                  │       │ WebRTC     │
│   └─ webrtcbin       │──WebRTC H264──────────────────────────>  │ video grid │
│                      │               │                  │       │            │
│ Scout Mini (CAN)     │               │ web/ (Vite+React)│       │            │
│ pcd_relocalize       │               │ tools/           │       └────────────┘
└──────────────────────┘               └──────────────────┘
```

## Repository Structure

```
EW_UGV_SK/
├── edge/                       # Jetson Orin NX (per robot)
│   ├── src/
│   │   ├── eastworld_bringup/  # Launch files, configs, URDF
│   │   ├── fleet_streamer/     # ZED WebRTC + pose/cloud bridges
│   │   ├── FAST-LIVO2/         # LiDAR-inertial odometry
│   │   ├── livox_ros_driver2/  # Livox MID360 driver
│   │   ├── pcd_relocalize/     # TEASER++ / small_gicp relocalizer
│   │   ├── scout_ros2/         # Scout Mini driver
│   │   └── ugv_sdk/            # AgileX platform SDK
│   ├── third_party/            # Livox SDK2, TEASER++, small_gicp, ZED SDK
│   ├── maps/                   # Saved PCD maps
│   ├── scripts/                # CAN setup helpers
│   └── global_config/          # Jetson power model config
│
├── host/                       # RTX 4090 server
│   ├── server/                 # Python aiohttp backend
│   ├── web/                    # React + Three.js fleet viewer
│   └── tools/                  # PCD-to-web converter
│
├── shared/                     # Protocol definitions (msgpack schemas)
│   └── protocol.py
│
├── scripts/                    # Deployment helpers
│   └── setup_sparse_checkout.sh
│
├── .gitignore
├── .gitmodules
└── README.md
```

## Sparse Checkout Deployment

Use git sparse-checkout so each machine only has the files it needs:

**On Jetson (edge robot):**

```bash
git clone <repo-url> ~/EW/EW_UGV_SK && cd ~/EW/EW_UGV_SK
bash scripts/setup_sparse_checkout.sh edge
git submodule update --init --recursive
```

**On RTX server (host):**

```bash
git clone <repo-url> ~/EW/EW_UGV_SK && cd ~/EW/EW_UGV_SK
bash scripts/setup_sparse_checkout.sh host
```

**For full-repo development:** just clone normally without running the script.

---

## Edge Setup (Jetson Orin NX)

### Prerequisites

- JetPack 6 / L4T 36.x
- ROS 2 Humble
- ZED SDK 5.x + [ZED GStreamer plugins](https://www.stereolabs.com/docs/gstreamer/zed-camera-source) (`zedsrc`)
- GStreamer 1.20+ with `gst-plugins-bad` (webrtcbin) -- included in JetPack
- Scout Mini with CAN interface (`can1`)

### Install Python deps (uv manages the Python environment)

```bash
# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

cd ~/EW/EW_UGV_SK/edge
uv sync                # creates .venv, installs websockets/msgpack/DracoPy/etc.
```

### Build ROS 2 packages

```bash
cd ~/EW/EW_UGV_SK/edge
source /opt/ros/humble/setup.bash
colcon build
source install/setup.bash
```

### Map the office (one-time)

```bash
ros2 launch eastworld_bringup bringup.launch.py
# Teleop through the office, then Ctrl-C
cp ~/EW/EW_UGV_SK/edge/src/FAST-LIVO2/Log/PCD/all_raw_points.pcd ~/EW/EW_UGV_SK/edge/maps/office_map.pcd
```

### Launch with fleet streaming

```bash
ros2 launch eastworld_bringup bringup.launch.py \
  use_fleet_streaming:=true \
  robot_id:=robot_0 \
  host_url:=ws://192.168.1.100:8800 \
  use_relocalize:=true \
  map_pcd_path:=$HOME/EW_UGV_SK/edge/maps/office_map.pcd
```

Each robot gets a unique `robot_id` (robot_0 through robot_4).

---

## Host Setup (RTX 4090 Server)

### Install (uv manages the Python environment)

```bash
# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

cd ~/EW/EW_UGV_SK/host
uv sync                # creates .venv, installs all deps (server + tools)
```

### Fleet Server

```bash
cd ~/EW/EW_UGV_SK/host
uv run python server/fleet_server.py
# Listening on http://0.0.0.0:8800
```

### Web Viewer

```bash
cd ~/EW/EW_UGV_SK/host/web
npm install
npm run build          # production build -> dist/
# Served automatically by fleet_server at http://host:8800/
```

For development with hot-reload:

```bash
npm run dev            # Vite dev server on :5173, proxies /ws to :8800
```

### Convert PCD Map for Web

```bash
cd ~/EW/EW_UGV_SK/host
uv run python tools/pcd_to_web.py ../edge/maps/office_map.pcd \
  -o web/public/maps/office_map.drc \
  --voxel-size 0.02
```

Open `http://<host-ip>:8800` in a browser to see the fleet viewer.

---

## Data Streams

| Stream | Edge -> Host | Protocol | Compression | Rate |
|--------|-------------|----------|-------------|------|
| Video  | ZED Mini    | WebRTC (H.264) | NVENC hardware | 30 fps |
| Pose   | FAST-LIVO2 TF | WebSocket (msgpack) | None (48 bytes) | 50 Hz |
| Point cloud | /cloud_registered | WebSocket (binary) | Draco + optional zstd | 10 Hz |

Estimated bandwidth per robot: ~3 Mbps (fits 5 robots on 802.11ac).

## TF Tree

```
map
 └── odom               [static identity OR pcd_relocalizer]
      └── base_link     [FAST-LIVO2 @ 50 Hz]
           ├── base_footprint     [URDF]
           ├── lidar_mount_link   [URDF]
           │    ├── imu_link
           │    ├── livox_frame
           │    └── zedm_camera_link
           └── wheel links x4
```
