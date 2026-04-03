import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout";
import { useRobotWebRTC, type NetworkStats } from "../hooks/useRobotWebRTC";
import type { RobotState } from "../hooks/useFleetSocket";

interface Props {
  robots: Map<string, RobotState>;
  signalingUrl: string;
}

function NetworkOverlay({ stats, connected }: { stats: NetworkStats; connected: boolean }) {
  if (!connected) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        fontSize: 9, fontFamily: "monospace", color: "#666",
      }}>
        <span style={{ opacity: 0.5 }}>offline</span>
      </div>
    );
  }

  const rttColor = stats.rttMs === null ? "#666"
    : stats.rttMs < 50 ? "#00ff88"
    : stats.rttMs < 150 ? "#ffcc00"
    : "#ff4444";

  const lossRate = stats.packetsReceived > 0
    ? (stats.packetsLost / (stats.packetsReceived + stats.packetsLost)) * 100
    : 0;
  const lossColor = lossRate < 1 ? "#00ff88" : lossRate < 5 ? "#ffcc00" : "#ff4444";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      fontSize: 9, fontFamily: "monospace",
    }}>
      {/* RTT / Latency */}
      <span style={{ color: rttColor, fontWeight: 600 }}>
        {stats.rttMs !== null ? `${stats.rttMs}ms` : "—"}
      </span>
      {/* Bitrate */}
      {stats.bitrateKbps !== null && (
        <span style={{ color: "#8899bb" }}>
          {stats.bitrateKbps >= 1000
            ? `${(stats.bitrateKbps / 1000).toFixed(1)}Mb`
            : `${stats.bitrateKbps}kb`}
        </span>
      )}
      {/* Packet loss */}
      {stats.packetsReceived > 0 && (
        <span style={{ color: lossColor }}>
          {lossRate < 0.1 ? "0%" : `${lossRate.toFixed(1)}%`}
          <span style={{ color: "#555", marginLeft: 1 }}>loss</span>
        </span>
      )}
    </div>
  );
}

function VideoPanel({
  robotState,
  signalingUrl,
}: {
  robotState: RobotState;
  signalingUrl: string;
}) {
  const { videoRef, connected, networkStats } = useRobotWebRTC(robotState.robot_id, signalingUrl);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#111118",
        borderRadius: 6,
        overflow: "hidden",
        border: `1px solid ${connected ? "#00d4ff33" : "#333"}`,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      {/* Top-left: robot ID + status dot */}
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 6,
          fontSize: 11,
          fontWeight: 600,
          color: connected ? "#00d4ff" : "#666",
          textShadow: "0 1px 3px rgba(0,0,0,0.8)",
        }}
      >
        {robotState.robot_id}
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: connected ? "#00ff88" : "#ff4444",
            marginLeft: 6,
            verticalAlign: "middle",
          }}
        />
      </div>
      {/* Top-right: network stats (latency, bitrate, loss) */}
      <div
        style={{
          position: "absolute",
          top: 4,
          right: 6,
          textShadow: "0 1px 3px rgba(0,0,0,0.8)",
        }}
      >
        <NetworkOverlay stats={networkStats} connected={connected} />
      </div>
    </div>
  );
}

function buildDefaultLayout(robotIds: string[], cols: number): LayoutItem[] {
  return robotIds.map((id, i) => ({
    i: id,
    x: i % cols,
    y: Math.floor(i / cols) * 2,
    w: 1,
    h: 2,
    minW: 1,
    minH: 1,
  }));
}

export function VideoGrid({ robots, signalingUrl }: Props) {
  const robotEntries = useMemo(() => Array.from(robots.values()), [robots]);
  const robotIds = useMemo(() => robotEntries.map((r) => r.robot_id), [robotEntries]);
  const count = robotIds.length;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;

  const { width, containerRef, mounted } = useContainerWidth();

  const [layouts, setLayouts] = useState<ResponsiveLayouts>({});
  const prevIdsRef = useRef<string>("");

  useEffect(() => {
    const key = robotIds.join(",");
    if (key !== prevIdsRef.current) {
      prevIdsRef.current = key;
      const lg = buildDefaultLayout(robotIds, cols);
      setLayouts({ lg, md: lg, sm: lg });
    }
  }, [robotIds, cols]);

  const onLayoutChange = useCallback((_current: Layout, allLayouts: ResponsiveLayouts) => {
    setLayouts(allLayouts);
  }, []);

  const ref = containerRef as React.RefObject<HTMLDivElement>;

  if (count === 0) return <div ref={ref} />;

  return (
    <div ref={ref} style={{ width: "100%", height: "100%", overflow: "auto" }}>
      {mounted && (
        <ResponsiveGridLayout
          width={width}
          layouts={layouts}
          breakpoints={{ lg: 900, md: 600, sm: 0 }}
          cols={{ lg: cols, md: Math.max(1, cols - 1), sm: 1 }}
          rowHeight={120}
          margin={[4, 4] as const}
          containerPadding={[4, 4] as const}
          dragConfig={{ enabled: true, handle: ".video-drag-handle", threshold: 3, bounded: false }}
          resizeConfig={{ enabled: true, handles: ["se"] }}
          compactor={verticalCompactor}
          onLayoutChange={onLayoutChange}
        >
          {robotEntries.map((robot) => (
            <div key={robot.robot_id} style={{ overflow: "hidden", borderRadius: 6 }}>
              <div
                className="video-drag-handle"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 60,
                  height: 22,
                  cursor: "grab",
                  zIndex: 5,
                }}
              />
              <VideoPanel robotState={robot} signalingUrl={signalingUrl} />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}
