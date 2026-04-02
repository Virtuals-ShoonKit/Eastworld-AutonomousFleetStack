import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PoseData } from "../lib/protocol";

const ROBOT_COLORS = [
  "#00d4ff", "#ff6b35", "#7eff3f", "#ff3fdc", "#ffd53f",
];

interface Props {
  robotId: string;
  index: number;
  pose: PoseData | null;
}

export function RobotMarker({ robotId, index, pose }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const color = ROBOT_COLORS[index % ROBOT_COLORS.length];

  useFrame(() => {
    if (!groupRef.current || !pose) return;
    groupRef.current.position.set(pose.p[0], pose.p[1], pose.p[2]);
    groupRef.current.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
  });

  if (!pose) return null;

  return (
    <group ref={groupRef}>
      {/* Body */}
      <mesh>
        <boxGeometry args={[0.5, 0.3, 0.2]} />
        <meshStandardMaterial color={color} transparent opacity={0.85} />
      </mesh>
      {/* Direction arrow */}
      <mesh position={[0.35, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.1, 0.2, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Label */}
      <sprite position={[0, 0, 0.4]} scale={[0.8, 0.2, 1]}>
        <spriteMaterial color={color} />
      </sprite>
    </group>
  );
}
