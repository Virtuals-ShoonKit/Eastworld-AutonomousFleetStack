import { useEffect, useRef, useMemo, useCallback } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { CloudData } from "../lib/protocol";
import type { RobotState, PoseMapRef } from "../hooks/useFleetSocket";

const DRACO_DECODER_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
const LIVE_TRAIL_FADE_START_MS = 5_000;
const LIVE_TRAIL_FADE_END_MS = 10_000;
const LIVE_TRAIL_MAX_SNAPSHOTS = 40;
const LIVE_CLOUD_RANGE_M = 10;
const LIVE_CLOUD_RANGE_M2 = LIVE_CLOUD_RANGE_M * LIVE_CLOUD_RANGE_M;

/**
 * Upper bound for points per decoded Draco snapshot.  Pre-allocated once
 * at mount time so the GPU driver never has to alloc/dealloc vertex
 * buffers on the hot path.  65 536 * 3 floats = 768 KiB per slot,
 * 40 slots = ~30 MiB total — well within budget.
 */
const MAX_POINTS_PER_SLOT = 65_536;

interface Props {
  mapUrl?: string;
  onCloudRegister: (cb: (cloud: CloudData) => void) => () => void;
  robots: Map<string, RobotState>;
  poseMapRef: PoseMapRef;
  pointCloudColor: string;
  mapZOffset: number;
}

function robotIdToColor(id: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.62);
}

// ── Ring-buffer slot ────────────────────────────────────────────────────
interface RingSlot {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  posArray: Float32Array;
  robotId: string | null;
  createdAtMs: number;
  active: boolean;
}

/**
 * Copy positions from decoded Draco geometry into a pre-allocated
 * Float32Array, optionally filtering by distance from robot pose.
 * Returns the number of points actually written.
 */
function filterAndCopy(
  src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  dst: Float32Array,
  center: [number, number, number] | null,
  cap: number,
): number {
  const doFilter = center !== null;
  const cx = center ? center[0] : 0;
  const cy = center ? center[1] : 0;
  const cz = center ? center[2] : 0;
  let w = 0;

  for (let i = 0, n = src.count; i < n && w < cap; i++) {
    const x = src.getX(i);
    const y = src.getY(i);
    const z = src.getZ(i);
    if (doFilter) {
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      if (dx * dx + dy * dy + dz * dz > LIVE_CLOUD_RANGE_M2) continue;
    }
    const off = w * 3;
    dst[off] = x;
    dst[off + 1] = y;
    dst[off + 2] = z;
    w++;
  }
  return w;
}

// ── Component ───────────────────────────────────────────────────────────
export function PointCloudLayer({
  mapUrl,
  onCloudRegister,
  robots,
  poseMapRef,
  pointCloudColor,
  mapZOffset,
}: Props) {
  const mapPointsRef = useRef<THREE.Points | null>(null);
  const liveLayerRef = useRef<THREE.Group | null>(null);
  const robotsRef = useRef(robots);
  const { camera, controls } = useThree();

  const ringRef = useRef<RingSlot[]>([]);
  const writeIdxRef = useRef(0);

  useEffect(() => {
    robotsRef.current = robots;
  }, [robots]);

  useEffect(() => {
    if (mapPointsRef.current?.material instanceof THREE.PointsMaterial) {
      mapPointsRef.current.material.color.set(pointCloudColor);
      mapPointsRef.current.material.needsUpdate = true;
    }
  }, [pointCloudColor]);

  // WASM decoder + eager preload (was JS before)
  const dracoLoader = useMemo(() => {
    const loader = new DRACOLoader();
    loader.setDecoderPath(DRACO_DECODER_PATH);
    loader.setDecoderConfig({ type: "wasm" });
    loader.preload();
    return loader;
  }, []);

  // ── Pre-allocate ring of GPU buffers once at mount ──────────────────
  useEffect(() => {
    const group = liveLayerRef.current;
    if (!group) return;

    const slots: RingSlot[] = [];
    for (let i = 0; i < LIVE_TRAIL_MAX_SNAPSHOTS; i++) {
      const posArray = new Float32Array(MAX_POINTS_PER_SLOT * 3);
      const geometry = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(posArray, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", attr);
      geometry.setDrawRange(0, 0);

      const material = new THREE.PointsMaterial({
        size: 0.06,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });

      const pts = new THREE.Points(geometry, material);
      pts.frustumCulled = false;
      pts.visible = false;
      group.add(pts);

      slots.push({
        points: pts,
        geometry,
        material,
        posArray,
        robotId: null,
        createdAtMs: 0,
        active: false,
      });
    }

    ringRef.current = slots;
    writeIdxRef.current = 0;

    return () => {
      for (const s of slots) {
        group.remove(s.points);
        s.geometry.dispose();
        s.material.dispose();
      }
      ringRef.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fitCameraToGeometry = useCallback(
    (geometry: THREE.BufferGeometry) => {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere!;
      const center = sphere.center;
      const radius = sphere.radius;

      camera.position.set(
        center.x - radius * 0.3,
        center.y,
        center.z + radius * 1.5,
      );
      camera.lookAt(center.x, center.y, center.z);
      camera.updateProjectionMatrix();

      if (controls && "target" in controls) {
        (controls as any).target.set(center.x, center.y, center.z);
        (controls as any).update();
      }

      console.log(
        `Map loaded: ${geometry.attributes.position.count.toLocaleString()} pts, ` +
          `center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}), ` +
          `radius=${radius.toFixed(1)}`,
      );
    },
    [camera, controls],
  );

  // ── Static map ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapUrl) return;
    console.log("Loading map from:", mapUrl);

    dracoLoader.load(
      mapUrl,
      (geometry: THREE.BufferGeometry) => {
        if (mapPointsRef.current) {
          mapPointsRef.current.geometry.dispose();
          mapPointsRef.current.geometry = geometry;
          fitCameraToGeometry(geometry);
        }
      },
      (progress: ProgressEvent<EventTarget>) => {
        if (progress.total > 0) {
          console.log(
            `Map loading: ${((progress.loaded / progress.total) * 100).toFixed(0)}%`,
          );
        }
      },
      (error: unknown) => {
        console.error("Failed to load map .drc file:", error);
        console.error("URL was:", mapUrl);
      },
    );
  }, [mapUrl, dracoLoader, fitCameraToGeometry]);

  // ── Live cloud subscription (hot path) ──────────────────────────────
  useEffect(() => {
    const unsubscribe = onCloudRegister((cloud: CloudData) => {
      const ring = ringRef.current;
      if (!liveLayerRef.current || ring.length === 0) return;

      const u8 = new Uint8Array(cloud.d as ArrayLike<number>);
      const blob = new Blob([u8.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);

      dracoLoader.load(
        url,
        (decoded: THREE.BufferGeometry) => {
          const idx = writeIdxRef.current % ring.length;
          writeIdxRef.current += 1;
          const slot = ring[idx];

          const srcPos = decoded.getAttribute("position");
          const pose = poseMapRef.current.get(cloud.r);
          const count = filterAndCopy(
            srcPos,
            slot.posArray,
            pose ? pose.p : null,
            MAX_POINTS_PER_SLOT,
          );

          // Update existing GPU buffer in-place — zero allocation
          const attr = slot.geometry.getAttribute(
            "position",
          ) as THREE.BufferAttribute;
          attr.needsUpdate = true;
          slot.geometry.setDrawRange(0, count);

          slot.material.color.copy(robotIdToColor(cloud.r));
          slot.material.opacity = 0.9;
          slot.robotId = cloud.r;
          slot.createdAtMs = Date.now();
          slot.active = true;
          slot.points.visible = true;

          decoded.dispose();
          URL.revokeObjectURL(url);
        },
        undefined,
        () => URL.revokeObjectURL(url),
      );
    });

    return () => {
      unsubscribe();
      for (const s of ringRef.current) {
        s.active = false;
        s.points.visible = false;
        s.geometry.setDrawRange(0, 0);
      }
    };
  }, [dracoLoader, onCloudRegister]);

  // ── Per-frame: fade & expire (no allocations) ───────────────────────
  useFrame(() => {
    const now = Date.now();
    const activeIds = new Set(robotsRef.current.keys());

    for (const slot of ringRef.current) {
      if (!slot.active) continue;

      if (!activeIds.has(slot.robotId!)) {
        slot.active = false;
        slot.points.visible = false;
        slot.geometry.setDrawRange(0, 0);
        continue;
      }

      const age = now - slot.createdAtMs;
      if (age >= LIVE_TRAIL_FADE_END_MS) {
        slot.active = false;
        slot.points.visible = false;
        slot.geometry.setDrawRange(0, 0);
        continue;
      }

      if (age <= LIVE_TRAIL_FADE_START_MS) {
        slot.material.opacity = 0.9;
      } else {
        const t =
          (age - LIVE_TRAIL_FADE_START_MS) /
          (LIVE_TRAIL_FADE_END_MS - LIVE_TRAIL_FADE_START_MS);
        slot.material.opacity = 0.9 * (1 - t);
      }
    }
  });

  return (
    <group position={[0, 0, mapZOffset]}>
      <points ref={mapPointsRef}>
        <bufferGeometry />
        <pointsMaterial
          size={0.05}
          vertexColors={false}
          color={pointCloudColor}
          sizeAttenuation
        />
      </points>
      <group ref={liveLayerRef} />
    </group>
  );
}
