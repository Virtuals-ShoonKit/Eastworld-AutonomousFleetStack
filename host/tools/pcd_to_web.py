#!/usr/bin/env python3
"""
Convert a PCD map to a Draco-compressed binary file for Three.js DRACOLoader.

Usage:
  python pcd_to_web.py input.pcd -o ../web/public/maps/office_map.drc
  python pcd_to_web.py input.pcd -o output.drc --voxel-size 0.03 --quant-bits 14

Requires: open3d, DracoPy
  pip install open3d DracoPy
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import DracoPy
import numpy as np


def load_pcd(path: str) -> np.ndarray:
    """Load a PCD file and return Nx3 float32 XYZ array. Uses Open3D."""
    try:
        import open3d as o3d
    except ImportError:
        print("ERROR: open3d is required.  pip install open3d", file=sys.stderr)
        sys.exit(1)

    pcd = o3d.io.read_point_cloud(path)
    print(f"Loaded {len(pcd.points):,} points from {path}")
    return pcd


def main():
    p = argparse.ArgumentParser(description="PCD -> Draco-compressed file for web viewer")
    p.add_argument("input", help="Input PCD file path")
    p.add_argument("-o", "--output", required=True, help="Output .drc file path")
    p.add_argument("--voxel-size", type=float, default=0.02,
                   help="Voxel downsample size in meters (0 = no downsampling)")
    p.add_argument("--quant-bits", type=int, default=14,
                   help="Draco quantization bits for coordinates (8-16)")
    p.add_argument("--compression-level", type=int, default=7,
                   help="Draco compression level (1=fast, 10=best)")
    args = p.parse_args()

    import open3d as o3d

    pcd = load_pcd(args.input)

    if args.voxel_size > 0:
        pcd = pcd.voxel_down_sample(voxel_size=args.voxel_size)
        print(f"After voxel downsample ({args.voxel_size}m): {len(pcd.points):,} points")

    points = np.asarray(pcd.points, dtype=np.float32)

    has_colors = pcd.has_colors()
    colors = None
    if has_colors:
        colors = (np.asarray(pcd.colors) * 255).astype(np.uint8)

    print(f"Encoding with Draco (quant={args.quant_bits}, level={args.compression_level})...")
    draco_bytes = DracoPy.encode(
        points,
        quantization_bits=args.quant_bits,
        compression_level=args.compression_level,
    )

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(draco_bytes)

    raw_size = points.nbytes
    compressed_size = len(draco_bytes)
    ratio = raw_size / compressed_size if compressed_size > 0 else 0
    print(f"Written: {out_path}")
    print(f"  Points:     {len(points):,}")
    print(f"  Raw size:   {raw_size / 1024 / 1024:.1f} MB")
    print(f"  Compressed: {compressed_size / 1024 / 1024:.1f} MB ({ratio:.1f}x)")


if __name__ == "__main__":
    main()
