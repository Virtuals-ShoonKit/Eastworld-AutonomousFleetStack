import type { RobotState } from "../hooks/useFleetSocket";

interface Props {
  robots: Map<string, RobotState>;
}

function BatteryIcon({ pct, voltage }: { pct: number | null; voltage: number | null }) {
  const hasTelem = pct !== null;
  const level = hasTelem ? pct! : 0;
  const color = !hasTelem ? "#555" : level > 50 ? "#00ff88" : level > 20 ? "#ffcc00" : "#ff4444";
  const fillW = hasTelem ? Math.max(1, (level / 100) * 16) : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6 }}>
      <svg width="22" height="12" viewBox="0 0 24 14">
        <rect x="0.5" y="1" width="20" height="12" rx="2" ry="2"
          fill="none" stroke={color} strokeWidth="1.2" />
        <rect x="20.5" y="4" width="2.5" height="6" rx="1" fill={color} opacity={0.6} />
        {hasTelem ? (
          <rect x="2" y="2.5" width={fillW} height="9" rx="1" fill={color} opacity={0.8} />
        ) : (
          <text x="10.5" y="10.5" textAnchor="middle" fontSize="8" fill="#555" fontWeight="bold">?</text>
        )}
      </svg>
      <span style={{ fontSize: 10, color, fontFamily: "monospace", fontWeight: 600 }}>
        {hasTelem ? `${level}%` : "N/A"}
      </span>
      {voltage !== null && (
        <span style={{ fontSize: 9, color: "#666", fontFamily: "monospace" }}>
          {voltage.toFixed(1)}V
        </span>
      )}
    </div>
  );
}

export function FleetSidebar({ robots }: Props) {
  const entries = Array.from(robots.values());

  return (
    <div style={{
      width: 240,
      background: "#12121a",
      borderRight: "1px solid #222",
      padding: 16,
      overflowY: "auto",
      flexShrink: 0,
    }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, color: "#8888aa", marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
        Fleet ({entries.length})
      </h2>

      {entries.length === 0 && (
        <p style={{ fontSize: 12, color: "#555" }}>No robots connected</p>
      )}

      {entries.map((robot) => (
        <div key={robot.robot_id} style={{
          padding: "10px 12px",
          marginBottom: 8,
          background: "#1a1a28",
          borderRadius: 6,
          border: `1px solid ${robot.alive ? "#00d4ff22" : "#333"}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: robot.alive ? "#00ff88" : robot.connected ? "#ffaa00" : "#ff4444",
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ddd" }}>
              {robot.robot_id}
            </span>
          </div>

          <div style={{ fontSize: 11, color: "#777" }}>
            {robot.hardware}
          </div>

          {robot.pose && (
            <div style={{ fontSize: 10, color: "#555", marginTop: 4, fontFamily: "monospace" }}>
              x={robot.pose.p[0].toFixed(2)} y={robot.pose.p[1].toFixed(2)} z={robot.pose.p[2].toFixed(2)}
            </div>
          )}

          <BatteryIcon pct={robot.battery_pct} voltage={robot.battery_voltage} />
        </div>
      ))}
    </div>
  );
}
