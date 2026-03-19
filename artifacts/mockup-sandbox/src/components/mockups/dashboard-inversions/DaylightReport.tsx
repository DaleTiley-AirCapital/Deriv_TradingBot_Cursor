import React from "react";

const data = {
  account: "VRTC15298516",
  balance: 10000.0,
  currency: "USD",
  mode: "PAPER",
  equity: 10000.0,
  margin: 0.0,
  freeMargin: 10000.0,
  availableCapital: 25000.0,
  realisedPnl: -599.52,
  winRate: 0.4,
  openRisk: 0.0,
  openPositions: 0,
  totalTrades: 10,
  allocationMode: "BALANCED",
  modelStatus: "TRAINED",
  strategies: ["Trend Pullback", "Exhaustion Rebound", "Volatility Breakout", "Spike Hazard"],
  dailyPnl: -1191.16,
  drawdownPct: 11.9,
};

function Kpi({ label, value, sub, positive, negative }: { label: string; value: string; sub?: string; positive?: boolean; negative?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 font-medium">{label}</p>
      <p className={`text-4xl font-bold leading-none tabular-nums ${positive ? "text-emerald-600" : negative ? "text-red-500" : "text-gray-900"}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between items-baseline py-2.5 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${muted ? "text-gray-400" : "text-gray-900"}`}>{value}</span>
    </div>
  );
}

export function DaylightReport() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Top bar */}
      <div className="border-b border-gray-200 px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 bg-gray-900 rounded flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="white"><path d="M2 9L6 3L10 9H2Z"/></svg>
          </div>
          <span className="text-sm font-semibold text-gray-900 tracking-tight">Deriv Quant</span>
          <span className="text-xs text-gray-400 font-medium">Research Platform</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Synced 18:26:48</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">Paper</span>
        </div>
      </div>

      <div className="px-8 pt-8 pb-10 max-w-3xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-gray-400">Account {data.account}</span>
            <span className="text-gray-200">·</span>
            <span className="text-sm text-gray-900 font-medium">{data.currency} {data.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
        </div>

        {/* 4-KPI row — large editorial numbers */}
        <div className="grid grid-cols-4 gap-8 mb-10 pb-8 border-b border-gray-100">
          <Kpi
            label="Available Capital"
            value={`$${(data.availableCapital / 1000).toFixed(0)}k`}
            sub={data.allocationMode}
          />
          <Kpi
            label="Realised P&L"
            value={`$${data.realisedPnl.toFixed(0)}`}
            sub={`${data.winRate}% win rate`}
            negative={data.realisedPnl < 0}
            positive={data.realisedPnl > 0}
          />
          <Kpi
            label="Open Risk"
            value={`${data.openRisk.toFixed(1)}%`}
            sub={`${data.openPositions} positions`}
          />
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 font-medium">Strategies</p>
            <p className="text-4xl font-bold leading-none text-gray-900">{data.strategies.length}</p>
            <div className="mt-2 space-y-0.5">
              {data.strategies.map(s => (
                <p key={s} className="text-[10px] text-gray-400 leading-relaxed">{s}</p>
              ))}
            </div>
          </div>
        </div>

        {/* Two-column detail */}
        <div className="grid grid-cols-2 gap-12">
          <div>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 font-medium mb-3">Portfolio</p>
            <Row label="Account Balance" value={`$${data.balance.toLocaleString()}`} />
            <Row label="Daily P&L" value={`$${data.dailyPnl.toFixed(2)}`} />
            <Row label="Drawdown" value={`${data.drawdownPct.toFixed(1)}%`} />
            <Row label="Equity" value={`$${data.equity.toLocaleString()}`} />
            <Row label="Free Margin" value={`$${data.freeMargin.toLocaleString()}`} />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 font-medium mb-3">Operations</p>
            <Row label="Total Trades" value={String(data.totalTrades)} />
            <Row label="Win Rate" value={`${data.winRate}%`} />
            <Row label="Model Status" value={data.modelStatus} />
            <Row label="Data Stream" value="Online" />
            <Row label="Deriv API" value="Connected" />
            <Row label="Risk Engine" value="Active" />
          </div>
        </div>

        {/* Accounts footer bar */}
        <div className="mt-10 pt-6 border-t border-gray-100">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 mb-1">Equity</p>
              <p className="text-base font-semibold tabular-nums text-gray-900">${data.equity.toLocaleString()}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 mb-1">Margin</p>
              <p className="text-base font-semibold tabular-nums text-gray-900">{data.margin.toFixed(2)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-[0.15em] text-gray-400 mb-1">Margin Level</p>
              <p className="text-base font-semibold tabular-nums text-gray-400">—</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
