import { useEffect, useRef, useMemo, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { CloudData } from "../lib/protocol";
import type { RobotState } from "../hooks/useFleetSocket";

const DRACO_DECODER_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
const LIVE_TRAIL_FADE_START_MS = 5_000;
const LIVE_TRAIL_FADE_END_MS = 10_000;
const LIVE_TRAIL_MAX_SNAPSHOTS = 40;
const LIVE_CLOUD_RANGE_M = 10;
const LIVE_CLOUD_RANGE_M2 = LIVE_CLOUD_RANGE_M * LIVE_CLOUD_RANGE_M;

interface Props {
  mapUrl?: string;
  onCloudRegister: (cb: (cloud: CloudData) => void) => () => void;
  robots: Map<string, RobotState>;
  pointCloudColor: string;
  mapZOffset: number;
}

function robotIdToColor(id: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.62);
}

interface LiveCloudSnapshot {
  robotId: string;
  points: THREE.Points;
  material: THREE.PointsMaterial;
  createdAtMs: number;
}

function filterCloudByRange(
  geometry: THREE.BufferGeometry,
  center: [number, number, number]
): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return geometry;

  const cx = center[0];
  const cy = center[1];
  const cz = center[2];
  const kept: number[] = [];

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    if (dx * dx + dy * dy + dz * dz <= LIVE_CLOUD_RANGE_M2) {
      kept.push(x, y, z);
    }
  }

  const filtered = new THREE.BufferGeometry();
  filtered.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  geometry.dispose();
  return filtered;
}

export function PointCloudLayer({
  mapUrl,
  onCloudRegister,
  robots,
  pointCloudColor,
  mapZOffset,
}: Props) {
  const mapPointsRef = useRef<THREE.Points | null>(null);
  const liveLayerRef = useRef<THREE.Group | null>(null);
  const liveSnapshotsRef = useRef<LiveCloudSnapshot[]>([]);
  const robotsRef = useRef(robots);
  const { camera, controls } = useThree();

  useEffect(() => {
    robotsRef.current = robots;
  }, [robots]);

  useEffect(() => {
    if (mapPointsRef.current?.material instanceof THREE.PointsMaterial) {
      mapPointsRef.current.material.color.set(pointCloudColor);
      mapPointsRef.current.material.needsUpdate = true;
    }
  }, [pointCloudColor]);

  const dracoLoader = useMemo(() => {
    const loader = new DRACOLoader();
    loader.setDecoderPath(DRACO_DECODER_PATH);
    loader.setDecoderConfig({ type: "js" });
    return loader;
  }, []);

  const fitCameraToGeometry = useCallback(
    (geometry: THREE.BufferGeometry) => {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const box = geometry.boundingBox!;
      const sphere = geometry.boundingSphere!;
      const center = sphere.center;
      const radius = sphere.radius;

      // Top-down view with some tilt for 3D perspective
      camera.position.set(center.x, center.y - radius * 0.3, center.z + radius * 1.5);
      camera.lookAt(center.x, center.y, center.z);
      camera.updateProjectionMatrix();

      if (controls && "target" in controls) {
        (controls as any).target.set(center.x, center.y, center.z);
        (controls as any).update();
      }

      console.log(
        `Map loaded: ${(geometry.attributes.position.count).toLocaleString()} points, ` +
        `center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}), ` +
        `radius=${radius.toFixed(1)}`
      );
    },
    [camera, controls]
  );

  // Load static map
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
          console.log(`Map loading: ${((progress.loaded / progress.total) * 100).toFixed(0)}%`);
        }
      },
      (error: unknown) => {
        console.error("Failed to load map .drc file:", error);
        console.error("URL was:", mapUrl);
      }
    );
  }, [mapUrl, dracoLoader, fitCameraToGeometry]);

  // Subscribe to live cloud updates
  useEffect(() => {
    const unsubscribe = onCloudRegister((cloud: CloudData) => {
      if (!liveLayerRef.current) return;
      const u8 = new Uint8Array(cloud.d as ArrayLike<number>);
      const blob = new Blob([u8.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      dracoLoader.load(
        url,
        (geometry: THREE.BufferGeometry) => {
          const pose = robotsRef.current.get(cloud.r)?.pose;
          const filteredGeometry = pose
            ? filterCloudByRange(geometry, pose.p)
            : geometry;
          const liveColor = robotIdToColor(cloud.r);
          const material = new THREE.PointsMaterial({
            size: 0.06,
            color: liveColor,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
          });
          const points = new THREE.Points(filteredGeometry, material);
          liveLayerRef.current!.add(points);
          liveSnapshotsRef.current.push({
            robotId: cloud.r,
            points,
            material,
            createdAtMs: Date.now(),
          });

          if (liveSnapshotsRef.current.length > LIVE_TRAIL_MAX_SNAPSHOTS) {
            const old = liveSnapshotsRef.current.shift();
            if (old) {
              liveLayerRef.current!.remove(old.points);
              old.points.geometry.dispose();
              old.material.dispose();
            }
          }
          URL.revokeObjectURL(url);
        },
        undefined,
        () => {
          URL.revokeObjectURL(url);
        }
      );
    });
    return () => {
      unsubscribe();
      for (const snap of liveSnapshotsRef.current) {
        liveLayerRef.current?.remove(snap.points);
        snap.points.geometry.dispose();
        snap.material.dispose();
      }
      liveSnapshotsRef.current = [];
    };
  }, [dracoLoader, onCloudRegister]);

  useFrame(() => {
    const now = Date.now();
    const next: LiveCloudSnapshot[] = [];
    const activeRobotIds = new Set(robotsRef.current.keys());

    for (const snap of liveSnapshotsRef.current) {
      if (!activeRobotIds.has(snap.robotId)) {
        liveLayerRef.current?.remove(snap.points);
        snap.points.geometry.dispose();
        snap.material.dispose();
        continue;
      }

      const ageMs = now - snap.createdAtMs;
      if (ageMs >= LIVE_TRAIL_FADE_END_MS) {
        liveLayerRef.current?.remove(snap.points);
        snap.points.geometry.dispose();
        snap.material.dispose();
        continue;
      }

      if (ageMs <= LIVE_TRAIL_FADE_START_MS) {
        snap.material.opacity = 0.9;
      } else {
        const t =
          (ageMs - LIVE_TRAIL_FADE_START_MS) /
          (LIVE_TRAIL_FADE_END_MS - LIVE_TRAIL_FADE_START_MS);
        snap.material.opacity = 0.9 * (1 - t);
      }
      next.push(snap);
    }

    liveSnapshotsRef.current = next;
  });

  return (
    <group position={[0, 0, mapZOffset]}>
      {/* Static map */}
      <points ref={mapPointsRef}>
        <bufferGeometry />
        <pointsMaterial
          size={0.05}
          vertexColors={false}
          color={pointCloudColor}
          sizeAttenuation
        />
      </points>
      {/* Live scan overlay with short persistence trail */}
      <group ref={liveLayerRef} />
    </group>
  );
}
