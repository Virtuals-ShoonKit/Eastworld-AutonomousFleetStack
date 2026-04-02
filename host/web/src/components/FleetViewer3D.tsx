import { useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import * as THREE from "three";
import { RobotMarker } from "./RobotMarker";
import { PointCloudLayer } from "./PointCloudLayer";
import type { RobotState } from "../hooks/useFleetSocket";
import type { CloudData } from "../lib/protocol";

interface Props {
  robots: Map<string, RobotState>;
  mapUrl?: string;
  onCloudRegister: (cb: (cloud: CloudData) => void) => () => void;
  backgroundColor: string;
  pointCloudColor: string;
  gridColor: string;
  randomizeLiveCloud: boolean;
  showOriginAxes: boolean;
  originAxesLength: number;
}

export function FleetViewer3D({
  robots,
  mapUrl,
  onCloudRegister,
  backgroundColor,
  pointCloudColor,
  gridColor,
  randomizeLiveCloud,
  showOriginAxes,
  originAxesLength,
}: Props) {
  const robotEntries = Array.from(robots.entries());
  const originAxesHelper = useMemo(() => new THREE.AxesHelper(originAxesLength), [originAxesLength]);

  useEffect(() => {
    return () => {
      originAxesHelper.geometry.dispose();
      if (Array.isArray(originAxesHelper.material)) {
        for (const material of originAxesHelper.material) {
          material.dispose();
        }
      } else {
        originAxesHelper.material.dispose();
      }
    };
  }, [originAxesHelper]);

  return (
    <Canvas
      camera={{ position: [5, -10, 40], fov: 60, near: 0.1, far: 1000, up: [0, 0, 1] }}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[backgroundColor]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 10, 20]} intensity={0.6} />

      <Grid
        args={[200, 200]}
        cellSize={1}
        cellThickness={0.5}
        cellColor={gridColor}
        sectionSize={5}
        sectionThickness={1}
        sectionColor={gridColor}
        fadeDistance={80}
        infiniteGrid
        rotation={[Math.PI / 2, 0, 0]}
      />
      {showOriginAxes && <primitive object={originAxesHelper} />}

      <PointCloudLayer
        mapUrl={mapUrl}
        onCloudRegister={onCloudRegister}
        robots={robots}
        pointCloudColor={pointCloudColor}
        randomizeLiveCloud={randomizeLiveCloud}
      />

      {robotEntries.map(([id, state], idx) => (
        <RobotMarker key={id} robotId={id} index={idx} pose={state.pose} />
      ))}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        maxPolarAngle={Math.PI}
      />
    </Canvas>
  );
}
