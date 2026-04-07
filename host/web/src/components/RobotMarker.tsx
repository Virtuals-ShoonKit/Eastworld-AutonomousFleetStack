import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { PoseData } from "../lib/protocol";

const ROBOT_COLORS = [
  "#00d4ff", "#ff6b35", "#7eff3f", "#ff3fdc", "#ffd53f",
];

const WHEEL_RADIUS = 0.1;

interface Props {
  robotId: string;
  index: number;
  pose: PoseData | null;
}

export function RobotMarker({ robotId, index, pose }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const color = ROBOT_COLORS[index % ROBOT_COLORS.length];
  const wheelOffsets: Array<[number, number, number]> = [
    [0.28,  0.22, WHEEL_RADIUS],
    [0.28, -0.22, WHEEL_RADIUS],
    [-0.28,  0.22, WHEEL_RADIUS],
    [-0.28, -0.22, WHEEL_RADIUS],
  ];

  useFrame(() => {
    if (!groupRef.current || !pose) return;
    // Ground robot: clamp Z to 0 so wheels sit on the grid plane.
    // Only XY + yaw from the SLAM pose are used for positioning.
    groupRef.current.position.set(pose.p[0], pose.p[1], 0);
    groupRef.current.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
  });

  if (!pose) return null;

  return (
    <group ref={groupRef}>
      {/* ID label — no distanceFactor so it stays readable at any zoom */}
      <Html
        position={[0, 0, 0.55]}
        center
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 9px 3px 7px",
            borderRadius: 5,
            background: "rgba(5, 8, 14, 0.82)",
            border: `1px solid ${color}55`,
            boxShadow: `0 0 8px ${color}22, 0 2px 8px rgba(0,0,0,0.5)`,
            whiteSpace: "nowrap",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 12,
            fontWeight: 600,
            color: "#e8edf5",
            letterSpacing: 0.3,
            backdropFilter: "blur(6px)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 6px ${color}`,
              flexShrink: 0,
              animation: "pulse-dot 2s ease-in-out infinite",
            }}
          />
          {robotId}
        </div>
        <style>{`
          @keyframes pulse-dot {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>
      </Html>

      {/* Model built from ground level (Z=0 = grid plane) */}

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

      {/* Sensor mast */}
      <mesh position={[0.08, 0, 0.34]}>
        <cylinderGeometry args={[0.02, 0.02, 0.16, 12]} />
        <meshStandardMaterial color="#8aa0b5" metalness={0.4} roughness={0.4} />
      </mesh>

      {/* Wheels */}
      {wheelOffsets.map(([x, y, z], i) => (
        <group key={`${robotId}-wheel-${i}`} position={[x, y, z]}>
          <mesh>
            <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.08, 18]} />
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
