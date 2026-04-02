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
  const wheelOffsets: Array<[number, number, number]> = [
    [0.28, 0.22, 0.06],   // front-left
    [0.28, -0.22, 0.06],  // front-right
    [-0.28, 0.22, 0.06],  // rear-left
    [-0.28, -0.22, 0.06], // rear-right
  ];

  useFrame(() => {
    if (!groupRef.current || !pose) return;
    groupRef.current.position.set(pose.p[0], pose.p[1], pose.p[2]);
    groupRef.current.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
  });

  if (!pose) return null;

  return (
    <group ref={groupRef}>
      {/* Chassis */}
      <mesh position={[0, 0, 0.16]}>
        <boxGeometry args={[0.68, 0.46, 0.16]} />
        <meshStandardMaterial color={color} transparent opacity={0.9} metalness={0.1} roughness={0.7} />
      </mesh>

      {/* Top deck */}
      <mesh position={[0, 0, 0.26]}>
        <boxGeometry args={[0.42, 0.28, 0.04]} />
        <meshStandardMaterial color="#2a2f38" metalness={0.25} roughness={0.55} />
      </mesh>

      {/* Sensor mast mock */}
      <mesh position={[0.08, 0, 0.34]}>
        <cylinderGeometry args={[0.02, 0.02, 0.16, 12]} />
        <meshStandardMaterial color="#8aa0b5" metalness={0.4} roughness={0.4} />
      </mesh>

      {/* Wheels */}
      {wheelOffsets.map(([x, y, z], i) => (
        <group key={`${robotId}-wheel-${i}`} position={[x, y, z]}>
          <mesh>
            <cylinderGeometry args={[0.1, 0.1, 0.08, 18]} />
            <meshStandardMaterial color="#22262c" roughness={0.95} metalness={0.02} />
          </mesh>
          <mesh>
            <cylinderGeometry args={[0.045, 0.045, 0.082, 14]} />
            <meshStandardMaterial color="#505a66" roughness={0.45} metalness={0.4} />
          </mesh>
        </group>
      ))}

      {/* Heading arrow */}
      <mesh position={[0.42, 0, 0.22]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.06, 0.16, 10]} />
        <meshStandardMaterial color="#f4f7ff" emissive="#6076ff" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}
