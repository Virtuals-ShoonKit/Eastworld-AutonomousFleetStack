import { useRobotWebRTC } from "../hooks/useRobotWebRTC";

interface Props {
  robotIds: string[];
  signalingUrl: string;
}

function VideoPanel({ robotId, signalingUrl }: { robotId: string; signalingUrl: string }) {
  const { videoRef, connected, debugInfo } = useRobotWebRTC(robotId, signalingUrl);

  return (
    <div style={{
      position: "relative",
      background: "#111118",
      borderRadius: 8,
      overflow: "hidden",
      border: `2px solid ${connected ? "#00d4ff33" : "#333"}`,
    }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      <div style={{
        position: "absolute",
        top: 6,
        left: 8,
        fontSize: 11,
        fontWeight: 600,
        color: connected ? "#00d4ff" : "#666",
        textShadow: "0 1px 3px rgba(0,0,0,0.8)",
      }}>
        {robotId}
        <span style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: connected ? "#00ff88" : "#ff4444",
          marginLeft: 6,
          verticalAlign: "middle",
        }} />
      </div>
      {/* #region agent log */}
      <div style={{
        position: "absolute",
        bottom: 2,
        left: 4,
        right: 4,
        fontSize: 9,
        fontFamily: "monospace",
        color: "#0f0",
        background: "rgba(0,0,0,0.7)",
        padding: "2px 4px",
        wordBreak: "break-all",
        pointerEvents: "none",
      }}>
        {debugInfo}
      </div>
      {/* #endregion */}
    </div>
  );
}

export function VideoGrid({ robotIds, signalingUrl }: Props) {
  const count = robotIds.length;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(count / cols));

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      gridAutoRows: "minmax(0, 1fr)",
      gap: 4,
      height: "100%",
      padding: 4,
    }}>
      {robotIds.map((id) => (
        <VideoPanel key={id} robotId={id} signalingUrl={signalingUrl} />
      ))}
    </div>
  );
}
