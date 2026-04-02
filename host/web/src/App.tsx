import { useMemo } from "react";
import { FleetViewer3D } from "./components/FleetViewer3D";
import { VideoGrid } from "./components/VideoGrid";
import { FleetSidebar } from "./components/FleetSidebar";
import { useFleetSocket } from "./hooks/useFleetSocket";

const WS_URL = `ws://${window.location.hostname}:8800/ws/viewer`;
const SIGNALING_URL = `ws://${window.location.hostname}:8800`;
const MAP_URL = "./maps/office_map.drc";

export default function App() {
  const { robots, onPose, onCloud } = useFleetSocket(WS_URL);
  const robotIds = useMemo(() => Array.from(robots.keys()), [robots]);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      <FleetSidebar robots={robots} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* 3D viewer */}
        <div style={{ flex: 1, position: "relative" }}>
          <FleetViewer3D
            robots={robots}
            mapUrl={MAP_URL}
            onCloudRegister={onCloud}
          />
          <div style={{
            position: "absolute",
            top: 12,
            left: 12,
            fontSize: 12,
            fontWeight: 700,
            color: "#00d4ff",
            textShadow: "0 1px 4px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}>
            EastWorld Fleet Viewer
          </div>
        </div>

        {/* Video grid */}
        {robotIds.length > 0 && (
          <div style={{ height: 200, borderTop: "1px solid #222" }}>
            <VideoGrid robotIds={robotIds} signalingUrl={SIGNALING_URL} />
          </div>
        )}
      </div>
    </div>
  );
}
