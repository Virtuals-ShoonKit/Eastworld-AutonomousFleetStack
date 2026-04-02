import { useEffect, useRef, useState } from "react";

/**
 * Establishes a WebRTC connection to a single robot's video stream
 * via the host signaling server.
 */
export function useRobotWebRTC(robotId: string, signalingUrl: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [connected, setConnected] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!robotId) return;

    const url = `${signalingUrl}/ws/signaling/${robotId}?role=viewer`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      if (videoRef.current && ev.streams[0]) {
        videoRef.current.srcObject = ev.streams[0];
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

    pc.oniceconnectionstatechange = () => {
      setConnected(
        pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
      );
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.kind === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ kind: "answer", sdp: answer.sdp }));
      } else if (msg.kind === "ice") {
        await pc.addIceCandidate({
          candidate: msg.candidate,
          sdpMLineIndex: msg.sdpMLineIndex,
        });
      }
    };

    return () => {
      pc.close();
      ws.close();
      setConnected(false);
    };
  }, [robotId, signalingUrl]);

  return { videoRef, connected };
}
