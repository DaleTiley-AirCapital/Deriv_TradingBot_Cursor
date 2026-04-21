import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight, ArrowDownRight, Clock, BarChart2, Target, Shield,
  TrendingUp, TrendingDown, Activity, CircleSlash, ChevronDown, ChevronUp,
  Zap, Timer, AlertTriangle, RotateCcw, Loader2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  return fetch(`${BASE}${path.replace(/^\//, "")}`, opts).then(async r => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenPosition {
  id: number;
  symbol: string;
  strategyName: string;
  side: string;
  entryTs: string;
  entryPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  size: number;
  floatingPnl: number;
  floatingPnlPct: number;
  hoursRemaining: number;
  maxExitTs: string | null;
  peakPrice: number | null;
  confidence: number | null;
  mode: string;
}

interface ClosedTrade {
  id: number;
  symbol: string;
  strategyName: string;
  side: string;
  entryTs: string;
  exitTs: string | null;
  entryPrice: number;
  exitPrice: number | null;
  sl: number;
  tp: number;
  size: number;
  pnl: number | null;
  status: string;
  mode: string;
  notes: string | null;
  confidence: number | null;
  exitReason: string | null;
  trailingStopPct: number | null;
  peakPrice: number | null;
  maxExitTs: string | null;
  currentPrice: number | null;
}

interface OverviewMode {
  mode: string;
  paperModeActive: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(ts: string | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatHoldTime(entryTs: string, exitTs?: string | null) {
  const from = new Date(entryTs).getTime();
  const to = exitTs ? new Date(exitTs).getTime() : Date.now();
  const diff = to - from;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return `${Math.floor(diff / 60000)}m`;
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function formatPnl(pnl: number | null | undefined) {
  if (pnl == null) return { text: "—", cls: "text-muted-foreground/50" };
  const pos = pnl >= 0;
  return {
    text: `${pos ? "+" : ""}$${Math.abs(pnl).toFixed(2)}`,
    cls: pos ? "text-green-400 font-semibold" : "text-red-400 font-semibold",
  };
}

function exitReasonLabel(reason: string | null | undefined): { text: string; cls: string } {
  if (!reason) return { text: "—", cls: "text-muted-foreground" };
  const r = reason.toLowerCase();
  if (r.includes("tp") || r.includes("take_profit") || r.includes("take profit"))
    return { text: "TP hit", cls: "text-green-400" };
  if (r.includes("sl") || r.includes("stop_loss") || r.includes("stop loss"))
    return { text: "SL hit", cls: "text-red-400" };
  if (r.includes("trailing"))
    return { text: "Trailing stop", cls: "text-amber-400" };
  if (r.includes("timeout") || r.includes("max_time"))
    return { text: "Timeout", cls: "text-muted-foreground" };
  if (r.includes("manual"))
    return { text: "Manual close", cls: "text-muted-foreground" };
  return { text: reason.replace(/_/g, " "), cls: "text-muted-foreground" };
}

// ── Chips & Micro Components ─────────────────────────────────────────────────

function SideChip({ side }: { side: string }) {
  const up = side?.toUpperCase();
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-bold uppercase",
      up === "BUY" ? "text-green-400" : "text-red-400")}>
      {up === "BUY"
        ? <ArrowUpRight className="w-3.5 h-3.5" />
        : <ArrowDownRight className="w-3.5 h-3.5" />}
      {up}
    </span>
  );
}

function ModeChip({ mode }: { mode: string }) {
  const m = mode?.toUpperCase();
  const cls = m === "PAPER" ? "bg-amber-500/10 text-amber-400 border-amber-500/25"
    : m === "DEMO" ? "bg-blue-500/10 text-blue-400 border-blue-500/25"
    : m === "REAL" ? "bg-green-500/10 text-green-400 border-green-500/25"
    : "bg-muted/30 text-muted-foreground border-border/40";
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cls)}>{m}</span>
  );
}

function StrategyLabel({ name }: { name: string }) {
  const label = name
    .replace(/_engine.*$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/R(\d+)/g, "R$1")
    .trim();
  return <span className="text-[11px] text-muted-foreground">{label}</span>;
}

function PnlPctBar({ pct, positive }: { pct: number; positive: boolean }) {
  const width = Math.min(Math.abs(pct), 100);
  return (
    <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
      <div
        className={cn("h-full rounded-full transition-all", positive ? "bg-green-500" : "bg-red-500")}
        style={{ width: `${width}%` }} />
    </div>
  );
}

// ── Open Position Card ────────────────────────────────────────────────────────

function OpenPositionRow({ pos }: { pos: OpenPosition }) {
  const [expanded, setExpanded] = useState(false);
  const pnl = pos.floatingPnl;
  const pnlPct = pos.floatingPnlPct;
  const positive = pnl >= 0;
  const pnlFmt = formatPnl(pnl);
  const holdTime = formatHoldTime(pos.entryTs);
  const urgency = pos.hoursRemaining < 4 ? "amber" : pos.hoursRemaining < 1 ? "red" : null;

  const progressToTp = pos.side === "buy"
    ? (pos.currentPrice - pos.entryPrice) / (pos.tp - pos.entryPrice)
    : (pos.entryPrice - pos.currentPrice) / (pos.entryPrice - pos.tp);
  const tpProgressPct = Math.max(0, Math.min(progressToTp * 100, 100));

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/10 transition-colors"
        onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <SideChip side={pos.side} />
          <span className="font-bold text-sm text-foreground">{pos.symbol}</span>
          <ModeChip mode={pos.mode} />
          <div className="hidden sm:block ml-1">
            <StrategyLabel name={pos.strategyName} />
          </div>
        </div>

        <div className="hidden md:flex items-center gap-6 text-xs text-muted-foreground shrink-0">
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Entry</div>
            <div className="tabular-nums font-medium text-foreground">{pos.entryPrice.toFixed(4)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Current</div>
            <div className="tabular-nums font-medium text-foreground">{pos.currentPrice.toFixed(4)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Hold</div>
            <div className="tabular-nums font-medium text-foreground">{holdTime}</div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className={cn("text-base font-bold tabular-nums", pnlFmt.cls)}>{pnlFmt.text}</div>
            <div className={cn("text-[10px] tabular-nums", positive ? "text-green-400/70" : "text-red-400/70")}>
              {positive ? "+" : ""}{pnlPct.toFixed(2)}%
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Floating PnL progress bar */}
      <div className="px-4 pb-2">
        <PnlPctBar pct={Math.abs(pnlPct)} positive={positive} />
      </div>

      {expanded && (
        <div className="border-t border-border/30 bg-muted/5 px-4 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Trade Rationale */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-primary" /> Why Opened
            </h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Strategy</span>
                <StrategyLabel name={pos.strategyName} />
              </div>
              {pos.confidence != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Confidence score</span>
                  <span className={cn("tabular-nums font-semibold",
                    pos.confidence >= 85 ? "text-green-400" : pos.confidence >= 70 ? "text-amber-400" : "text-red-400")}>
                    {Math.round(pos.confidence)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Entry time</span>
                <span className="tabular-nums font-medium">{formatTs(pos.entryTs)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size (allocated)</span>
                <span className="tabular-nums font-medium">${pos.size.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Target Tracking */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-primary" /> Target Progress
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Take Profit</span>
                <span className="tabular-nums font-medium text-green-400">{pos.tp.toFixed(4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stop Loss</span>
                <span className="tabular-nums font-medium text-red-400">{pos.sl.toFixed(4)}</span>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-muted-foreground">Progress to TP</span>
                  <span className="tabular-nums text-muted-foreground">{tpProgressPct.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${tpProgressPct}%` }} />
                </div>
              </div>
              {pos.peakPrice != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Peak price</span>
                  <span className="tabular-nums font-medium">{pos.peakPrice.toFixed(4)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Time & Risk */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Timer className="w-3.5 h-3.5 text-primary" /> Hold & Risk
            </h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time in trade</span>
                <span className="tabular-nums font-medium">{holdTime}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hours remaining</span>
                <span className={cn("tabular-nums font-semibold",
                  urgency === "red" ? "text-red-400" : urgency === "amber" ? "text-amber-400" : "text-foreground")}>
                  {pos.hoursRemaining.toFixed(1)}h
                </span>
              </div>
              {pos.maxExitTs && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max exit by</span>
                  <span className="tabular-nums font-medium">{formatTs(pos.maxExitTs)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Float P&L</span>
                <span className={cn("tabular-nums font-bold", pnlFmt.cls)}>{pnlFmt.text}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Float P&L %</span>
                <span className={cn("tabular-nums font-semibold", positive ? "text-green-400" : "text-red-400")}>
                  {positive ? "+" : ""}{pnlPct.toFixed(2)}%
                </span>
              </div>
            </div>
            {urgency && (
              <div className={cn(
                "rounded-md px-2.5 py-1.5 text-[11px] flex items-center gap-1.5",
                urgency === "red" ? "bg-red-500/8 border border-red-500/20 text-red-400" : "bg-amber-500/8 border border-amber-500/20 text-amber-400"
              )}>
                <AlertTriangle className="w-3 h-3 shrink-0" />
                {urgency === "red"
                  ? "Less than 1h before forced exit"
                  : `${pos.hoursRemaining.toFixed(1)}h before max hold expires`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Closed Trade Row ──────────────────────────────────────────────────────────

function ClosedTradeRow({ t }: { t: ClosedTrade }) {
  const [expanded, setExpanded] = useState(false);
  const pnlFmt = formatPnl(t.pnl);
  const exitLbl = exitReasonLabel(t.exitReason);
  const holdTime = formatHoldTime(t.entryTs, t.exitTs);
  const pnlPct = t.pnl != null && t.size > 0 ? (t.pnl / t.size) * 100 : null;

  return (
    <>
      <tr
        className="border-b border-border/20 hover:bg-muted/10 transition-colors cursor-pointer"
        onClick={() => setExpanded(e => !e)}>
        <td className="py-2.5 px-4">
          <div className="flex items-center gap-2">
            <SideChip side={t.side} />
            <span className="font-semibold text-sm">{t.symbol}</span>
            <ModeChip mode={t.mode} />
          </div>
          <StrategyLabel name={t.strategyName} />
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">{formatTs(t.entryTs)}</td>
        <td className="py-2.5 px-3 tabular-nums text-sm font-medium">{t.entryPrice.toFixed(4)}</td>
        <td className="py-2.5 px-3 tabular-nums text-sm text-muted-foreground">{t.exitPrice?.toFixed(4) ?? "—"}</td>
        <td className="py-2.5 px-3 text-xs text-center">
          <span className={exitLbl.cls}>{exitLbl.text}</span>
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground text-center">{holdTime}</td>
        <td className="py-2.5 px-4 text-right">
          <span className={pnlFmt.cls}>{pnlFmt.text}</span>
          {pnlPct != null && (
            <div className={cn("text-[10px] tabular-nums", pnlPct >= 0 ? "text-green-400/60" : "text-red-400/60")}>
              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/5">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Entry Context</p>
                {t.confidence != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Confidence score</span>
                    <span className={cn("tabular-nums font-semibold",
                      t.confidence >= 85 ? "text-green-400" : t.confidence >= 70 ? "text-amber-400" : "text-red-400")}>
                      {Math.round(t.confidence)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Strategy</span>
                  <StrategyLabel name={t.strategyName} />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mode</span>
                  <ModeChip mode={t.mode} />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Size allocated</span>
                  <span className="tabular-nums">${t.size.toFixed(2)}</span>
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Targets & Stops</p>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">TP</span>
                  <span className="tabular-nums text-green-400">{t.tp.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SL</span>
                  <span className="tabular-nums text-red-400">{t.sl.toFixed(4)}</span>
                </div>
                {t.trailingStopPct != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Trailing stop</span>
                    <span className="tabular-nums">{t.trailingStopPct.toFixed(1)}%</span>
                  </div>
                )}
                {t.peakPrice != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Peak price</span>
                    <span className="tabular-nums">{t.peakPrice.toFixed(4)}</span>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Outcome</p>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit reason</span>
                  <span className={exitLbl.cls}>{exitLbl.text}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Exit time</span>
                  <span className="tabular-nums">{formatTs(t.exitTs)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Hold time</span>
                  <span className="tabular-nums">{holdTime}</span>
                </div>
                {t.pnl != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Final P&L</span>
                    <span className={pnlFmt.cls}>{pnlFmt.text}</span>
                  </div>
                )}
                {t.notes && (
                  <div className="mt-1.5 rounded-md bg-muted/20 px-2.5 py-1.5">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{t.notes}</p>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Attribution Tab ───────────────────────────────────────────────────────────

function AttributionSection({ closed }: { closed: ClosedTrade[] }) {
  const bySymbol: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of closed) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, pnl: 0, wins: 0 };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].pnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) bySymbol[t.symbol].wins++;
  }

  const byEngine: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of closed) {
    const eng = t.strategyName;
    if (!byEngine[eng]) byEngine[eng] = { count: 0, pnl: 0, wins: 0 };
    byEngine[eng].count++;
    byEngine[eng].pnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) byEngine[eng].wins++;
  }

  const syms = Object.entries(bySymbol).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
  const engs = Object.entries(byEngine).sort((a, b) => b[1].count - a[1].count);

  if (closed.length === 0) {
    return (
      <div className="text-center py-10">
        <BarChart2 className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No closed trades to attribute</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-primary" /> By Symbol
        </h3>
        <div className="space-y-2">
          {syms.map(([sym, stats]) => {
            const pnlFmt = formatPnl(stats.pnl);
            const wr = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(0) : "0";
            return (
              <div key={sym} className="flex items-center justify-between text-xs">
                <span className="font-mono font-semibold text-foreground w-20 shrink-0">{sym}</span>
                <span className="text-muted-foreground tabular-nums">{stats.count} trades</span>
                <span className="text-muted-foreground tabular-nums">{wr}% WR</span>
                <span className={cn("tabular-nums font-semibold", pnlFmt.cls)}>{pnlFmt.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-primary" /> By Engine
        </h3>
        <div className="space-y-2">
          {engs.map(([eng, stats]) => {
            const pnlFmt = formatPnl(stats.pnl);
            const label = eng.replace(/_engine.*$/i, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
            const wr = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(0) : "0";
            return (
              <div key={eng} className="flex items-center justify-between text-xs gap-2">
                <span className="text-foreground flex-1 truncate">{label}</span>
                <span className="text-muted-foreground tabular-nums shrink-0">{stats.count} trades</span>
                <span className="text-muted-foreground tabular-nums shrink-0">{wr}%</span>
                <span className={cn("tabular-nums font-semibold shrink-0", pnlFmt.cls)}>{pnlFmt.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

type Tab = "open" | "closed" | "attribution";

export default function Trades() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("open");
  const [modeFilter, setModeFilter] = useState("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

  const { data: openPositions = [], isLoading: openLoading } = useQuery<OpenPosition[]>({
    queryKey: ["api/trade/positions"],
    queryFn: () => apiFetch("api/trade/positions"),
    refetchInterval: 10_000,
    staleTime: 5000,
  });

  const { data: closedTrades = [], isLoading: closedLoading } = useQuery<ClosedTrade[]>({
    queryKey: ["api/trade/history", modeFilter, symbolFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (modeFilter) params.set("mode", modeFilter);
      if (symbolFilter) params.set("symbol", symbolFilter);
      return apiFetch(`api/trade/history?${params}`);
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const { data: overview } = useQuery<OverviewMode>({
    queryKey: ["api/overview-mode"],
    queryFn: () => apiFetch("api/overview"),
    refetchInterval: 10_000,
    staleTime: 5000,
  });

  const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
  const losers = closedTrades.filter(t => (t.pnl ?? 0) < 0);
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : null;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + (t.pnl ?? 0), 0) / winners.length : null;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + (t.pnl ?? 0), 0) / losers.length : null;

  const floatingPnl = openPositions.reduce((s, p) => s + p.floatingPnl, 0);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "open", label: "Open Positions", count: openPositions.length },
    { id: "closed", label: "Closed Trades", count: closedTrades.length },
    { id: "attribution", label: "Attribution" },
  ];

  const resetPaperTrading = async () => {
    setResetBusy(true);
    setResetErr(null);
    setResetMsg(null);
    try {
      const d = await apiFetch<{ message?: string }>("api/trade/paper/reset", {
        method: "POST",
      });
      setResetMsg(d.message ?? "Paper trading reset complete.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["api/trade/positions"] }),
        queryClient.invalidateQueries({ queryKey: ["api/trade/history"] }),
        queryClient.invalidateQueries({ queryKey: ["api/overview-mode"] }),
      ]);
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : "Paper reset failed");
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Lifecycle</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Open positions, closed trade history, exit reasons, and engine attribution
          </p>
        </div>
        {overview?.mode === "paper" && (
          <button
            onClick={() => void resetPaperTrading()}
            disabled={resetBusy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs font-semibold hover:bg-amber-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {resetBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            {resetBusy ? "Resetting Paper..." : "Reset Paper Trading"}
          </button>
        )}
      </div>
      {resetMsg && <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 text-xs text-green-400">{resetMsg}</div>}
      {resetErr && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">{resetErr}</div>}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Open
          </p>
          <p className="text-2xl font-bold tabular-nums text-amber-400">{openPositions.length}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">Float P&L</p>
          <p className={cn("text-2xl font-bold tabular-nums", floatingPnl >= 0 ? "text-green-400" : "text-red-400")}>
            {floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <BarChart2 className="w-3 h-3" /> Closed
          </p>
          <p className="text-2xl font-bold tabular-nums">{closedTrades.length}</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> Win Rate
          </p>
          <p className="text-2xl font-bold tabular-nums">
            {winRate != null ? `${winRate.toFixed(0)}%` : "—"}
          </p>
          {avgWin != null && avgLoss != null && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              W: +${avgWin.toFixed(2)} / L: ${avgLoss.toFixed(2)}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <TrendingDown className="w-3 h-3" /> Realised P&L
          </p>
          <p className={cn("text-2xl font-bold tabular-nums", totalPnl >= 0 ? "text-green-400" : "text-red-400")}>
            {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/50">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/50"
            )}>
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="tabular-nums text-muted-foreground/70">({t.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Open Positions */}
      {tab === "open" && (
        <div className="space-y-3">
          {openLoading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading positions…</p>
          ) : openPositions.length === 0 ? (
            <div className="text-center py-14">
              <CircleSlash className="w-10 h-10 text-muted-foreground/15 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No open positions</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Paper requires score ≥60 · Demo ≥65 · Real ≥70
              </p>
            </div>
          ) : (
            openPositions.map(pos => <OpenPositionRow key={pos.id} pos={pos} />)
          )}
        </div>
      )}

      {/* Closed Trades */}
      {tab === "closed" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)}
              className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="">All Symbols</option>
              {["BOOM300", "CRASH300", "R_75", "R_100", "BOOM1000", "CRASH1000"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select value={modeFilter} onChange={e => setModeFilter(e.target.value)}
              className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="">All Modes</option>
              <option value="paper">Paper</option>
              <option value="demo">Demo</option>
              <option value="real">Real</option>
            </select>
          </div>

          {closedLoading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading trade history…</p>
          ) : closedTrades.length === 0 ? (
            <div className="text-center py-14">
              <BarChart2 className="w-10 h-10 text-muted-foreground/15 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No closed trades{modeFilter || symbolFilter ? " matching filters" : ""}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Closed trades show entry, exit, hold time, and P&L</p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/40 bg-muted/10">
                      <th className="text-left py-2.5 px-4 font-medium">Symbol / Strategy</th>
                      <th className="text-left py-2.5 px-3 font-medium">Entry</th>
                      <th className="text-left py-2.5 px-3 font-medium">Entry Price</th>
                      <th className="text-left py-2.5 px-3 font-medium">Exit Price</th>
                      <th className="text-center py-2.5 px-3 font-medium">Exit Reason</th>
                      <th className="text-center py-2.5 px-3 font-medium">Hold</th>
                      <th className="text-right py-2.5 px-4 font-medium">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.map(t => <ClosedTradeRow key={t.id} t={t} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Attribution */}
      {tab === "attribution" && <AttributionSection closed={closedTrades} />}
    </div>
  );
}
