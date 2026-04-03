import { useMemo, useState, useCallback } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FleetViewer3D } from "./components/FleetViewer3D";
import { VideoGrid } from "./components/VideoGrid";
import { FleetSidebar } from "./components/FleetSidebar";
import { DockablePanel, type DockPosition } from "./components/DockablePanel";
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
  const [showOriginAxes, setShowOriginAxes] = useState(true);
  const [originAxesLength, setOriginAxesLength] = useState(1);
  const [originAxesThickness, setOriginAxesThickness] = useState(0.05);
  const [mapZOffset, setMapZOffset] = useState(0);

  const [panel3dDock, setPanel3dDock] = useState<DockPosition>("main");
  const [panelVideoDock, setPanelVideoDock] = useState<DockPosition>("bottom");
  const [panel3dCollapsed, setPanel3dCollapsed] = useState(false);
  const [panelVideoCollapsed, setPanelVideoCollapsed] = useState(false);

  const handle3dDock = useCallback((pos: DockPosition) => {
    if (pos === "main") {
      setPanel3dDock("main");
      if (panelVideoDock === "main") setPanelVideoDock("bottom");
    } else {
      setPanel3dDock(pos);
      if (pos !== "float" && panelVideoDock === pos) setPanelVideoDock("main");
      if (panelVideoDock === "float" && pos !== "float") setPanelVideoDock("main");
    }
  }, [panelVideoDock]);

  const handleVideoDock = useCallback((pos: DockPosition) => {
    if (pos === "main") {
      setPanelVideoDock("main");
      if (panel3dDock === "main") setPanel3dDock("bottom");
    } else {
      setPanelVideoDock(pos);
      if (pos !== "float" && panel3dDock === pos) setPanel3dDock("main");
      if (panel3dDock === "float" && pos !== "float") setPanel3dDock("main");
    }
  }, [panel3dDock]);

  const viewer3d = (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <FleetViewer3D
        robots={robots}
        mapUrl={MAP_URL}
        onCloudRegister={onCloud}
        backgroundColor={backgroundColor}
        pointCloudColor={pointCloudColor}
        gridColor={gridColor}
        showOriginAxes={showOriginAxes}
        originAxesLength={originAxesLength}
        originAxesThickness={originAxesThickness}
        mapZOffset={mapZOffset}
      />
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          fontSize: 12,
          fontWeight: 700,
          color: "#00d4ff",
          textShadow: "0 1px 4px rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}
      >
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
          <ControlsPanel
            backgroundColor={backgroundColor}
            setBackgroundColor={setBackgroundColor}
            pointCloudColor={pointCloudColor}
            setPointCloudColor={setPointCloudColor}
            gridColor={gridColor}
            setGridColor={setGridColor}
            showOriginAxes={showOriginAxes}
            setShowOriginAxes={setShowOriginAxes}
            originAxesLength={originAxesLength}
            setOriginAxesLength={setOriginAxesLength}
            originAxesThickness={originAxesThickness}
            setOriginAxesThickness={setOriginAxesThickness}
            mapZOffset={mapZOffset}
            setMapZOffset={setMapZOffset}
            onClose={() => setIsControlsOpen(false)}
          />
        )}
      </div>
    </div>
  );

  const videoGrid = (
    <VideoGrid robots={robots} signalingUrl={SIGNALING_URL} />
  );

  const panel3dContent = (
    <DockablePanel
      title="3D Viewer"
      dock={panel3dDock}
      collapsed={panel3dCollapsed}
      onDockChange={handle3dDock}
      onCollapsedChange={setPanel3dCollapsed}
    >
      {viewer3d}
    </DockablePanel>
  );

  const panelVideoContent = (
    <DockablePanel
      title="Cameras"
      dock={panelVideoDock}
      collapsed={panelVideoCollapsed}
      onDockChange={handleVideoDock}
      onCollapsedChange={setPanelVideoCollapsed}
    >
      {videoGrid}
    </DockablePanel>
  );

  const panel3dIsFloat = panel3dDock === "float";
  const panelVideoIsFloat = panelVideoDock === "float";

  let splitOrientation: "horizontal" | "vertical" = "vertical";
  let hasSplit = false;

  if (!panel3dIsFloat && !panelVideoIsFloat) {
    if (panel3dDock === "main") {
      splitOrientation = panelVideoDock === "right" ? "horizontal" : "vertical";
    } else if (panelVideoDock === "main") {
      splitOrientation = panel3dDock === "right" ? "horizontal" : "vertical";
    } else {
      splitOrientation = panelVideoDock === "right" ? "horizontal" : "vertical";
    }
    hasSplit = true;
  }

  let mainContent: React.ReactNode = null;
  if (panel3dIsFloat && !panelVideoIsFloat) {
    mainContent = panelVideoContent;
  } else if (!panel3dIsFloat && panelVideoIsFloat) {
    mainContent = panel3dContent;
  }

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      <FleetSidebar robots={robots} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {hasSplit ? (
          <Group orientation={splitOrientation} style={{ flex: 1 }}>
            <Panel id="main-panel" defaultSize="65%" minSize="40px" collapsible collapsedSize="28px">
              {panel3dContent}
            </Panel>
            <Separator
              style={{
                background: "#1a1a2e",
                transition: "background 0.15s",
                ...(splitOrientation === "vertical"
                  ? { height: 4, cursor: "row-resize" }
                  : { width: 4, cursor: "col-resize" }),
              }}
            />
            <Panel id="secondary-panel" defaultSize="35%" minSize="40px" collapsible collapsedSize="28px">
              {panelVideoContent}
            </Panel>
          </Group>
        ) : mainContent ? (
          <div style={{ flex: 1, overflow: "hidden" }}>{mainContent}</div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 14 }}>
            Both panels are floating
          </div>
        )}
      </div>

      {panel3dIsFloat && panel3dContent}
      {panelVideoIsFloat && panelVideoContent}
    </div>
  );
}

function ControlsPanel({
  backgroundColor,
  setBackgroundColor,
  pointCloudColor,
  setPointCloudColor,
  gridColor,
  setGridColor,
  showOriginAxes,
  setShowOriginAxes,
  originAxesLength,
  setOriginAxesLength,
  originAxesThickness,
  setOriginAxesThickness,
  mapZOffset,
  setMapZOffset,
  onClose,
}: {
  backgroundColor: string;
  setBackgroundColor: (v: string) => void;
  pointCloudColor: string;
  setPointCloudColor: (v: string) => void;
  gridColor: string;
  setGridColor: (v: string) => void;
  showOriginAxes: boolean;
  setShowOriginAxes: (v: boolean) => void;
  originAxesLength: number;
  setOriginAxesLength: (v: number) => void;
  originAxesThickness: number;
  setOriginAxesThickness: (v: number) => void;
  mapZOffset: number;
  setMapZOffset: (v: number) => void;
  onClose: () => void;
}) {
  return (
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
          onClick={onClose}
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
        <input type="color" value={backgroundColor} onChange={(e) => setBackgroundColor(e.target.value)} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 78 }}>Map Cloud</span>
        <input type="color" value={pointCloudColor} onChange={(e) => setPointCloudColor(e.target.value)} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 78 }}>Grid</span>
        <input type="color" value={gridColor} onChange={(e) => setGridColor(e.target.value)} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 128 }}>Show Origin Axes</span>
        <input type="checkbox" checked={showOriginAxes} onChange={(e) => setShowOriginAxes(e.target.checked)} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Axes Length: {originAxesLength.toFixed(1)} m</span>
        <input type="range" min={0.5} max={20} step={0.5} value={originAxesLength} onChange={(e) => setOriginAxesLength(Number(e.target.value))} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Axes Thickness: {originAxesThickness.toFixed(2)} m</span>
        <input type="range" min={0.01} max={0.3} step={0.01} value={originAxesThickness} onChange={(e) => setOriginAxesThickness(Number(e.target.value))} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Map Z Offset: {mapZOffset.toFixed(2)} m</span>
        <input type="range" min={-2} max={2} step={0.01} value={mapZOffset} onChange={(e) => setMapZOffset(Number(e.target.value))} />
      </label>
    </div>
  );
}
