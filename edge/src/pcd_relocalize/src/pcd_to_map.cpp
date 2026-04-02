#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

#include <pcl/io/pcd_io.h>
#include <pcl/point_cloud.h>
#include <pcl/point_types.h>

struct Args {
  std::string pcd_path;
  std::string output_prefix;  // writes <prefix>.pgm and <prefix>.yaml
  double resolution = 0.05;
  double min_height = 0.10;
  double max_height = 1.5;
  int occupied_thresh_count = 1;
};

static void printUsage(const char* prog) {
  std::cerr
      << "Usage: " << prog << " [options]\n"
      << "  --pcd <path>            Input PCD file (required)\n"
      << "  --output <prefix>       Output prefix for .pgm/.yaml (required)\n"
      << "  --resolution <m>        Grid cell size in metres (default 0.05)\n"
      << "  --min_height <m>        Min Z to include (default 0.10)\n"
      << "  --max_height <m>        Max Z to include (default 1.5)\n"
      << "  --occupied_thresh <n>   Min point hits per cell to mark occupied (default 1)\n";
}

static bool parseArgs(int argc, char** argv, Args& args) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--pcd" && i + 1 < argc)
      args.pcd_path = argv[++i];
    else if (a == "--output" && i + 1 < argc)
      args.output_prefix = argv[++i];
    else if (a == "--resolution" && i + 1 < argc)
      args.resolution = std::stod(argv[++i]);
    else if (a == "--min_height" && i + 1 < argc)
      args.min_height = std::stod(argv[++i]);
    else if (a == "--max_height" && i + 1 < argc)
      args.max_height = std::stod(argv[++i]);
    else if (a == "--occupied_thresh" && i + 1 < argc)
      args.occupied_thresh_count = std::stoi(argv[++i]);
    else if (a == "-h" || a == "--help") {
      printUsage(argv[0]);
      return false;
    } else {
      std::cerr << "Unknown argument: " << a << "\n";
      printUsage(argv[0]);
      return false;
    }
  }
  if (args.pcd_path.empty() || args.output_prefix.empty()) {
    std::cerr << "Error: --pcd and --output are required\n";
    printUsage(argv[0]);
    return false;
  }
  return true;
}

int main(int argc, char** argv) {
  Args args;
  if (!parseArgs(argc, argv, args)) return 1;

  pcl::PointCloud<pcl::PointXYZ> cloud;
  if (pcl::io::loadPCDFile(args.pcd_path, cloud) < 0) {
    std::cerr << "Failed to load PCD: " << args.pcd_path << "\n";
    return 1;
  }
  std::cout << "Loaded " << cloud.size() << " points from " << args.pcd_path << "\n";

  // Filter by height and find XY bounding box
  double xmin = std::numeric_limits<double>::max();
  double xmax = std::numeric_limits<double>::lowest();
  double ymin = std::numeric_limits<double>::max();
  double ymax = std::numeric_limits<double>::lowest();

  std::vector<std::pair<double, double>> filtered_xy;
  filtered_xy.reserve(cloud.size());

  for (const auto& p : cloud.points) {
    if (p.z < args.min_height || p.z > args.max_height) continue;
    if (!std::isfinite(p.x) || !std::isfinite(p.y)) continue;
    filtered_xy.emplace_back(p.x, p.y);
    xmin = std::min(xmin, static_cast<double>(p.x));
    xmax = std::max(xmax, static_cast<double>(p.x));
    ymin = std::min(ymin, static_cast<double>(p.y));
    ymax = std::max(ymax, static_cast<double>(p.y));
  }

  std::cout << "After height filter [" << args.min_height << ", " << args.max_height
            << "]: " << filtered_xy.size() << " points\n";

  if (filtered_xy.empty()) {
    std::cerr << "No points after filtering — check height range\n";
    return 1;
  }

  // Add a small margin
  const double margin = args.resolution * 5;
  xmin -= margin;
  ymin -= margin;
  xmax += margin;
  ymax += margin;

  const int width = static_cast<int>(std::ceil((xmax - xmin) / args.resolution));
  const int height = static_cast<int>(std::ceil((ymax - ymin) / args.resolution));

  std::cout << "Grid: " << width << " x " << height
            << " cells (resolution=" << args.resolution << "m)\n";

  // Rasterize: count hits per cell
  std::vector<int> grid(width * height, 0);
  for (const auto& [x, y] : filtered_xy) {
    int col = static_cast<int>((x - xmin) / args.resolution);
    int row = static_cast<int>((y - ymin) / args.resolution);
    col = std::clamp(col, 0, width - 1);
    row = std::clamp(row, 0, height - 1);
    grid[row * width + col]++;
  }

  // Write PGM (P5 binary)
  // nav2_map_server convention: 0 = occupied (black), 254 = free (white), 205 = unknown (grey)
  // PGM row 0 = top of image = ymax in world coords
  std::string pgm_path = args.output_prefix + ".pgm";
  std::ofstream pgm(pgm_path, std::ios::binary);
  pgm << "P5\n" << width << " " << height << "\n255\n";
  for (int r = height - 1; r >= 0; --r) {
    for (int c = 0; c < width; ++c) {
      int hits = grid[r * width + c];
      uint8_t val;
      if (hits >= args.occupied_thresh_count)
        val = 0;    // occupied
      else
        val = 254;  // free
      pgm.write(reinterpret_cast<const char*>(&val), 1);
    }
  }
  pgm.close();
  std::cout << "Wrote " << pgm_path << "\n";

  // Write YAML (nav2_map_server compatible)
  std::string yaml_path = args.output_prefix + ".yaml";
  // Extract just the filename from prefix for the image field
  std::string pgm_filename = pgm_path;
  auto slash = pgm_filename.rfind('/');
  if (slash != std::string::npos)
    pgm_filename = pgm_filename.substr(slash + 1);

  std::ofstream yaml(yaml_path);
  yaml << "image: " << pgm_filename << "\n"
       << "resolution: " << args.resolution << "\n"
       << "origin: [" << xmin << ", " << ymin << ", 0.0]\n"
       << "negate: 0\n"
       << "occupied_thresh: 0.65\n"
       << "free_thresh: 0.196\n";
  yaml.close();
  std::cout << "Wrote " << yaml_path << "\n";

  return 0;
}
