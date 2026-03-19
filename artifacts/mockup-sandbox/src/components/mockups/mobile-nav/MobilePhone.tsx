import React, { useState } from "react";
import {
  Activity, BarChart2, Radio, History, Settings,
  Wallet, TrendingUp, ShieldAlert, Layers, ArrowUpDown,
  AlertTriangle, MoreHorizontal, Database, X
} from "lucide-react";

const DARK = {
  bg: "#0e1120",
  card: "#1a2035",
  sidebar: "#141830",
  border: "#2a3050",
  muted: "#64748b",
  primary: "#60a5fa",
  success: "#34d399",
  destructive: "#f87171",
  warning: "#fbbf24",
  foreground: "#e8edf5",
};

const PRIMARY_TABS = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "signals", label: "Signals", icon: Radio },
  { id: "trades", label: "Trades", icon: History },
  { id: "research", label: "Research", icon: BarChart2 },
  { id: "more", label: "More", icon: MoreHorizontal },
];

const MORE_ITEMS = [
  { id: "risk", label: "Risk Monitor", icon: ShieldAlert },
  { id: "data", label: "Data", icon: Database },
  { id: "settings", label: "Settings", icon: Settings },
];

function KpiTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderRadius: 12, padding: "14px 16px" }}>
      <p style={{ color: DARK.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 4 }}>{label}</p>
      <p style={{ color: color || DARK.foreground, fontSize: 22, fontWeight: 700, fontFamily: "JetBrains Mono, monospace", lineHeight: 1.2 }}>{value}</p>
      {sub && <p style={{ color: DARK.muted, fontSize: 11, marginTop: 4 }}>{sub}</p>}
    </div>
  );
}

function OverviewPage() {
  return (
    <div style={{ padding: "0 16px 16px" }}>
      {/* Account card */}
      <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={{ color: DARK.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em" }}>Deriv Account · VRTC15298516</p>
            <p style={{ color: DARK.foreground, fontSize: 20, fontWeight: 700, fontFamily: "monospace", marginTop: 4 }}>USD 10,000.00</p>
          </div>
          <span style={{ background: `${DARK.warning}20`, color: DARK.warning, border: `1px solid ${DARK.warning}40`, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700 }}>PAPER</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${DARK.border}` }}>
          {[["Equity", "10,000.00"], ["Free Margin", "10,000.00"]].map(([l, v]) => (
            <div key={l}>
              <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em" }}>{l}</p>
              <p style={{ color: DARK.foreground, fontSize: 13, fontWeight: 600, fontFamily: "monospace", marginTop: 2 }}>{v}</p>
            </div>
          ))}
        </div>
      </div>

      {/* KPI 2x2 grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderLeft: `3px solid ${DARK.primary}`, borderRadius: 12, padding: "12px 14px" }}>
          <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Available Capital</p>
          <p style={{ color: DARK.foreground, fontSize: 18, fontWeight: 700, fontFamily: "monospace", marginTop: 4 }}>$25,000</p>
          <p style={{ color: DARK.muted, fontSize: 10, marginTop: 4 }}>Balanced mode</p>
        </div>
        <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderLeft: `3px solid ${DARK.destructive}`, borderRadius: 12, padding: "12px 14px" }}>
          <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Realised P&L</p>
          <p style={{ color: DARK.destructive, fontSize: 18, fontWeight: 700, fontFamily: "monospace", marginTop: 4 }}>-$599.52</p>
          <p style={{ color: DARK.muted, fontSize: 10, marginTop: 4 }}>Win rate 0.4%</p>
        </div>
        <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderLeft: `3px solid ${DARK.warning}`, borderRadius: 12, padding: "12px 14px" }}>
          <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Open Risk</p>
          <p style={{ color: DARK.foreground, fontSize: 18, fontWeight: 700, fontFamily: "monospace", marginTop: 4 }}>0.00%</p>
          <p style={{ color: DARK.muted, fontSize: 10, marginTop: 4 }}>0 positions</p>
        </div>
        <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderLeft: "3px solid #a78bfa", borderRadius: 12, padding: "12px 14px" }}>
          <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Strategies</p>
          <p style={{ color: DARK.foreground, fontSize: 18, fontWeight: 700, fontFamily: "monospace", marginTop: 4 }}>4 Active</p>
          <p style={{ color: DARK.muted, fontSize: 10, marginTop: 4 }}>Model trained</p>
        </div>
      </div>

      {/* System status */}
      <div style={{ background: DARK.card, border: `1px solid ${DARK.border}`, borderRadius: 12, padding: "12px 16px" }}>
        <p style={{ color: DARK.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 10 }}>System Status</p>
        {[
          ["Data Stream", true], ["Risk Engine", true], ["Deriv API", true]
        ].map(([label, ok]) => (
          <div key={label as string} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottom: `1px solid ${DARK.border}` }}>
            <span style={{ color: DARK.muted, fontSize: 12 }}>{label as string}</span>
            <span style={{ background: ok ? `${DARK.success}20` : `${DARK.muted}20`, color: ok ? DARK.success : DARK.muted, borderRadius: 5, padding: "2px 8px", fontSize: 10, fontWeight: 600 }}>{ok ? "Online" : "Offline"}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: DARK.muted, fontSize: 12 }}>Total Trades</span>
          <span style={{ color: DARK.foreground, fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>10</span>
        </div>
      </div>
    </div>
  );
}

function PlaceholderPage({ title, icon: Icon }: { title: string; icon: React.ElementType }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 12 }}>
      <div style={{ width: 48, height: 48, background: `${DARK.primary}15`, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon size={22} color={DARK.primary} />
      </div>
      <p style={{ color: DARK.foreground, fontSize: 16, fontWeight: 600 }}>{title}</p>
      <p style={{ color: DARK.muted, fontSize: 13 }}>Page content goes here</p>
    </div>
  );
}

export function MobilePhone() {
  const [activeTab, setActiveTab] = useState("overview");
  const [showMore, setShowMore] = useState(false);

  const getPage = () => {
    if (activeTab === "signals") return <PlaceholderPage title="Signals" icon={Radio} />;
    if (activeTab === "trades") return <PlaceholderPage title="Trades" icon={History} />;
    if (activeTab === "research") return <PlaceholderPage title="Research" icon={BarChart2} />;
    if (activeTab === "risk") return <PlaceholderPage title="Risk Monitor" icon={ShieldAlert} />;
    if (activeTab === "data") return <PlaceholderPage title="Data" icon={Database} />;
    if (activeTab === "settings") return <PlaceholderPage title="Settings" icon={Settings} />;
    return <OverviewPage />;
  };

  const activePrimary = PRIMARY_TABS.find(t => t.id === activeTab || (t.id === "more" && MORE_ITEMS.find(m => m.id === activeTab)));

  return (
    <div style={{ width: 390, minHeight: "100vh", background: DARK.bg, fontFamily: "Inter, sans-serif", display: "flex", flexDirection: "column", position: "relative" }}>

      {/* Status bar */}
      <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", flexShrink: 0 }}>
        <span style={{ color: DARK.foreground, fontSize: 13, fontWeight: 600 }}>9:41</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: DARK.foreground, fontSize: 11 }}>●●●</span>
          <span style={{ color: DARK.foreground, fontSize: 11 }}>WiFi</span>
          <span style={{ color: DARK.foreground, fontSize: 11 }}>🔋</span>
        </div>
      </div>

      {/* App header */}
      <div style={{ padding: "8px 16px 12px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, background: `${DARK.primary}20`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <TrendingUp size={16} color={DARK.primary} />
            </div>
            <div>
              <p style={{ color: DARK.foreground, fontSize: 14, fontWeight: 700, lineHeight: 1 }}>Deriv Quant</p>
              <p style={{ color: DARK.muted, fontSize: 10, marginTop: 1 }}>Research Platform</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, background: `${DARK.warning}15`, border: `1px solid ${DARK.warning}30`, borderRadius: 20, padding: "4px 10px" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: DARK.warning, display: "inline-block" }} />
            <span style={{ color: DARK.warning, fontSize: 10, fontWeight: 700 }}>PAPER</span>
          </div>
        </div>

        {/* Page title */}
        <div style={{ marginTop: 16 }}>
          <h1 style={{ color: DARK.foreground, fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>
            {activeTab === "overview" ? "Dashboard" : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
          </h1>
          <p style={{ color: DARK.muted, fontSize: 12, marginTop: 2 }}>Last sync: 18:26:48</p>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {getPage()}
      </div>

      {/* More drawer */}
      {showMore && (
        <div
          style={{ position: "absolute", bottom: 64, left: 0, right: 0, background: DARK.card, border: `1px solid ${DARK.border}`, borderTop: "none", borderRadius: "16px 16px 0 0", padding: "8px 0 8px", zIndex: 20, boxShadow: "0 -8px 32px rgba(0,0,0,0.6)" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 20px 12px" }}>
            <p style={{ color: DARK.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>More</p>
            <button onClick={() => setShowMore(false)} style={{ background: "none", border: "none", cursor: "pointer", color: DARK.muted, padding: 4 }}>
              <X size={16} />
            </button>
          </div>
          {MORE_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => { setActiveTab(item.id); setShowMore(false); }}
              style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", padding: "13px 20px", background: activeTab === item.id ? `${DARK.primary}12` : "none", border: "none", cursor: "pointer", textAlign: "left" }}
            >
              <item.icon size={20} color={activeTab === item.id ? DARK.primary : DARK.muted} />
              <span style={{ color: activeTab === item.id ? DARK.primary : DARK.foreground, fontSize: 15, fontWeight: 500 }}>{item.label}</span>
              {activeTab === item.id && <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%", background: DARK.primary }} />}
            </button>
          ))}
        </div>
      )}

      {/* Bottom tab bar */}
      <div style={{ height: 64, background: DARK.card, borderTop: `1px solid ${DARK.border}`, display: "flex", alignItems: "center", flexShrink: 0, zIndex: 10, paddingBottom: 4 }}>
        {PRIMARY_TABS.map(tab => {
          const isMoreActive = tab.id === "more" && (MORE_ITEMS.some(m => m.id === activeTab) || showMore);
          const isActive = (tab.id !== "more" && activeTab === tab.id) || isMoreActive;
          return (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id === "more") { setShowMore(s => !s); }
                else { setActiveTab(tab.id); setShowMore(false); }
              }}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: "6px 0" }}
            >
              <tab.icon size={20} color={isActive ? DARK.primary : DARK.muted} />
              <span style={{ color: isActive ? DARK.primary : DARK.muted, fontSize: 9.5, fontWeight: isActive ? 600 : 400, letterSpacing: 0.1 }}>{tab.label}</span>
              {isActive && tab.id !== "more" && (
                <span style={{ position: "absolute", bottom: 0, width: 20, height: 2, background: DARK.primary, borderRadius: 2 }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
