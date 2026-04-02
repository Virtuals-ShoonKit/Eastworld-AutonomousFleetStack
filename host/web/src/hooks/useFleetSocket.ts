import { useEffect, useRef, useCallback, useState } from "react";
import { parseMessage, MsgType, PoseData, CloudData, FleetState } from "../lib/protocol";

const STALE_ROBOT_TIMEOUT_MS = 15_000;
const STALE_SWEEP_INTERVAL_MS = 2_000;

export interface RobotState {
  robot_id: string;
  connected: boolean;
  alive: boolean;
  hardware: string;
  pose: PoseData | null;
  lastUpdateMs: number;
}

export function useFleetSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [robots, setRobots] = useState<Map<string, RobotState>>(new Map());
  const poseCallbacks = useRef<Set<(pose: PoseData) => void>>(new Set());
  const cloudCallbacks = useRef<Set<(cloud: CloudData) => void>>(new Set());

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
            });
            return next;
          });
          poseCallbacks.current.forEach((cb) => cb(pose));
        } else if (type === MsgType.CLOUD) {
          const cloud = payload as CloudData;
          const now = Date.now();
          setRobots((prev) => {
            const next = new Map(prev);
            const existing = next.get(cloud.r);
            next.set(cloud.r, {
              robot_id: cloud.r,
              connected: existing?.connected ?? true,
              alive: true,
              hardware: existing?.hardware ?? "orin_nx",
              pose: existing?.pose ?? null,
              lastUpdateMs: now,
            });
            return next;
          });
          cloudCallbacks.current.forEach((cb) => cb(cloud));
        } else if (type === MsgType.FLEET_STATE) {
          const state = (payload as { robots: FleetState["robots"] });
          const now = Date.now();
          setRobots((prev) => {
            const next = new Map<string, RobotState>();
            for (const r of state.robots) {
              // Remove disconnected robots from the viewer list.
              if (!r.connected) continue;
              const existing = prev.get(r.robot_id);
              next.set(r.robot_id, {
                ...r,
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
          if (robot.lastUpdateMs >= cutoff) {
            next.set(id, robot);
          }
        }
        return next.size === prev.size ? prev : next;
      });
    }, STALE_SWEEP_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return { robots, onPose, onCloud };
}
