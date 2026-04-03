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

/**
 * Establishes a WebRTC connection to a single robot's video stream
 * via the host signaling server.
 */
export function useRobotWebRTC(robotId: string, signalingUrl: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [debugInfo, setDebugInfo] = useState("init");
  const [networkStats, setNetworkStats] = useState<NetworkStats>(EMPTY_STATS);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const prevBytesRef = useRef<{ bytes: number; ts: number } | null>(null);

  const pollStats = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || pc.connectionState !== "connected") return;

    try {
      const stats = await pc.getStats();
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
      const prev = prevBytesRef.current;
      if (prev && bytesReceived > prev.bytes) {
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          bitrateKbps = Math.round(((bytesReceived - prev.bytes) * 8) / dtSec / 1000);
        }
      }
      prevBytesRef.current = { bytes: bytesReceived, ts: now };

      setNetworkStats({ rttMs, bitrateKbps, packetsReceived, packetsLost, framesDecoded, jitterMs });
    } catch {
      // stats unavailable
    }
  }, []);

  useEffect(() => {
    if (!robotId) return;

    const url = `${signalingUrl}/ws/signaling/${robotId}?role=viewer`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    const pendingRemoteIce: RTCIceCandidateInit[] = [];
    let remoteDescriptionSet = false;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;
    prevBytesRef.current = null;

    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      setDebugInfo(prev => prev + ` | track:${ev.track.kind}`);
      if (videoRef.current && ev.streams[0]) {
        videoRef.current.srcObject = ev.streams[0];
        videoRef.current.play().catch(() => {});
        setConnected(true);
      }
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

    pc.onconnectionstatechange = () => {
      setDebugInfo(prev => prev + ` | conn:${pc.connectionState}`);
    };

    pc.oniceconnectionstatechange = () => {
      setDebugInfo(prev => prev + ` | ice:${pc.iceConnectionState}`);
      setConnected(
        pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
      );
    };

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.kind === "offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          remoteDescriptionSet = true;
          while (pendingRemoteIce.length > 0) {
            const candidate = pendingRemoteIce.shift();
            if (candidate) {
              await pc.addIceCandidate(candidate);
            }
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ kind: "answer", sdp: answer.sdp }));
        } else if (msg.kind === "ice") {
          const candidate = {
            candidate: msg.candidate,
            sdpMLineIndex: msg.sdpMLineIndex,
          } satisfies RTCIceCandidateInit;
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

    return () => {
      pc.close();
      ws.close();
      setConnected(false);
      setNetworkStats(EMPTY_STATS);
      prevBytesRef.current = null;
    };
  }, [robotId, signalingUrl]);

  // Periodic stats poller (every 2s while connected)
  useEffect(() => {
    if (!connected) return;
    pollStats();
    const id = setInterval(pollStats, 2000);
    return () => clearInterval(id);
  }, [connected, pollStats]);

  return { videoRef, connected, debugInfo, networkStats };
}
