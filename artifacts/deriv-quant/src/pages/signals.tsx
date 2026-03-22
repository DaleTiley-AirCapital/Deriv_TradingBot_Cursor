import React, { useState, useMemo } from "react";
import { useGetLatestSignals } from "@workspace/api-client-react";
import type { ScoringDimensions, GetLatestSignalsParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui-elements";
import { formatNumber, cn } from "@/lib/utils";
import { ClipboardList, ArrowUpRight, ArrowDownRight, Brain, ChevronDown, ChevronUp, Filter, X, ChevronLeft, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const FAMILIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"] as const;
const MODES = ["paper", "demo", "real"] as const;
const STATUSES = ["approved", "blocked"] as const;
const AI_VERDICTS = ["agree", "disagree", "uncertain"] as const;

const FAMILY_LABELS: Record<string, string> = {
  trend_continuation: "Trend",
  mean_reversion: "Reversion",
  breakout_expansion: "Breakout",
  spike_event: "Spike",
};

const FAMILY_COLORS: Record<string, string> = {
  trend_continuation: "bg-blue-500/12 text-blue-400 border-blue-500/25",
  mean_reversion: "bg-purple-500/12 text-purple-400 border-purple-500/25",
  breakout_expansion: "bg-orange-500/12 text-orange-400 border-orange-500/25",
  spike_event: "bg-pink-500/12 text-pink-400 border-pink-500/25",
};

function AIVerdictBadge({ verdict, reasoning }: { verdict: string | null | undefined; reasoning: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);

  if (!verdict) return <span className="text-xs text-muted-foreground/50">—</span>;

  const styles: Record<string, string> = {
    agree: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25",
    disagree: "bg-red-500/12 text-red-400 border-red-500/25",
    uncertain: "bg-amber-500/12 text-amber-400 border-amber-500/25",
    error: "bg-gray-500/12 text-gray-400 border-gray-500/25",
  };

  const labels: Record<string, string> = {
    agree: "Agree",
    disagree: "Disagree",
    uncertain: "Uncertain",
    error: "Error",
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border tracking-wide cursor-pointer transition-opacity hover:opacity-80",
          styles[verdict] || "bg-gray-500/12 text-gray-400 border-gray-500/25"
        )}
      >
        <Brain className="w-3 h-3" />
        {labels[verdict] || verdict}
        {reasoning && (expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
      </button>
      <AnimatePresence>
        {expanded && reasoning && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="text-xs text-muted-foreground italic max-w-[220px] leading-relaxed"
          >
            {reasoning}
          </motion.div>
        )}
      </AnimatePresence>
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

function DimensionsBreakdown({ dimensions }: { dimensions: ScoringDimensions | null | undefined }) {
  const [expanded, setExpanded] = useState(false);

  if (!dimensions) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-primary/70 hover:text-primary transition-colors flex items-center gap-0.5"
      >
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {expanded ? "Hide" : "Details"}
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 space-y-1 min-w-[200px]"
          >
            {(Object.keys(DIMENSION_LABELS) as (keyof ScoringDimensions)[]).map((key) => (
              <DimensionBar key={key} label={DIMENSION_LABELS[key]} value={dimensions[key]} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FilterPill({ label, active, onClick, onClear }: { label: string; active: boolean; onClick: () => void; onClear?: () => void }) {
  return (
    <button
      onClick={active && onClear ? onClear : onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-all",
        active
          ? "bg-primary/15 text-primary border-primary/30"
          : "bg-card text-muted-foreground border-border/50 hover:border-border"
      )}
    >
      {label}
      {active && onClear && <X className="w-3 h-3" />}
    </button>
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
  const [modeFilter, setModeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [aiFilter, setAiFilter] = useState("");
  const [page, setPage] = useState(0);

  const params: GetLatestSignalsParams = useMemo(() => {
    const p: GetLatestSignalsParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (symbolFilter) p.symbol = symbolFilter;
    if (familyFilter) p.family = familyFilter;
    if (modeFilter) p.mode = modeFilter;
    if (statusFilter) p.status = statusFilter;
    if (aiFilter) p.ai = aiFilter;
    return p;
  }, [symbolFilter, familyFilter, modeFilter, statusFilter, aiFilter, page]);

  const { data, isLoading } = useGetLatestSignals(params, { query: { refetchInterval: 5000 } });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const visThreshold = data?.visibilityThreshold ?? 75;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasFilters = symbolFilter || familyFilter || modeFilter || statusFilter || aiFilter;

  const symbols = useMemo(() => {
    const s = new Set<string>();
    signals.forEach(sig => s.add(sig.symbol));
    return Array.from(s).sort();
  }, [signals]);

  function clearFilters() {
    setSymbolFilter("");
    setFamilyFilter("");
    setModeFilter("");
    setStatusFilter("");
    setAiFilter("");
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
            <FilterSelect value={modeFilter} onChange={v => { setModeFilter(v); setPage(0); }} options={MODES} placeholder="Mode" />
            <FilterSelect value={statusFilter} onChange={v => { setStatusFilter(v); setPage(0); }} options={STATUSES} placeholder="Status" />
            <FilterSelect value={aiFilter} onChange={v => { setAiFilter(v); setPage(0); }} options={AI_VERDICTS} placeholder="AI" />

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

      <Card>
        <CardHeader>
          <CardTitle>
            <ClipboardList className="w-4 h-4 text-primary" />
            Decision Log
          </CardTitle>
          <div className="flex items-center gap-3">
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
                <th>Time</th>
                <th>Symbol</th>
                <th>Family</th>
                <th>Dir</th>
                <th className="text-right">Composite</th>
                <th className="text-right">Score</th>
                <th className="text-right">EV</th>
                <th>Regime</th>
                <th>Mode</th>
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
                signals.map((sig) => (
                  <tr key={sig.id} className={cn(!sig.allowedFlag && "opacity-60")}>
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
                      <div className="flex flex-col items-end gap-0.5">
                        <CompositeScoreBadge score={sig.compositeScore} />
                        <DimensionsBreakdown dimensions={sig.scoringDimensions} />
                      </div>
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
                    <td>
                      {sig.mode ? (
                        <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                          sig.mode === "paper" ? "bg-blue-500/12 text-blue-400 border border-blue-500/25" :
                          sig.mode === "demo" ? "bg-amber-500/12 text-amber-400 border border-amber-500/25" :
                          "bg-emerald-500/12 text-emerald-400 border border-emerald-500/25"
                        )}>
                          {sig.mode}
                        </span>
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
                            <span className="text-[10px] text-muted-foreground truncate max-w-[140px]" title={sig.rejectionReason}>
                              {sig.rejectionReason}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <AIVerdictBadge verdict={sig.aiVerdict} reasoning={sig.aiReasoning} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
