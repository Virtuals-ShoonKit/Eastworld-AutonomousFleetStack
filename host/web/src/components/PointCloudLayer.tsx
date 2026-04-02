import { useEffect, useRef, useMemo, useCallback } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { CloudData } from "../lib/protocol";

const DRACO_DECODER_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";

interface Props {
  mapUrl?: string;
  onCloudRegister: (cb: (cloud: CloudData) => void) => () => void;
}

export function PointCloudLayer({ mapUrl, onCloudRegister }: Props) {
  const mapPointsRef = useRef<THREE.Points | null>(null);
  const livePointsRef = useRef<THREE.Points | null>(null);
  const { camera, controls } = useThree();

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
      (geometry) => {
        if (mapPointsRef.current) {
          mapPointsRef.current.geometry.dispose();
          mapPointsRef.current.geometry = geometry;
          fitCameraToGeometry(geometry);
        }
      },
      (progress) => {
        if (progress.total > 0) {
          console.log(`Map loading: ${((progress.loaded / progress.total) * 100).toFixed(0)}%`);
        }
      },
      (error) => {
        console.error("Failed to load map .drc file:", error);
        console.error("URL was:", mapUrl);
      }
    );
  }, [mapUrl, dracoLoader, fitCameraToGeometry]);

  // Subscribe to live cloud updates
  useEffect(() => {
    const unsubscribe = onCloudRegister((cloud: CloudData) => {
      if (!livePointsRef.current) return;
      const u8 = new Uint8Array(cloud.d as ArrayLike<number>);
      const blob = new Blob([u8.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      dracoLoader.load(url, (geometry) => {
        livePointsRef.current!.geometry.dispose();
        livePointsRef.current!.geometry = geometry;
        URL.revokeObjectURL(url);
      });
    });
    return unsubscribe;
  }, [dracoLoader, onCloudRegister]);

  return (
    <>
      {/* Static map */}
      <points ref={mapPointsRef}>
        <bufferGeometry />
        <pointsMaterial
          size={0.05}
          vertexColors={false}
          color="#7799bb"
          sizeAttenuation
        />
      </points>
      {/* Live scan overlay */}
      <points ref={livePointsRef}>
        <bufferGeometry />
        <pointsMaterial
          size={0.06}
          vertexColors={false}
          color="#00ff88"
          sizeAttenuation
          transparent
          opacity={0.8}
        />
      </points>
    </>
  );
}
