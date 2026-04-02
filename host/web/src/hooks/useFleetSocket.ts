import { useEffect, useRef, useCallback, useState } from "react";
import { parseMessage, MsgType, PoseData, CloudData, FleetState } from "../lib/protocol";

export interface RobotState {
  robot_id: string;
  connected: boolean;
  alive: boolean;
  hardware: string;
  pose: PoseData | null;
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
          setRobots((prev) => {
            const next = new Map(prev);
            const existing = next.get(pose.r);
            next.set(pose.r, {
              robot_id: pose.r,
              connected: existing?.connected ?? true,
              alive: true,
              hardware: existing?.hardware ?? "orin_nx",
              pose,
            });
            return next;
          });
          poseCallbacks.current.forEach((cb) => cb(pose));
        } else if (type === MsgType.CLOUD) {
          const cloud = payload as CloudData;
          cloudCallbacks.current.forEach((cb) => cb(cloud));
        } else if (type === MsgType.FLEET_STATE) {
          const state = (payload as { robots: FleetState["robots"] });
          setRobots((prev) => {
            const next = new Map(prev);
            for (const r of state.robots) {
              const existing = next.get(r.robot_id);
              next.set(r.robot_id, {
                ...r,
                pose: existing?.pose ?? null,
              });
            }
            return next;
          });
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [url]);

  return { robots, onPose, onCloud };
}
