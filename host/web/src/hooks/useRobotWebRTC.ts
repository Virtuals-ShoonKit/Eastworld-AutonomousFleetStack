import { useEffect, useRef, useState, useCallback } from "react";

export interface NetworkStats {
  rttMs: number | null;
  bitrateKbps: number | null;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded: number;
  jitterMs: number | null;
}

const EMPTY_STATS: NetworkStats = {
  rttMs: null,
  bitrateKbps: null,
  packetsReceived: 0,
  packetsLost: 0,
  framesDecoded: 0,
  jitterMs: null,
};

// ---------------------------------------------------------------------------
// Connection pool – keeps WebRTC peer connections alive across React
// component unmount / remount cycles (dock changes, maximize, float, etc.).
// A connection is only torn down if no consumer re-acquires it within
// DISPOSE_DELAY_MS after the last consumer releases it.
// ---------------------------------------------------------------------------

interface PoolEntry {
  pc: RTCPeerConnection;
  ws: WebSocket;
  stream: MediaStream | null;
  connected: boolean;
  stats: NetworkStats;
  refCount: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  prevBytes: { bytes: number; ts: number } | null;
  statsTimer: ReturnType<typeof setInterval> | null;
  subscribers: Set<() => void>;
}

const pool = new Map<string, PoolEntry>();
const DISPOSE_DELAY_MS = 5000;

function pkey(robotId: string, signalingUrl: string) {
  return `${robotId}\0${signalingUrl}`;
}

function pollEntryStats(entry: PoolEntry) {
  const { pc } = entry;
  if (pc.connectionState !== "connected") return;
  pc.getStats()
    .then((stats) => {
      let rttMs: number | null = null;
      let packetsReceived = 0;
      let packetsLost = 0;
      let framesDecoded = 0;
      let jitterMs: number | null = null;
      let bytesReceived = 0;

      stats.forEach((report: any) => {
        if (report.type === "candidate-pair" && report.nominated) {
          if (report.currentRoundTripTime != null) {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        }
        if (report.type === "inbound-rtp" && report.kind === "video") {
          packetsReceived = report.packetsReceived ?? 0;
          packetsLost = report.packetsLost ?? 0;
          framesDecoded = report.framesDecoded ?? 0;
          bytesReceived = report.bytesReceived ?? 0;
          if (report.jitter != null) {
            jitterMs = Math.round(report.jitter * 1000);
          }
        }
      });

      let bitrateKbps: number | null = null;
      const now = performance.now();
      const prev = entry.prevBytes;
      if (prev && bytesReceived > prev.bytes) {
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          bitrateKbps = Math.round(
            ((bytesReceived - prev.bytes) * 8) / dtSec / 1000
          );
        }
      }
      entry.prevBytes = { bytes: bytesReceived, ts: now };
      entry.stats = {
        rttMs,
        bitrateKbps,
        packetsReceived,
        packetsLost,
        framesDecoded,
        jitterMs,
      };
      entry.subscribers.forEach((fn) => fn());
    })
    .catch(() => {});
}

function acquireConnection(
  robotId: string,
  signalingUrl: string
): PoolEntry {
  const key = pkey(robotId, signalingUrl);
  const existing = pool.get(key);
  if (existing) {
    if (existing.disposeTimer !== null) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = null;
    }
    existing.refCount++;
    return existing;
  }

  const wsUrl = `${signalingUrl}/ws/signaling/${robotId}?role=viewer`;
  const ws = new WebSocket(wsUrl);
  const pendingRemoteIce: RTCIceCandidateInit[] = [];
  let remoteDescriptionSet = false;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const entry: PoolEntry = {
    pc,
    ws,
    stream: null,
    connected: false,
    stats: { ...EMPTY_STATS },
    refCount: 1,
    disposeTimer: null,
    prevBytes: null,
    statsTimer: null,
    subscribers: new Set(),
  };

  const notify = () => entry.subscribers.forEach((fn) => fn());

  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (!stream) return;
    entry.stream = stream;
    entry.connected = true;
    notify();
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          kind: "ice",
          candidate: ev.candidate.candidate,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        })
      );
    }
  };

  pc.oniceconnectionstatechange = () => {
    entry.connected =
      pc.iceConnectionState === "connected" ||
      pc.iceConnectionState === "completed";
    notify();
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.kind === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        remoteDescriptionSet = true;
        while (pendingRemoteIce.length > 0) {
          const c = pendingRemoteIce.shift();
          if (c) await pc.addIceCandidate(c);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ kind: "answer", sdp: answer.sdp }));
      } else if (msg.kind === "ice") {
        const candidate: RTCIceCandidateInit = {
          candidate: msg.candidate,
          sdpMLineIndex: msg.sdpMLineIndex,
        };
        if (!remoteDescriptionSet) {
          pendingRemoteIce.push(candidate);
        } else {
          await pc.addIceCandidate(candidate);
        }
      }
    } catch (err) {
      console.warn(`WebRTC signaling error for ${robotId}:`, err);
    }
  };

  entry.statsTimer = setInterval(() => pollEntryStats(entry), 2000);

  pool.set(key, entry);
  return entry;
}

function releaseConnection(robotId: string, signalingUrl: string) {
  const key = pkey(robotId, signalingUrl);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0 && entry.disposeTimer === null) {
    entry.disposeTimer = setTimeout(() => {
      if (entry.statsTimer !== null) clearInterval(entry.statsTimer);
      entry.pc.close();
      entry.ws.close();
      pool.delete(key);
    }, DISPOSE_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// React hook – thin wrapper over the pool
// ---------------------------------------------------------------------------

export function useRobotWebRTC(robotId: string, signalingUrl: string) {
  const [, bump] = useState(0);
  const entryRef = useRef<PoolEntry | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!robotId) return;
    const entry = acquireConnection(robotId, signalingUrl);
    entryRef.current = entry;

    const sub = () => {
      bump((n) => n + 1);
      const el = videoElRef.current;
      if (el && entry.stream) {
        if (el.srcObject !== entry.stream) {
          el.srcObject = entry.stream;
          el.play().catch(() => {});
        }
      }
    };
    entry.subscribers.add(sub);
    sub();

    return () => {
      entry.subscribers.delete(sub);
      entryRef.current = null;
      releaseConnection(robotId, signalingUrl);
    };
  }, [robotId, signalingUrl]);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    if (videoElRef.current && videoElRef.current !== el) {
      videoElRef.current.srcObject = null;
    }
    videoElRef.current = el;
    const entry = entryRef.current;
    if (el && entry?.stream) {
      el.srcObject = entry.stream;
      el.play().catch(() => {});
    }
  }, []);

  const entry = entryRef.current;
  return {
    videoRef,
    connected: entry?.connected ?? false,
    debugInfo: "",
    networkStats: entry?.stats ?? EMPTY_STATS,
  };
}
