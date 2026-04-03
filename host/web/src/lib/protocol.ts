/**
 * Protocol decoder matching shared/protocol.py.
 * Binary WS frames: 1-byte type tag + msgpack payload.
 */

import { decode } from "@msgpack/msgpack";

export const MsgType = {
  REGISTER: 0x01,
  HEARTBEAT: 0x02,
  POSE: 0x10,
  CLOUD: 0x11,
  TELEMETRY: 0x12,
  SIGNALING: 0x20,
  FLEET_STATE: 0x30,
} as const;

export interface PoseData {
  r: string; // robot_id
  t: number; // timestamp
  p: [number, number, number]; // position xyz
  q: [number, number, number, number]; // quaternion xyzw
}

export interface CloudData {
  r: string;
  t: number;
  n: number; // num_points
  d: Uint8Array; // draco bytes
}

export interface TelemetryData {
  r: string; // robot_id
  v: number; // battery_voltage
  p: number; // battery_pct (0-100)
}

export interface FleetState {
  robots: Array<{
    robot_id: string;
    connected: boolean;
    last_heartbeat: number;
    hardware: string;
    alive: boolean;
    battery_voltage: number | null;
    battery_pct: number | null;
  }>;
}

export function parseMessage(data: ArrayBuffer): {
  type: number;
  payload: unknown;
} {
  const view = new Uint8Array(data);
  const type = view[0];
  const payload = decode(view.slice(1));
  return { type, payload };
}
