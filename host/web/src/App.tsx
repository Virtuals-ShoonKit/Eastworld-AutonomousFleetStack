import { useMemo, useState } from "react";
import { FleetViewer3D } from "./components/FleetViewer3D";
import { VideoGrid } from "./components/VideoGrid";
import { FleetSidebar } from "./components/FleetSidebar";
import { useFleetSocket } from "./hooks/useFleetSocket";

const WS_URL = `ws://${window.location.hostname}:8800/ws/viewer`;
const SIGNALING_URL = `ws://${window.location.hostname}:8800`;
const MAP_URL = "./maps/office_map.drc";

export default function App() {
  const { robots, onCloud } = useFleetSocket(WS_URL);
  const robotIds = useMemo(() => Array.from(robots.keys()), [robots]);
  const [backgroundColor, setBackgroundColor] = useState("#070b12");
  const [pointCloudColor, setPointCloudColor] = useState("#9fd3ff");
  const [gridColor, setGridColor] = useState("#2a2a4e");
  const [isControlsOpen, setIsControlsOpen] = useState(false);
  const [randomizeLiveCloud, setRandomizeLiveCloud] = useState(true);
  const [showOriginAxes, setShowOriginAxes] = useState(true);
  const [originAxesLength, setOriginAxesLength] = useState(1);
  const [originAxesThickness, setOriginAxesThickness] = useState(0.05);
  const [mapZOffset, setMapZOffset] = useState(0);

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
            backgroundColor={backgroundColor}
            pointCloudColor={pointCloudColor}
            gridColor={gridColor}
            randomizeLiveCloud={randomizeLiveCloud}
            showOriginAxes={showOriginAxes}
            originAxesLength={originAxesLength}
            originAxesThickness={originAxesThickness}
            mapZOffset={mapZOffset}
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
          <div
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              zIndex: 20,
              display: "flex",
              alignItems: "flex-start",
              pointerEvents: "auto",
            }}
          >
            {!isControlsOpen && (
              <button
                type="button"
                onClick={() => setIsControlsOpen(true)}
                style={{
                  cursor: "pointer",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(120, 150, 190, 0.55)",
                  background: "rgba(9, 12, 18, 0.92)",
                  color: "#d9ecff",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                Controls
              </button>
            )}

            {isControlsOpen && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  minWidth: 200,
                  padding: 10,
                  borderRadius: 8,
                  background: "rgba(9, 12, 18, 0.92)",
                  border: "1px solid rgba(120, 150, 190, 0.55)",
                  color: "#d9ecff",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700 }}>View Colors</div>
                  <button
                    type="button"
                    onClick={() => setIsControlsOpen(false)}
                    style={{
                      cursor: "pointer",
                      padding: "2px 8px",
                      borderRadius: 6,
                      border: "1px solid rgba(120, 150, 190, 0.4)",
                      background: "rgba(20, 27, 38, 1)",
                      color: "#d9ecff",
                      fontSize: 11,
                    }}
                  >
                    Close
                  </button>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 78 }}>Background</span>
                  <input
                    type="color"
                    value={backgroundColor}
                    onChange={(e) => setBackgroundColor(e.target.value)}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 78 }}>Point Cloud</span>
                  <input
                    type="color"
                    value={pointCloudColor}
                    onChange={(e) => setPointCloudColor(e.target.value)}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 78 }}>Grid</span>
                  <input
                    type="color"
                    value={gridColor}
                    onChange={(e) => setGridColor(e.target.value)}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 128 }}>Randomize Live Cloud</span>
                  <input
                    type="checkbox"
                    checked={randomizeLiveCloud}
                    onChange={(e) => setRandomizeLiveCloud(e.target.checked)}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 128 }}>Show Origin Axes</span>
                  <input
                    type="checkbox"
                    checked={showOriginAxes}
                    onChange={(e) => setShowOriginAxes(e.target.checked)}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Axes Length: {originAxesLength.toFixed(1)} m</span>
                  <input
                    type="range"
                    min={0.5}
                    max={20}
                    step={0.5}
                    value={originAxesLength}
                    onChange={(e) => setOriginAxesLength(Number(e.target.value))}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Axes Thickness: {originAxesThickness.toFixed(2)} m</span>
                  <input
                    type="range"
                    min={0.01}
                    max={0.3}
                    step={0.01}
                    value={originAxesThickness}
                    onChange={(e) => setOriginAxesThickness(Number(e.target.value))}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Map Z Offset: {mapZOffset.toFixed(2)} m</span>
                  <input
                    type="range"
                    min={-2}
                    max={2}
                    step={0.01}
                    value={mapZOffset}
                    onChange={(e) => setMapZOffset(Number(e.target.value))}
                  />
                </label>
              </div>
            )}
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
