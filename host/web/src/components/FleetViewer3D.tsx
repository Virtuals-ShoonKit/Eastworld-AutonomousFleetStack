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
  backgroundColor: string;
  pointCloudColor: string;
  gridColor: string;
  randomizeLiveCloud: boolean;
  showOriginAxes: boolean;
  originAxesLength: number;
  originAxesThickness: number;
  mapZOffset: number;
}

interface OriginAxesMarkerProps {
  length: number;
  thickness: number;
}

function OriginAxesMarker({ length, thickness }: OriginAxesMarkerProps) {
  const headLength = Math.max(thickness * 4, 0.08);
  const headRadius = Math.max(thickness * 2, 0.04);
  return (
    <group>
      <mesh position={[length / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[thickness, thickness, length, 12]} />
        <meshStandardMaterial color="#ff4a4a" />
      </mesh>
      <mesh position={[length + headLength / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[headRadius, headLength, 16]} />
        <meshStandardMaterial color="#ff4a4a" />
      </mesh>

      <mesh position={[0, length / 2, 0]}>
        <cylinderGeometry args={[thickness, thickness, length, 12]} />
        <meshStandardMaterial color="#4aff4a" />
      </mesh>
      <mesh position={[0, length + headLength / 2, 0]}>
        <coneGeometry args={[headRadius, headLength, 16]} />
        <meshStandardMaterial color="#4aff4a" />
      </mesh>

      <mesh position={[0, 0, length / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[thickness, thickness, length, 12]} />
        <meshStandardMaterial color="#4a7dff" />
      </mesh>
      <mesh position={[0, 0, length + headLength / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[headRadius, headLength, 16]} />
        <meshStandardMaterial color="#4a7dff" />
      </mesh>

      <mesh>
        <sphereGeometry args={[Math.max(thickness * 1.2, 0.02), 16, 16]} />
        <meshStandardMaterial color="#d9ecff" />
      </mesh>
    </group>
  );
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
  originAxesThickness,
  mapZOffset,
}: Props) {
  const robotEntries = Array.from(robots.entries());

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
      {showOriginAxes && (
        <OriginAxesMarker length={originAxesLength} thickness={originAxesThickness} />
      )}

      <PointCloudLayer
        mapUrl={mapUrl}
        onCloudRegister={onCloudRegister}
        robots={robots}
        pointCloudColor={pointCloudColor}
        randomizeLiveCloud={randomizeLiveCloud}
        mapZOffset={mapZOffset}
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
