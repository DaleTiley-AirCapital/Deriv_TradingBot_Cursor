import React, { useState, useMemo } from "react";
import { useGetLatestSignals, useGetPendingSignals } from "@workspace/api-client-react";
import type { ScoringDimensions, GetLatestSignalsParams, SignalLog } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui-elements";
import { formatNumber, cn } from "@/lib/utils";
import { ClipboardList, ArrowUpRight, ArrowDownRight, Brain, ChevronDown, ChevronUp, Filter, X, ChevronLeft, ChevronRight, Download, ShieldAlert, Target, BarChart3, Clock, Layers } from "lucide-react";
import { downloadCSV, downloadJSON } from "@/lib/export";
import { motion, AnimatePresence } from "framer-motion";

const FAMILIES = ["trend_continuation", "mean_reversion", "spike_cluster_recovery", "swing_exhaustion", "trendline_breakout"] as const;

const STATUSES = ["approved", "blocked"] as const;
const AI_VERDICTS = ["agree", "disagree", "uncertain"] as const;

const FAMILY_LABELS: Record<string, string> = {
  trend_continuation: "Trend",
  mean_reversion: "Reversion",
  spike_cluster_recovery: "Spike Cluster",
  swing_exhaustion: "Swing Exhaust",
  trendline_breakout: "Trendline",
};

const FAMILY_COLORS: Record<string, string> = {
  trend_continuation: "bg-blue-500/12 text-blue-400 border-blue-500/25",
  mean_reversion: "bg-purple-500/12 text-purple-400 border-purple-500/25",
  spike_cluster_recovery: "bg-pink-500/12 text-pink-400 border-pink-500/25",
  swing_exhaustion: "bg-orange-500/12 text-orange-400 border-orange-500/25",
  trendline_breakout: "bg-cyan-500/12 text-cyan-400 border-cyan-500/25",
};

function AIVerdictBadge({ verdict, reasoning, blocked }: { verdict: string | null | undefined; reasoning: string | null | undefined; blocked?: boolean }) {
  const effectiveVerdict = verdict || (blocked ? "skipped" : null);
  if (!effectiveVerdict) return <span className="text-xs text-muted-foreground/50">—</span>;

  const styles: Record<string, string> = {
    agree: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25",
    disagree: "bg-red-500/12 text-red-400 border-red-500/25",
    uncertain: "bg-amber-500/12 text-amber-400 border-amber-500/25",
    skipped: "bg-slate-500/12 text-slate-400 border-slate-500/25",
    error: "bg-gray-500/12 text-gray-400 border-gray-500/25",
  };

  const labels: Record<string, string> = {
    agree: "Agree",
    disagree: "Disagree",
    uncertain: "Uncertain",
    skipped: "Skipped",
    error: "Error",
  };

  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border tracking-wide",
          styles[effectiveVerdict] || "bg-gray-500/12 text-gray-400 border-gray-500/25"
        )}
      >
        <Brain className="w-3 h-3" />
        {labels[effectiveVerdict] || effectiveVerdict}
      </span>
      {reasoning && effectiveVerdict !== "skipped" && (
        <span className="text-[10px] text-muted-foreground leading-snug">
          {reasoning}
        </span>
      )}
    </div>
  );
}

function CompositeScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-xs text-muted-foreground/50">—</span>;

  const color = score >= 85
    ? "text-emerald-400"
    : score >= 70
      ? "text-amber-400"
      : "text-red-400";

  const bg = score >= 85
    ? "bg-emerald-500/10 border-emerald-500/25"
    : score >= 70
      ? "bg-amber-500/10 border-amber-500/25"
      : "bg-red-500/10 border-red-500/25";

  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-sm font-bold border mono-num", color, bg)}>
      {Math.round(score)}
    </span>
  );
}

const DIMENSION_LABELS: Record<keyof ScoringDimensions, string> = {
  regimeFit: "Regime Fit",
  setupQuality: "Setup Quality",
  trendAlignment: "Trend Alignment",
  volatilityCondition: "Volatility",
  rewardRisk: "Reward/Risk",
  probabilityOfSuccess: "Probability",
};

function DimensionBar({ label, value }: { label: string; value: number }) {
  const color = value >= 80
    ? "bg-emerald-500"
    : value >= 60
      ? "bg-amber-500"
      : "bg-red-500";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-20 text-right shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] mono-num text-foreground w-6 text-right">{value}</span>
    </div>
  );
}

function BlockingCondition({ reason }: { reason: string }) {
  const patterns: { test: RegExp; gate: string; extract: (m: RegExpMatchArray) => string }[] = [
    { test: /composite.*?(\d+).*?below.*?(\d+)/i, gate: "Composite Score", extract: m => `Score ${m[1]} < threshold ${m[2]}` },
    { test: /composite.*?(\d+).*?<.*?(\d+)/i, gate: "Composite Score", extract: m => `Score ${m[1]} < threshold ${m[2]}` },
    { test: /RR.*?(\d+\.?\d*).*?below.*?(\d+\.?\d*)/i, gate: "Reward/Risk Ratio", extract: m => `RR ${m[1]} < minimum ${m[2]}` },
    { test: /RR.*?(\d+\.?\d*).*?<.*?(\d+\.?\d*)/i, gate: "Reward/Risk Ratio", extract: m => `RR ${m[1]} < minimum ${m[2]}` },
    { test: /EV.*?(-?\d+\.?\d*).*?below.*?(-?\d+\.?\d*)/i, gate: "Expected Value", extract: m => `EV ${m[1]} < minimum ${m[2]}` },
    { test: /kill.?switch/i, gate: "Kill Switch", extract: () => "Trading halted by kill switch" },
    { test: /daily.*loss/i, gate: "Daily Loss Limit", extract: () => "Daily loss limit reached" },
    { test: /weekly.*loss/i, gate: "Weekly Loss Limit", extract: () => "Weekly loss limit reached" },
    { test: /max.*drawdown/i, gate: "Max Drawdown", extract: () => "Maximum drawdown exceeded" },
    { test: /open.*risk/i, gate: "Open Risk Limit", extract: () => "Too much open risk" },
    { test: /max.*open.*trades/i, gate: "Max Open Trades", extract: () => "Maximum open trades reached" },
    { test: /AI disagree/i, gate: "AI Verification", extract: () => "AI disagreed with signal" },
    { test: /intelligence only/i, gate: "Mode", extract: () => "No execution mode active" },
  ];

  let gateName: string | null = null;
  let gateDetail: string | null = null;

  for (const p of patterns) {
    const match = reason.match(p.test);
    if (match) {
      gateName = p.gate;
      gateDetail = p.extract(match);
      break;
    }
  }

  return (
    <div className="p-2 rounded-md bg-red-500/8 border border-red-500/20 space-y-1">
      {gateName && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-red-400/80">Blocking Gate</span>
          <span className="text-[11px] font-semibold text-red-400">{gateName}</span>
        </div>
      )}
      {gateDetail && <p className="text-[10px] text-red-400/70">{gateDetail}</p>}
      <p className="text-[10px] text-red-400/60 leading-relaxed">{reason}</p>
    </div>
  );
}

function SignalDetailPanel({ sig }: { sig: SignalLog }) {
  const tp = sig.suggestedTp != null ? Math.abs(sig.suggestedTp) : null;
  const sl = sig.suggestedSl != null ? Math.abs(sig.suggestedSl) : null;
  const rr = sl && sl > 0 && tp ? (tp / sl) : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-card/50 border-t border-border/30">
      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-primary" />
          Scoring Breakdown
        </h4>
        {sig.scoringDimensions ? (
          <div className="space-y-1.5">
            {(Object.keys(DIMENSION_LABELS) as (keyof ScoringDimensions)[]).map((key) => (
              <DimensionBar key={key} label={DIMENSION_LABELS[key]} value={sig.scoringDimensions[key]} />
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">No dimension data</p>
        )}

        <div className="pt-2 border-t border-border/20 space-y-1">
          <DetailRow label="Composite" value={sig.compositeScore != null ? Math.round(sig.compositeScore).toString() : "—"} />
          <DetailRow label="Raw Score" value={formatNumber(sig.score, 3)} />
          <DetailRow label="Expected Value" value={formatNumber(sig.expectedValue, 4)} highlight={sig.expectedValue > 0 ? "green" : "red"} />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5 text-primary" />
          Trade Parameters
        </h4>
        <div className="space-y-1">
          <DetailRow label="Direction" value={sig.direction?.toUpperCase() ?? "—"} />
          <DetailRow label="Strategy" value={sig.strategyName ?? "—"} />
          <DetailRow label="Family" value={FAMILY_LABELS[sig.strategyFamily ?? ""] ?? sig.strategyFamily ?? "—"} />
          <DetailRow label="Entry Price" value={sig.allowedFlag ? "Set at execution" : "N/A (blocked)"} />
          <DetailRow label="Take Profit (offset)" value={tp != null ? formatNumber(tp, 4) : "—"} highlight="green" />
          <DetailRow label="Stop Loss (offset)" value={sl != null ? formatNumber(sl, 4) : "—"} highlight="red" />
          <DetailRow label="R:R Ratio" value={rr != null ? `${rr.toFixed(2)}:1` : "—"} />
          <DetailRow label="Allocation" value={sig.allocationPct != null ? `${sig.allocationPct.toFixed(1)}%` : "—"} />
          <DetailRow label="Mode" value={sig.mode ?? "—"} />
        </div>

        {sig.regime && (
          <div className="pt-2 border-t border-border/20 space-y-1">
            <DetailRow label="Regime" value={sig.regime} />
            <DetailRow label="Confidence" value={sig.regimeConfidence != null ? `${(sig.regimeConfidence * 100).toFixed(0)}%` : "—"} />
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-primary" />
          Decision & AI
        </h4>

        <div className="space-y-1">
          <DetailRow label="Status" value={sig.allowedFlag ? "Approved" : "Blocked"} highlight={sig.allowedFlag ? "green" : "red"} />
          {!sig.allowedFlag && sig.rejectionReason && (
            <div className="mt-1 space-y-1.5">
              <BlockingCondition reason={sig.rejectionReason} />
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-border/20">
          <DetailRow label="AI Verdict" value={sig.aiVerdict || (!sig.allowedFlag ? "Skipped" : "—")} />
          {(sig.aiVerdict === "skipped" || (!sig.aiVerdict && !sig.allowedFlag)) && (
            <div className="mt-1 p-2 rounded-md bg-slate-500/8 border border-slate-500/20">
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Signal was blocked by a system gate before reaching AI verification.
              </p>
            </div>
          )}
          {sig.aiReasoning && sig.aiVerdict !== "skipped" && (
            <div className="mt-1 p-2 rounded-md bg-muted/30 border border-border/30">
              <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{sig.aiReasoning}</p>
            </div>
          )}
          {sig.aiConfidenceAdj != null && sig.aiConfidenceAdj !== 0 && (
            <DetailRow label="AI Confidence Adj" value={`${sig.aiConfidenceAdj > 0 ? "+" : ""}${sig.aiConfidenceAdj}`} />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: "green" | "red" }) {
  const valClass = highlight === "green" ? "text-emerald-400" : highlight === "red" ? "text-red-400" : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn("text-[11px] mono-num font-medium", valClass)}>{value}</span>
    </div>
  );
}

function FilterSelect({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[] | string[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
    >
      <option value="">{placeholder}</option>
      {options.map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

const PAGE_SIZE = 50;

export default function Signals() {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [familyFilter, setFamilyFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [aiFilter, setAiFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const params: GetLatestSignalsParams = useMemo(() => {
    const p: GetLatestSignalsParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (symbolFilter) p.symbol = symbolFilter;
    if (familyFilter) p.family = familyFilter;
    if (statusFilter) p.status = statusFilter;
    if (aiFilter) p.ai = aiFilter;
    return p;
  }, [symbolFilter, familyFilter, statusFilter, aiFilter, page]);

  const { data, isLoading } = useGetLatestSignals(params, { query: { refetchInterval: 5000 } });
  const { data: pendingData } = useGetPendingSignals({ query: { refetchInterval: 5000 } });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const visThreshold = data?.visibilityThreshold ?? 70;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasFilters = symbolFilter || familyFilter || statusFilter || aiFilter || dateFrom || dateTo;

  const dateFilteredSignals = useMemo(() => {
    if (!dateFrom && !dateTo) return signals;
    return signals.filter(sig => {
      const d = new Date(sig.ts);
      if (dateFrom && d < new Date(dateFrom)) return false;
      if (dateTo) {
        const end = new Date(dateTo);
        end.setDate(end.getDate() + 1);
        if (d >= end) return false;
      }
      return true;
    });
  }, [signals, dateFrom, dateTo]);

  function exportSignalsCSV() {
    downloadCSV(dateFilteredSignals.map(s => ({
      time: new Date(s.ts).toISOString(), symbol: s.symbol, family: s.strategyFamily,
      strategy: s.strategyName, direction: s.direction, compositeScore: s.compositeScore,
      score: s.score, expectedValue: s.expectedValue, regime: s.regime,
      regimeConfidence: s.regimeConfidence, allocationPct: s.allocationPct,
      suggestedTp: s.suggestedTp, suggestedSl: s.suggestedSl,
      status: s.allowedFlag ? "approved" : "blocked", rejectionReason: s.rejectionReason,
      aiVerdict: s.aiVerdict, aiReasoning: s.aiReasoning, mode: s.mode,
    })), "signals_log");
  }

  function exportSignalsJSON() {
    downloadJSON(dateFilteredSignals, "signals_log");
  }

  const symbols = useMemo(() => {
    const s = new Set<string>();
    signals.forEach(sig => s.add(sig.symbol));
    return Array.from(s).sort();
  }, [signals]);

  function clearFilters() {
    setSymbolFilter("");
    setFamilyFilter("");
    setStatusFilter("");
    setAiFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Decision Review</h1>
          <p className="page-subtitle">Signal decisions above {visThreshold} composite score</p>
        </div>
        <div className="text-xs text-muted-foreground mono-num">
          {total} total
        </div>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />

            <FilterSelect value={symbolFilter} onChange={v => { setSymbolFilter(v); setPage(0); }} options={symbols.length > 0 ? symbols : ["BOOM1000","BOOM500","CRASH1000","CRASH500","R_75","R_100"]} placeholder="Symbol" />
            <FilterSelect value={familyFilter} onChange={v => { setFamilyFilter(v); setPage(0); }} options={FAMILIES} placeholder="Family" />
            <FilterSelect value={statusFilter} onChange={v => { setStatusFilter(v); setPage(0); }} options={STATUSES} placeholder="Status" />
            <FilterSelect value={aiFilter} onChange={v => { setAiFilter(v); setPage(0); }} options={AI_VERDICTS} placeholder="AI" />

            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(0); }}
              className="bg-card border border-border/50 rounded-md px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none" />
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(0); }}
              className="bg-card border border-border/50 rounded-md px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none" />

            {hasFilters && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {pendingData && pendingData.count > 0 && (
        <Card className="border-amber-500/20">
          <CardHeader>
            <CardTitle>
              <Clock className="w-4 h-4 text-amber-400" />
              Pending Confirmations ({pendingData.count})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid gap-3 p-4">
              {pendingData.signals.map((ps) => (
                <div key={`${ps.symbol}-${ps.strategyName}-${ps.direction}`} className="rounded-xl border border-border/60 p-4 bg-muted/15">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      {ps.direction === "buy"
                        ? <span className="inline-flex items-center gap-1 text-success text-xs font-semibold"><ArrowUpRight className="w-3.5 h-3.5" />BUY</span>
                        : <span className="inline-flex items-center gap-1 text-destructive text-xs font-semibold"><ArrowDownRight className="w-3.5 h-3.5" />SELL</span>}
                      <span className="font-semibold text-foreground">{ps.symbol}</span>
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border", FAMILY_COLORS[ps.strategyFamily] || "bg-gray-500/12 text-gray-400 border-gray-500/25")}>
                        {FAMILY_LABELS[ps.strategyFamily] || ps.strategyFamily}
                      </span>
                      {ps.pyramidLevel > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          <Layers className="w-3 h-3 mr-1" />
                          Pyramid L{ps.pyramidLevel + 1}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <CompositeScoreBadge score={ps.lastCompositeScore} />
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground">Confirmation Progress</span>
                        <span className="text-xs font-semibold mono-num text-amber-400">{ps.confirmCount}/{ps.requiredConfirmations} windows</span>
                      </div>
                      <div className="h-2 bg-muted/50 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-500 transition-all"
                          style={{ width: `${ps.progressPct}%` }}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs shrink-0">
                      <div>
                        <span className="text-muted-foreground block text-[10px]">EV</span>
                        <span className={cn("mono-num font-semibold", ps.lastExpectedValue > 0 ? "text-success" : "text-destructive")}>
                          {formatNumber(ps.lastExpectedValue, 4)}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block text-[10px]">Tracking</span>
                        <span className="mono-num text-foreground text-[11px]">
                          {(() => {
                            const mins = Math.floor((Date.now() - new Date(ps.firstDetectedAt).getTime()) / 60000);
                            if (mins < 1) return "<1m";
                            if (mins < 60) return `${mins}m`;
                            return `${Math.floor(mins / 60)}h ${mins % 60}m`;
                          })()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <ClipboardList className="w-4 h-4 text-primary" />
            Decision Log
          </CardTitle>
          <div className="flex items-center gap-3">
            <button onClick={exportSignalsCSV} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
              <Download className="w-3 h-3" /> CSV
            </button>
            <button onClick={exportSignalsJSON} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
              <Download className="w-3 h-3" /> JSON
            </button>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1 rounded hover:bg-muted/50 disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs mono-num text-muted-foreground px-1">
                  {page + 1}/{totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1 rounded hover:bg-muted/50 disabled:opacity-30 transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th className="w-6"></th>
                <th>Time</th>
                <th>Symbol</th>
                <th>Family</th>
                <th>Dir</th>
                <th className="text-right">Composite</th>
                <th className="text-right">Score</th>
                <th className="text-right">EV</th>
                <th>Regime</th>
                <th className="text-right">Alloc%</th>
                <th>Status</th>
                <th>AI</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={12} className="text-center py-10 text-muted-foreground">Loading decisions…</td></tr>
              ) : signals.length === 0 ? (
                <tr><td colSpan={12} className="text-center py-16 text-muted-foreground">
                  <div className="flex flex-col items-center gap-3">
                    <ClipboardList className="w-8 h-8 text-muted-foreground/40" />
                    {hasFilters ? (
                      <>
                        <p className="text-sm font-medium">No decisions match your filters</p>
                        <button onClick={clearFilters} className="text-xs text-primary hover:underline">Clear all filters</button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">No signal decisions logged yet</p>
                        <p className="text-xs text-muted-foreground/70 max-w-md leading-relaxed">
                          The scanner logs decisions when streaming is active and tick data is flowing.
                          Go to <a href="/data" className="text-primary hover:underline">Data</a> to start streaming,
                          then signals with a composite score &ge; {visThreshold} will appear here.
                        </p>
                      </>
                    )}
                  </div>
                </td></tr>
              ) : (
                signals.map((sig) => {
                  const isExpanded = expandedId === sig.id;
                  return (
                    <React.Fragment key={sig.id}>
                      <tr
                        className={cn(
                          !sig.allowedFlag && "opacity-60",
                          "cursor-pointer hover:bg-muted/30 transition-colors",
                          isExpanded && "bg-muted/20 opacity-100"
                        )}
                        onClick={() => setExpandedId(isExpanded ? null : sig.id)}
                      >
                        <td className="w-6 text-center">
                          {isExpanded
                            ? <ChevronUp className="w-3.5 h-3.5 text-primary inline-block" />
                            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground inline-block" />
                          }
                        </td>
                        <td className="mono-num text-muted-foreground text-xs whitespace-nowrap">
                          {new Date(sig.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                          {new Date(sig.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </td>
                        <td className="font-semibold text-foreground text-sm">{sig.symbol}</td>
                        <td>
                          {sig.strategyFamily ? (
                            <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border", FAMILY_COLORS[sig.strategyFamily] || "bg-gray-500/12 text-gray-400 border-gray-500/25")}>
                              {FAMILY_LABELS[sig.strategyFamily] || sig.strategyFamily}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">{sig.strategyName}</span>
                          )}
                        </td>
                        <td>
                          {sig.direction === "buy"
                            ? <span className="inline-flex items-center gap-1 text-success text-xs font-semibold"><ArrowUpRight className="w-3.5 h-3.5" />BUY</span>
                            : sig.direction === "sell"
                            ? <span className="inline-flex items-center gap-1 text-destructive text-xs font-semibold"><ArrowDownRight className="w-3.5 h-3.5" />SELL</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="text-right">
                          <CompositeScoreBadge score={sig.compositeScore} />
                        </td>
                        <td className="text-right mono-num text-xs text-muted-foreground">{formatNumber(sig.score, 2)}</td>
                        <td className={cn("text-right mono-num text-xs", sig.expectedValue > 0 ? "text-success" : "text-destructive")}>
                          {formatNumber(sig.expectedValue, 4)}
                        </td>
                        <td>
                          {sig.regime ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-xs text-foreground">{sig.regime}</span>
                              {sig.regimeConfidence != null && (
                                <span className="text-[10px] mono-num text-muted-foreground">{(sig.regimeConfidence * 100).toFixed(0)}%</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="text-right mono-num text-xs">
                          {sig.allocationPct != null ? (
                            <span className="text-foreground">{sig.allocationPct.toFixed(0)}%</span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td>
                          {sig.allowedFlag ? (
                            <Badge variant="success">Approved</Badge>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              <Badge variant="destructive">Blocked</Badge>
                              {sig.rejectionReason && (
                                <span className="text-[10px] text-muted-foreground leading-snug">
                                  {sig.rejectionReason}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          <AIVerdictBadge verdict={sig.aiVerdict} reasoning={sig.aiReasoning} blocked={!sig.allowedFlag} />
                        </td>
                      </tr>
                      <AnimatePresence>
                        {isExpanded && (
                          <tr>
                            <td colSpan={12} className="p-0">
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                              >
                                <SignalDetailPanel sig={sig} />
                              </motion.div>
                            </td>
                          </tr>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
