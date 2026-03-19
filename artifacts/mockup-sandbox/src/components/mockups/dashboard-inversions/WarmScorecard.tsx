import React from "react";

const data = {
  account: "VRTC15298516",
  balance: 10000.0,
  currency: "USD",
  mode: "PAPER",
  realisedPnl: -599.52,
  availableCapital: 25000.0,
  winRate: 0.4,
  openRisk: 0.0,
  totalTrades: 10,
  strategies: ["Trend Pullback", "Exhaustion Rebound", "Volatility Breakout", "Spike Hazard"],
  dailyPnl: -1191.16,
  drawdownPct: 11.9,
};

const pnlPositive = data.realisedPnl >= 0;
const riskLevel = data.openRisk < 3 ? "low" : data.openRisk < 7 ? "moderate" : "high";
const riskColor = riskLevel === "low" ? "text-stone-400" : riskLevel === "moderate" ? "text-amber-600" : "text-red-600";

function StatusDot({ on }: { on: boolean }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-stone-300"}`} />
  );
}

export function WarmScorecard() {
  return (
    <div className="min-h-screen font-sans" style={{ background: "#FDF8F0" }}>

      {/* Slim header — barely there */}
      <div className="px-8 pt-6 pb-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 12 12" fill="#78716c"><path d="M2 9L6 3L10 9H2Z"/></svg>
          <span className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Deriv Quant</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot on={true} />
          <span className="text-xs text-stone-400 font-medium">Paper · {data.account}</span>
        </div>
      </div>

      {/* Giant hero P&L — the whole page is about this */}
      <div className="px-8 pt-10 pb-8">
        <p className="text-xs text-stone-400 tracking-widest uppercase mb-2">Realised P&L, all time</p>
        <div className="flex items-end gap-3 mb-1">
          <span
            className="font-black leading-none tabular-nums"
            style={{ fontSize: "clamp(3rem, 10vw, 5rem)", color: pnlPositive ? "#059669" : "#B45309" }}
          >
            {pnlPositive ? "+" : ""}${Math.abs(data.realisedPnl).toFixed(2)}
          </span>
          <span className="text-stone-400 text-sm mb-2 font-medium">
            {data.winRate}% of {data.totalTrades} trades won
          </span>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-xs">
          {pnlPositive
            ? "You're in the green. Strategies are finding edges."
            : "Losses so far. Keep sizing small while the model calibrates."}
        </p>
      </div>

      {/* Warm horizontal divider */}
      <div className="mx-8 border-t" style={{ borderColor: "#E8DDD0" }} />

      {/* Capital + risk — a calm pair */}
      <div className="px-8 pt-8 pb-6 grid grid-cols-2 gap-8">
        <div>
          <p className="text-xs text-stone-400 tracking-widest uppercase mb-3">Capital ready to deploy</p>
          <p className="text-3xl font-bold tabular-nums text-stone-800">
            ${data.availableCapital.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-stone-400 mt-1">Balanced allocation mode</p>
        </div>
        <div>
          <p className="text-xs text-stone-400 tracking-widest uppercase mb-3">Open risk</p>
          <p className={`text-3xl font-bold tabular-nums ${riskColor}`}>
            {data.openRisk.toFixed(2)}%
          </p>
          <p className="text-xs text-stone-400 mt-1">
            Risk is {riskLevel} · 0 positions open
          </p>
        </div>
      </div>

      {/* Warm divider */}
      <div className="mx-8 border-t" style={{ borderColor: "#E8DDD0" }} />

      {/* Account balance — secondary context */}
      <div className="px-8 py-6">
        <p className="text-xs text-stone-400 tracking-widest uppercase mb-1">Account balance</p>
        <p className="text-xl font-semibold tabular-nums text-stone-700">
          {data.currency} {data.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </p>
        <p className="text-xs text-stone-400 mt-1">
          Daily P&L: <span className="text-stone-600 font-medium">${data.dailyPnl.toFixed(2)}</span>
          &nbsp;·&nbsp;Drawdown: <span className="text-amber-700 font-medium">{data.drawdownPct.toFixed(1)}%</span>
        </p>
      </div>

      {/* Warm divider */}
      <div className="mx-8 border-t" style={{ borderColor: "#E8DDD0" }} />

      {/* Strategies — listed simply, no badge chrome */}
      <div className="px-8 py-6">
        <p className="text-xs text-stone-400 tracking-widest uppercase mb-3">Scanning with {data.strategies.length} strategies</p>
        <div className="space-y-2">
          {data.strategies.map((s) => (
            <div key={s} className="flex items-center gap-2">
              <StatusDot on={true} />
              <span className="text-sm text-stone-600">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Warm divider */}
      <div className="mx-8 border-t" style={{ borderColor: "#E8DDD0" }} />

      {/* System status — prose, no badges */}
      <div className="px-8 py-5">
        <p className="text-xs text-stone-400 tracking-widest uppercase mb-3">System</p>
        <div className="space-y-1.5">
          {[
            { label: "Data stream is online", on: true },
            { label: "Deriv API connected", on: true },
            { label: "Risk engine active", on: true },
            { label: "Kill switch off", on: true },
          ].map(({ label, on }) => (
            <div key={label} className="flex items-center gap-2">
              <StatusDot on={on} />
              <span className="text-sm text-stone-500">{label}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
