import React, { useState } from "react";
import {
  Activity, BarChart2, Radio, History, Settings,
  ShieldAlert, Database, TrendingUp,
  Wallet, Menu, X
} from "lucide-react";

const DARK = {
  bg: "#0e1120",
  card: "#1a2035",
  sidebarDeep: "#0f1428",
  border: "#2a3050",
  muted: "#64748b",
  mutedFg: "#94a3b8",
  primary: "#60a5fa",
  success: "#34d399",
  destructive: "#f87171",
  warning: "#fbbf24",
  foreground: "#e8edf5",
};

const NAV = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "research", label: "Research", icon: BarChart2 },
  { id: "signals", label: "Signals", icon: Radio },
  { id: "trades", label: "Trades", icon: History },
  { id: "risk", label: "Risk", icon: ShieldAlert },
  { id: "data", label: "Data", icon: Database },
  { id: "settings", label: "Settings", icon: Settings },
];

function NavItem({
  item,
  active,
  expanded,
  onClick,
}: {
  item: { id: string; label: string; icon: React.ElementType };
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      title={expanded ? undefined : item.label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: expanded ? "10px 14px" : "10px 0",
        justifyContent: expanded ? "flex-start" : "center",
        background: active ? `${DARK.primary}15` : "none",
        border: "none",
        borderLeft: active ? `3px solid ${DARK.primary}` : "3px solid transparent",
        borderRadius: active ? "0 8px 8px 0" : "0",
        cursor: "pointer",
      }}
    >
      <Icon size={18} color={active ? DARK.primary : DARK.mutedFg} style={{ flexShrink: 0 }} />
      {expanded && (
        <span
          style={{
            color: active ? DARK.primary : DARK.foreground,
            fontSize: 13.5,
            fontWeight: active ? 600 : 400,
          }}
        >
          {item.label}
        </span>
      )}
    </button>
  );
}

function PlaceholderPage({ id }: { id: string }) {
  const navItem = NAV.find((n) => n.id === id);
  const label = navItem ? navItem.label : id;
  const Icon = navItem ? navItem.icon : Activity;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: 300,
        gap: 12,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          background: `${DARK.primary}15`,
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={22} color={DARK.primary} />
      </div>
      <p style={{ color: DARK.foreground, fontSize: 16, fontWeight: 600 }}>{label}</p>
      <p style={{ color: DARK.muted, fontSize: 13 }}>Page content goes here</p>
    </div>
  );
}

export function TabletView() {
  const [active, setActive] = useState("overview");
  const [expanded, setExpanded] = useState(false);

  const sidebarW = expanded ? 200 : 56;

  return (
    <div
      style={{
        width: 780,
        height: 790,
        background: DARK.bg,
        fontFamily: "Inter, sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          height: 52,
          background: DARK.sidebarDeep,
          borderBottom: `1px solid ${DARK.border}`,
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        {/* Hamburger toggle */}
        <button
          onClick={() => setExpanded((s) => !s)}
          style={{
            width: sidebarW,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "none",
            border: "none",
            cursor: "pointer",
            borderRight: `1px solid ${DARK.border}`,
            transition: "width 0.2s",
            flexShrink: 0,
            gap: expanded ? 8 : 0,
            padding: expanded ? "0 16px" : "0",
          }}
        >
          {expanded ? <X size={18} color={DARK.muted} /> : <Menu size={18} color={DARK.muted} />}
          {expanded && (
            <span style={{ color: DARK.mutedFg, fontSize: 12, whiteSpace: "nowrap" }}>
              Close menu
            </span>
          )}
        </button>

        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
            flex: 1,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              background: `${DARK.primary}20`,
              borderRadius: 7,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <TrendingUp size={15} color={DARK.primary} />
          </div>
          <div>
            <p style={{ color: DARK.foreground, fontSize: 13, fontWeight: 700, lineHeight: 1 }}>
              Deriv Quant
            </p>
            <p style={{ color: DARK.muted, fontSize: 10, marginTop: 1 }}>Research Platform</p>
          </div>
        </div>

        {/* Mode badge */}
        <div style={{ padding: "0 12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: `${DARK.warning}15`,
              border: `1px solid ${DARK.warning}30`,
              borderRadius: 20,
              padding: "4px 10px",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: DARK.warning,
                display: "inline-block",
              }}
            />
            <span style={{ color: DARK.warning, fontSize: 10, fontWeight: 700 }}>PAPER</span>
          </div>
        </div>

        {/* Balance */}
        <div
          style={{
            padding: "0 16px",
            borderLeft: `1px solid ${DARK.border}`,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span
            style={{
              color: DARK.muted,
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            Balance
          </span>
          <span
            style={{
              color: DARK.foreground,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "monospace",
            }}
          >
            USD 10,000.00
          </span>
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar */}
        <div
          style={{
            width: sidebarW,
            flexShrink: 0,
            background: `linear-gradient(180deg, ${DARK.sidebarDeep} 0%, hsl(228 42% 9%) 100%)`,
            borderRight: `1px solid ${DARK.border}`,
            overflowY: "auto",
            overflowX: "hidden",
            transition: "width 0.2s ease",
            display: "flex",
            flexDirection: "column",
            paddingTop: 8,
          }}
        >
          {expanded && (
            <p
              style={{
                color: DARK.muted,
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                fontWeight: 600,
                padding: "4px 16px 8px",
              }}
            >
              Navigation
            </p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 6px" }}>
            {NAV.map((item) => (
              <NavItem
                key={item.id}
                item={item}
                active={active === item.id}
                expanded={expanded}
                onClick={() => setActive(item.id)}
              />
            ))}
          </div>

          {expanded && (
            <div
              style={{
                marginTop: "auto",
                padding: "12px 16px",
                borderTop: `1px solid ${DARK.border}40`,
              }}
            >
              <p
                style={{
                  color: `${DARK.muted}50`,
                  fontSize: 9,
                  fontFamily: "monospace",
                  textAlign: "center",
                }}
              >
                v0.1.0
              </p>
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          {/* Page header */}
          <div style={{ marginBottom: 16 }}>
            <h1
              style={{
                color: DARK.foreground,
                fontSize: 20,
                fontWeight: 700,
                margin: 0,
                letterSpacing: -0.3,
              }}
            >
              {active === "overview" ? "Dashboard" : active.charAt(0).toUpperCase() + active.slice(1)}
            </h1>
            <p style={{ color: DARK.muted, fontSize: 12, marginTop: 3 }}>
              Last sync: 18:26:48
            </p>
          </div>

          {active === "overview" ? (
            <>
              {/* Account card */}
              <div
                style={{
                  background: DARK.card,
                  border: `1px solid ${DARK.border}`,
                  borderRadius: 10,
                  padding: "14px 16px",
                  marginBottom: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Wallet size={16} color={DARK.primary} />
                  <div>
                    <p style={{ color: DARK.muted, fontSize: 10 }}>VRTC15298516 · Virtual</p>
                    <p
                      style={{
                        color: DARK.foreground,
                        fontSize: 16,
                        fontWeight: 700,
                        fontFamily: "monospace",
                        marginTop: 2,
                      }}
                    >
                      USD 10,000.00
                    </p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 24 }}>
                  {[
                    ["Equity", "10,000.00"],
                    ["Margin", "0.00"],
                    ["Free Margin", "10,000.00"],
                  ].map(([l, v]) => (
                    <div key={l} style={{ textAlign: "right" }}>
                      <p
                        style={{
                          color: DARK.muted,
                          fontSize: 9,
                          textTransform: "uppercase",
                          letterSpacing: "0.1em",
                        }}
                      >
                        {l}
                      </p>
                      <p
                        style={{
                          color: DARK.foreground,
                          fontSize: 12,
                          fontFamily: "monospace",
                          fontWeight: 600,
                          marginTop: 2,
                        }}
                      >
                        {v}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* KPI 2x2 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginBottom: 12,
                }}
              >
                {[
                  { label: "Available Capital", value: "$25,000.00", sub: "Balanced allocation", accent: DARK.primary },
                  { label: "Realised P&L", value: "-$599.52", sub: "Win rate: 0.4%", accent: DARK.destructive, color: DARK.destructive },
                  { label: "Open Risk", value: "0.00%", sub: "0 open positions", accent: DARK.warning },
                  { label: "Active Strategies", value: "4 Active", sub: "Model: Trained", accent: "#a78bfa" },
                ].map(({ label, value, sub, accent, color }) => (
                  <div
                    key={label}
                    style={{
                      background: DARK.card,
                      border: `1px solid ${DARK.border}`,
                      borderLeft: `3px solid ${accent}`,
                      borderRadius: 10,
                      padding: "12px 14px",
                    }}
                  >
                    <p
                      style={{
                        color: DARK.muted,
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: "0.12em",
                        fontWeight: 600,
                      }}
                    >
                      {label}
                    </p>
                    <p
                      style={{
                        color: color || DARK.foreground,
                        fontSize: 20,
                        fontWeight: 700,
                        fontFamily: "monospace",
                        marginTop: 4,
                      }}
                    >
                      {value}
                    </p>
                    <p style={{ color: DARK.muted, fontSize: 10, marginTop: 4 }}>{sub}</p>
                  </div>
                ))}
              </div>

              {/* Status 2-col */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {/* Portfolio */}
                <div
                  style={{
                    background: DARK.card,
                    border: `1px solid ${DARK.border}`,
                    borderRadius: 10,
                    padding: "12px 16px",
                  }}
                >
                  <p
                    style={{
                      color: DARK.muted,
                      fontSize: 9,
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      fontWeight: 600,
                      marginBottom: 10,
                    }}
                  >
                    Portfolio
                  </p>
                  {[
                    { l: "Balance", v: "$10,000.00", c: undefined },
                    { l: "Daily P&L", v: "-$1,191.16", c: DARK.destructive },
                    { l: "Drawdown", v: "11.9%", c: DARK.destructive },
                  ].map(({ l, v, c }) => (
                    <div
                      key={l}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        paddingBottom: 7,
                        marginBottom: 7,
                        borderBottom: `1px solid ${DARK.border}40`,
                      }}
                    >
                      <span style={{ color: DARK.muted, fontSize: 12 }}>{l}</span>
                      <span
                        style={{
                          color: c || DARK.foreground,
                          fontSize: 12,
                          fontFamily: "monospace",
                          fontWeight: 600,
                        }}
                      >
                        {v}
                      </span>
                    </div>
                  ))}
                </div>

                {/* System */}
                <div
                  style={{
                    background: DARK.card,
                    border: `1px solid ${DARK.border}`,
                    borderRadius: 10,
                    padding: "12px 16px",
                  }}
                >
                  <p
                    style={{
                      color: DARK.muted,
                      fontSize: 9,
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      fontWeight: 600,
                      marginBottom: 10,
                    }}
                  >
                    System
                  </p>
                  {[
                    { l: "Data Stream", ok: true },
                    { l: "Risk Engine", ok: true },
                    { l: "Deriv API", ok: true },
                    { l: "Kill Switch", ok: false },
                  ].map(({ l, ok }) => (
                    <div
                      key={l}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        paddingBottom: 7,
                        marginBottom: 7,
                        borderBottom: `1px solid ${DARK.border}40`,
                      }}
                    >
                      <span style={{ color: DARK.muted, fontSize: 12 }}>{l}</span>
                      <span
                        style={{
                          background: ok ? `${DARK.success}20` : `${DARK.muted}20`,
                          color: ok ? DARK.success : DARK.muted,
                          borderRadius: 4,
                          padding: "2px 7px",
                          fontSize: 10,
                          fontWeight: 600,
                        }}
                      >
                        {ok ? "Active" : "Off"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <PlaceholderPage id={active} />
          )}
        </div>
      </div>
    </div>
  );
}
