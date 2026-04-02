import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { RobotMarker } from "./RobotMarker";
import { PointCloudLayer } from "./PointCloudLayer";
import type { RobotState } from "../hooks/useFleetSocket";
import type { CloudData } from "../lib/protocol";

interface Props {
  robots: Map<string, RobotState>;
  mapUrl?: string;
  onCloudRegister: (cb: (cloud: CloudData) => void) => () => void;
}

export function FleetViewer3D({ robots, mapUrl, onCloudRegister }: Props) {
  const robotEntries = Array.from(robots.entries());

  return (
    <Canvas
      camera={{ position: [5, -10, 40], fov: 60, near: 0.1, far: 1000, up: [0, 0, 1] }}
      style={{ width: "100%", height: "100%" }}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 10, 20]} intensity={0.6} />

      <Grid
        args={[200, 200]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#1a1a2e"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#2a2a4e"
        fadeDistance={80}
        infiniteGrid
        rotation={[Math.PI / 2, 0, 0]}
      />

      <PointCloudLayer mapUrl={mapUrl} onCloudRegister={onCloudRegister} />

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
