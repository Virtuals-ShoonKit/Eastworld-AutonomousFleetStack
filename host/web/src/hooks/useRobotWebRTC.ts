import { useEffect, useRef, useState } from "react";

/**
 * Establishes a WebRTC connection to a single robot's video stream
 * via the host signaling server.
 */
export function useRobotWebRTC(robotId: string, signalingUrl: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [connected, setConnected] = useState(false);
  // #region agent log
  const [debugInfo, setDebugInfo] = useState("init");
  // #endregion
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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

    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      // #region agent log
      setDebugInfo(prev => prev + ` | track:streams=${ev.streams.length},kind=${ev.track.kind},state=${ev.track.readyState}`);
      // #endregion
      if (videoRef.current && ev.streams[0]) {
        videoRef.current.srcObject = ev.streams[0];
        videoRef.current.play().then(() => {
          // #region agent log
          setDebugInfo(prev => prev + " | play:OK");
          // #endregion
        }).catch((err) => {
          // #region agent log
          setDebugInfo(prev => prev + ` | play:FAIL(${err?.name})`);
          // #endregion
        });
        setConnected(true);
        // #region agent log
        const vid = videoRef.current;
        const checkVideo = async () => {
          const stats = await pc.getStats();
          const types: string[] = [];
          let rtpInfo = "";
          let transportInfo = "";
          let pairInfo = "";
          stats.forEach((report: any) => {
            if (!types.includes(report.type)) types.push(report.type);
            if (report.type === "inbound-rtp") {
              rtpInfo = `rtp:k=${report.kind},pkts=${report.packetsReceived},bytes=${report.bytesReceived},dec=${report.framesDecoded}`;
            }
            if (report.type === "transport") {
              transportInfo = `tr:state=${report.dtlsState},ice=${report.iceLocalCandidateId},bytesRx=${report.bytesReceived},bytesTx=${report.bytesSent}`;
            }
            if (report.type === "candidate-pair" && report.nominated) {
              pairInfo = `pair:state=${report.state},bytesRx=${report.bytesReceived},bytesTx=${report.bytesSent},rtt=${report.currentRoundTripTime}`;
            }
          });
          const info = `types=[${types.join(",")}] ${rtpInfo} ${transportInfo} ${pairInfo}`;
          setDebugInfo(info);
        };
        setTimeout(checkVideo, 4000);
        setTimeout(checkVideo, 10000);
        // #endregion
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

    // #region agent log
    pc.onconnectionstatechange = () => {
      setDebugInfo(prev => prev + ` | conn:${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        const checkStats = async () => {
          const stats = await pc.getStats();
          const types: string[] = [];
          let rtpInfo = "";
          let transportInfo = "";
          stats.forEach((report: any) => {
            if (!types.includes(report.type)) types.push(report.type);
            if (report.type === "inbound-rtp") {
              rtpInfo = `rtp:k=${report.kind},pkts=${report.packetsReceived},bytes=${report.bytesReceived},dec=${report.framesDecoded}`;
            }
            if (report.type === "transport") {
              transportInfo = `tr:dtls=${report.dtlsState},bytesRx=${report.bytesReceived},bytesTx=${report.bytesSent}`;
            }
          });
          setDebugInfo(`CONNECTED types=[${types.join(",")}] ${rtpInfo} ${transportInfo}`);
          fetch('http://127.0.0.1:7868/ingest/7bfa4f77-b30e-4ffb-9251-65501936595f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3d3ed7'},body:JSON.stringify({sessionId:'3d3ed7',runId:'post-fix-1',hypothesisId:'H1',location:'useRobotWebRTC.ts:stats',message:'post-connected stats',data:{types,rtpInfo,transportInfo,hasInboundRtp:types.includes('inbound-rtp')},timestamp:Date.now()})}).catch(()=>{});
        };
        setTimeout(checkStats, 2000);
        setTimeout(checkStats, 6000);
      }
    };
    // #endregion

    pc.oniceconnectionstatechange = () => {
      // #region agent log
      setDebugInfo(prev => prev + ` | ice:${pc.iceConnectionState}`);
      // #endregion
      setConnected(
        pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
      );
    };

    // #region agent log
    let offerCount = 0;
    // #endregion
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // #region agent log
        if (msg.kind === "offer" || msg.kind === "answer") setDebugInfo(prev => prev + ` | ws:${msg.kind}`);
        // #endregion
        if (msg.kind === "offer") {
          // #region agent log
          offerCount++;
          const hasFmtp = (msg.sdp || '').includes('a=fmtp:96');
          fetch('http://127.0.0.1:7868/ingest/7bfa4f77-b30e-4ffb-9251-65501936595f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3d3ed7'},body:JSON.stringify({sessionId:'3d3ed7',runId:'post-fix-1',hypothesisId:'H1',location:'useRobotWebRTC.ts:offer-rx',message:'offer received by viewer',data:{offerCount,hasFmtp,sigState:pc.signalingState,sdpPreview:(msg.sdp||'').substring(0,300)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
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
          // #region agent log
          const ansHasFmtp = (answer.sdp || '').includes('a=fmtp:96');
          fetch('http://127.0.0.1:7868/ingest/7bfa4f77-b30e-4ffb-9251-65501936595f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3d3ed7'},body:JSON.stringify({sessionId:'3d3ed7',runId:'post-fix-1',hypothesisId:'H1',location:'useRobotWebRTC.ts:answer-tx',message:'answer created by viewer',data:{offerCount,ansHasFmtp,sigState:pc.signalingState,sdpPreview:(answer.sdp||'').substring(0,300)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
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
    };
  }, [robotId, signalingUrl]);

  return { videoRef, connected, debugInfo };
}
