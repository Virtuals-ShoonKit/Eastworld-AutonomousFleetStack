import { useRef, useMemo, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PoseData } from "../lib/protocol";
import type { RobotState, PoseMapRef } from "../hooks/useFleetSocket";

const MAX_ROBOTS = 16;
const WHEEL_RADIUS = 0.1;

const ROBOT_COLORS = [
  "#00d4ff", "#ff6b35", "#7eff3f", "#ff3fdc", "#ffd53f",
];

const WHEEL_OFFSETS: [number, number, number][] = [
  [0.28,  0.22, WHEEL_RADIUS],
  [0.28, -0.22, WHEEL_RADIUS],
  [-0.28,  0.22, WHEEL_RADIUS],
  [-0.28, -0.22, WHEEL_RADIUS],
];

// Scratch objects reused every frame to avoid allocations
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _col = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// ── Geometry factory (called once via useMemo) ──────────────────────────
function buildRobotGeometries() {
  // Chassis — per-instance color
  const chassis = new THREE.BoxGeometry(0.68, 0.46, 0.16).translate(0, 0, 0.16);

  // Dark body: top deck + wheel tires
  const darkParts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(0.42, 0.28, 0.04).translate(0, 0, 0.26),
  ];
  for (const [x, y, z] of WHEEL_OFFSETS) {
    darkParts.push(
      new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.08, 18).translate(x, y, z),
    );
  }
  const dark = mergeGeometries(darkParts, false)!;
  darkParts.forEach((g) => g.dispose());

  // Metal accents: sensor mast + wheel hubs
  const metalParts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.02, 0.02, 0.16, 12).translate(0.08, 0, 0.34),
  ];
  for (const [x, y, z] of WHEEL_OFFSETS) {
    metalParts.push(
      new THREE.CylinderGeometry(0.045, 0.045, 0.082, 14).translate(x, y, z),
    );
  }
  const metal = mergeGeometries(metalParts, false)!;
  metalParts.forEach((g) => g.dispose());

  // Heading arrow
  const arrow = new THREE.ConeGeometry(0.06, 0.16, 10)
    .rotateZ(-Math.PI / 2)
    .translate(0.42, 0, 0.22);

  return { chassis, dark, metal, arrow };
}

// ── Per-robot HTML label (lightweight, no geometry) ─────────────────────
function RobotLabel({
  robotId,
  index,
  poseMapRef,
}: {
  robotId: string;
  index: number;
  poseMapRef: PoseMapRef;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const color = ROBOT_COLORS[index % ROBOT_COLORS.length];

  useFrame(() => {
    if (!groupRef.current) return;
    const pose = poseMapRef.current.get(robotId);
    if (!pose) return;
    groupRef.current.position.set(pose.p[0], pose.p[1], 0);
  });

  return (
    <group ref={groupRef}>
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
    </group>
  );
}

// ── Main fleet component ────────────────────────────────────────────────
interface Props {
  robots: Map<string, RobotState>;
  poseMapRef: PoseMapRef;
}

export function RobotFleet({ robots, poseMapRef }: Props) {
  const geos = useMemo(() => buildRobotGeometries(), []);

  const chassisMat = useMemo(
    () => new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.9, metalness: 0.1, roughness: 0.7 }),
    [],
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#252830", metalness: 0.1, roughness: 0.75 }),
    [],
  );
  const metalMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#687888", metalness: 0.4, roughness: 0.42 }),
    [],
  );
  const arrowMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#f4f7ff", emissive: "#6076ff", emissiveIntensity: 0.35 }),
    [],
  );

  const chassisRef = useRef<THREE.InstancedMesh>(null);
  const darkRef = useRef<THREE.InstancedMesh>(null);
  const metalRef = useRef<THREE.InstancedMesh>(null);
  const arrowRef = useRef<THREE.InstancedMesh>(null);

  const robotsRef = useRef(robots);
  useEffect(() => { robotsRef.current = robots; }, [robots]);

  // Dispose GPU resources on unmount
  useEffect(() => {
    const { chassis, dark, metal, arrow } = geos;
    const mats = [chassisMat, darkMat, metalMat, arrowMat];
    return () => {
      chassis.dispose();
      dark.dispose();
      metal.dispose();
      arrow.dispose();
      mats.forEach((m) => m.dispose());
    };
  }, [geos, chassisMat, darkMat, metalMat, arrowMat]);

  useFrame(() => {
    const entries = Array.from(robotsRef.current.keys());
    const n = Math.min(entries.length, MAX_ROBOTS);
    const meshes = [chassisRef.current, darkRef.current, metalRef.current, arrowRef.current];

    for (let i = 0; i < n; i++) {
      const id = entries[i];
      const pose = poseMapRef.current.get(id);

      if (pose) {
        _quat.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
        _mat4.makeRotationFromQuaternion(_quat);
        _mat4.setPosition(pose.p[0], pose.p[1], 0);
      } else {
        _mat4.copy(_zero);
      }

      for (const m of meshes) m?.setMatrixAt(i, _mat4);
      chassisRef.current?.setColorAt(i, _col.set(ROBOT_COLORS[i % ROBOT_COLORS.length]));
    }

    for (const m of meshes) {
      if (!m) continue;
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (chassisRef.current?.instanceColor) {
      chassisRef.current.instanceColor.needsUpdate = true;
    }
  });

  const robotEntries = Array.from(robots.entries());

  return (
    <group>
      <instancedMesh ref={chassisRef} args={[geos.chassis, chassisMat, MAX_ROBOTS]} frustumCulled={false} />
      <instancedMesh ref={darkRef} args={[geos.dark, darkMat, MAX_ROBOTS]} frustumCulled={false} />
      <instancedMesh ref={metalRef} args={[geos.metal, metalMat, MAX_ROBOTS]} frustumCulled={false} />
      <instancedMesh ref={arrowRef} args={[geos.arrow, arrowMat, MAX_ROBOTS]} frustumCulled={false} />

      {robotEntries.map(([id], idx) => (
        <RobotLabel key={id} robotId={id} index={idx} poseMapRef={poseMapRef} />
      ))}
    </group>
  );
}
