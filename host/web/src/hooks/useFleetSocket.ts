import { useEffect, useRef, useCallback, useState } from "react";
import { parseMessage, MsgType, PoseData, CloudData, FleetState, TelemetryData } from "../lib/protocol";

const STALE_ROBOT_TIMEOUT_MS = 15_000;
const STALE_SWEEP_INTERVAL_MS = 2_000;
const POSE_STATE_THROTTLE_MS = 200;

export type PoseMapRef = React.MutableRefObject<Map<string, PoseData>>;

export interface RobotState {
  robot_id: string;
  connected: boolean;
  alive: boolean;
  hardware: string;
  pose: PoseData | null;
  lastUpdateMs: number;
  battery_voltage: number | null;
  battery_pct: number | null;
  cpu_pct: number | null;
  gpu_pct: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
}

export function useFleetSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [robots, setRobots] = useState<Map<string, RobotState>>(new Map());
  const poseCallbacks = useRef<Set<(pose: PoseData) => void>>(new Set());
  const cloudCallbacks = useRef<Set<(cloud: CloudData) => void>>(new Set());

  // Real-time pose data readable from useFrame (no re-renders)
  const poseMapRef = useRef<Map<string, PoseData>>(new Map());
  // Timestamps for stale detection — outside React state
  const cloudTsRef = useRef<Map<string, number>>(new Map());
  const poseTsRef = useRef<Map<string, number>>(new Map());
  // Tracks when we last flushed a POSE into React state (per robot)
  const poseStateTsRef = useRef<Map<string, number>>(new Map());

  const onPose = useCallback((cb: (p: PoseData) => void) => {
    poseCallbacks.current.add(cb);
    return () => { poseCallbacks.current.delete(cb); };
  }, []);

  const onCloud = useCallback((cb: (c: CloudData) => void) => {
    cloudCallbacks.current.add(cb);
    return () => { cloudCallbacks.current.delete(cb); };
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const { type, payload } = parseMessage(ev.data);

        if (type === MsgType.POSE) {
          const pose = payload as PoseData;
          const now = Date.now();

          // Always write to ref — Three.js reads this every frame
          poseMapRef.current.set(pose.r, pose);
          poseTsRef.current.set(pose.r, now);
          poseCallbacks.current.forEach((cb) => cb(pose));

          // Throttle React state updates: only flush when the robot is new
          // or enough time has elapsed (keeps sidebar text fresh at ~5 Hz).
          const lastFlush = poseStateTsRef.current.get(pose.r);
          if (lastFlush === undefined || now - lastFlush >= POSE_STATE_THROTTLE_MS) {
            poseStateTsRef.current.set(pose.r, now);
            setRobots((prev) => {
              const next = new Map(prev);
              const existing = next.get(pose.r);
              next.set(pose.r, {
                robot_id: pose.r,
                connected: existing?.connected ?? true,
                alive: true,
                hardware: existing?.hardware ?? "orin_nx",
                pose,
                lastUpdateMs: now,
                battery_voltage: existing?.battery_voltage ?? null,
                battery_pct: existing?.battery_pct ?? null,
                cpu_pct: existing?.cpu_pct ?? null,
                gpu_pct: existing?.gpu_pct ?? null,
                mem_used_mb: existing?.mem_used_mb ?? null,
                mem_total_mb: existing?.mem_total_mb ?? null,
              });
              return next;
            });
          }
        } else if (type === MsgType.CLOUD) {
          const cloud = payload as CloudData;
          cloudTsRef.current.set(cloud.r, Date.now());
          cloudCallbacks.current.forEach((cb) => cb(cloud));
        } else if (type === MsgType.TELEMETRY) {
          const telem = payload as TelemetryData;
          setRobots((prev) => {
            const next = new Map(prev);
            const existing = next.get(telem.r);
            if (existing) {
              next.set(telem.r, {
                ...existing,
                battery_voltage: telem.v,
                battery_pct: telem.p,
                cpu_pct: telem.c ?? existing.cpu_pct,
                gpu_pct: telem.g ?? existing.gpu_pct,
                mem_used_mb: telem.mu ?? existing.mem_used_mb,
                mem_total_mb: telem.mt ?? existing.mem_total_mb,
              });
            }
            return next;
          });
        } else if (type === MsgType.FLEET_STATE) {
          const state = (payload as { robots: FleetState["robots"] });
          const now = Date.now();
          setRobots((prev) => {
            const next = new Map<string, RobotState>();
            for (const r of state.robots) {
              if (!r.connected) continue;
              const existing = prev.get(r.robot_id);
              next.set(r.robot_id, {
                ...r,
                battery_voltage: r.battery_voltage ?? existing?.battery_voltage ?? null,
                battery_pct: r.battery_pct ?? existing?.battery_pct ?? null,
                cpu_pct: r.cpu_pct ?? existing?.cpu_pct ?? null,
                gpu_pct: r.gpu_pct ?? existing?.gpu_pct ?? null,
                mem_used_mb: r.mem_used_mb ?? existing?.mem_used_mb ?? null,
                mem_total_mb: r.mem_total_mb ?? existing?.mem_total_mb ?? null,
                pose: existing?.pose ?? null,
                lastUpdateMs: existing?.lastUpdateMs ?? now,
              });
            }
            return next;
          });
        }
      };

      ws.onclose = () => {
        setRobots(new Map());
        poseMapRef.current.clear();
        poseTsRef.current.clear();
        cloudTsRef.current.clear();
        poseStateTsRef.current.clear();
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [url]);

  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - STALE_ROBOT_TIMEOUT_MS;
      setRobots((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map<string, RobotState>();
        for (const [id, robot] of prev.entries()) {
          const cloudTs = cloudTsRef.current.get(id) ?? 0;
          const poseTs = poseTsRef.current.get(id) ?? 0;
          const lastActivity = Math.max(robot.lastUpdateMs, cloudTs, poseTs);
          if (robot.connected || lastActivity >= cutoff) {
            next.set(id, robot);
          }
        }
        return next.size === prev.size ? prev : next;
      });
    }, STALE_SWEEP_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return { robots, onPose, onCloud, poseMapRef };
}
