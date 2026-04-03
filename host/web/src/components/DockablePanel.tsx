import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";

export type DockPosition = "main" | "bottom" | "right" | "float";

interface Props {
  title: string;
  dock: DockPosition;
  collapsed: boolean;
  onDockChange: (pos: DockPosition) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  children: ReactNode;
}

const TOOLBAR_H = 28;

const btnStyle: React.CSSProperties = {
  cursor: "pointer",
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid rgba(120,150,190,0.35)",
  background: "transparent",
  color: "#8899bb",
  fontSize: 10,
  fontWeight: 600,
  lineHeight: "16px",
};
const btnActiveStyle: React.CSSProperties = {
  ...btnStyle,
  background: "rgba(0,212,255,0.15)",
  borderColor: "#00d4ff55",
  color: "#00d4ff",
};

function Toolbar({
  title,
  dock,
  collapsed,
  onDockChange,
  onCollapsedChange,
  onDragStart,
}: {
  title: string;
  dock: DockPosition;
  collapsed: boolean;
  onDockChange: (p: DockPosition) => void;
  onCollapsedChange: (c: boolean) => void;
  onDragStart?: (e: React.MouseEvent) => void;
}) {
  const chevron = collapsed
    ? dock === "right" ? "\u25B6" : "\u25BC"
    : dock === "right" ? "\u25C0" : "\u25B2";

  return (
    <div
      style={{
        height: TOOLBAR_H,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px",
        background: "rgba(9,12,18,0.95)",
        borderBottom: collapsed ? "none" : "1px solid #222",
        userSelect: "none",
        flexShrink: 0,
        cursor: dock === "float" ? "grab" : "default",
      }}
      onMouseDown={dock === "float" ? onDragStart : undefined}
    >
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        style={{ ...btnStyle, padding: "2px 4px", fontSize: 8 }}
        title={collapsed ? "Expand" : "Collapse"}
      >
        {chevron}
      </button>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#8899bb", flex: 1 }}>
        {title}
      </span>
      {(["main", "bottom", "right", "float"] as DockPosition[]).map((pos) => (
        <button
          key={pos}
          type="button"
          onClick={() => onDockChange(pos)}
          style={dock === pos ? btnActiveStyle : btnStyle}
          title={pos === "main" ? "Maximize" : pos === "float" ? "Float" : `Dock ${pos}`}
        >
          {pos === "main" && "\u2922"}
          {pos === "bottom" && "\u2B07"}
          {pos === "right" && "\u2B95"}
          {pos === "float" && "\u2750"}
        </button>
      ))}
    </div>
  );
}

export function DockablePanel({
  title,
  dock,
  collapsed,
  onDockChange,
  onCollapsedChange,
  children,
}: Props) {
  if (dock !== "float") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <Toolbar
          title={title}
          dock={dock}
          collapsed={collapsed}
          onDockChange={onDockChange}
          onCollapsedChange={onCollapsedChange}
        />
        {!collapsed && (
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <FloatingWrapper
      title={title}
      dock={dock}
      collapsed={collapsed}
      onDockChange={onDockChange}
      onCollapsedChange={onCollapsedChange}
    >
      {children}
    </FloatingWrapper>
  );
}

function FloatingWrapper({
  title,
  dock,
  collapsed,
  onDockChange,
  onCollapsedChange,
  children,
}: Props) {
  const [pos, setPos] = useState({ x: 80, y: 80 });
  const [size, setSize] = useState({ w: 640, h: 400 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
      }
      if (resizeRef.current) {
        const dw = e.clientX - resizeRef.current.startX;
        const dh = e.clientY - resizeRef.current.startY;
        setSize({
          w: Math.max(280, resizeRef.current.origW + dw),
          h: Math.max(120, resizeRef.current.origH + dh),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (collapsed) {
    return (
      <div
        style={{
          position: "fixed",
          left: pos.x,
          top: pos.y,
          zIndex: 9999,
          background: "rgba(9,12,18,0.95)",
          border: "1px solid #00d4ff44",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        onClick={() => onCollapsedChange(false)}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "#00d4ff" }}>{title}</span>
        <span style={{ fontSize: 9, color: "#8899bb" }}>(click to expand)</span>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        background: "#0d0f14",
        border: "1px solid #00d4ff44",
        borderRadius: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        overflow: "hidden",
      }}
    >
      <Toolbar
        title={title}
        dock={dock}
        collapsed={collapsed}
        onDockChange={onDockChange}
        onCollapsedChange={onCollapsedChange}
        onDragStart={onDragStart}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {children}
      </div>
      {/* Resize handle (bottom-right corner) */}
      <div
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 14,
          height: 14,
          cursor: "nwse-resize",
          background: "linear-gradient(135deg, transparent 50%, #00d4ff44 50%)",
          borderRadius: "0 0 8px 0",
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
        }}
      />
    </div>
  );
}

export { TOOLBAR_H };
