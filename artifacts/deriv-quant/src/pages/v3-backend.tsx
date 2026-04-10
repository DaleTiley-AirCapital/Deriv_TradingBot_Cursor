/**
 * V3 BACKEND VERIFICATION — TEMPORARY ADMIN SURFACE
 *
 * This page is a purposefully minimal but functionally real admin surface
 * that exposes the backend capabilities built in Task #92.
 *
 * It is NOT the final V3 UI rebuild.
 * It exists to validate the backend before the full UI redesign.
 *
 * All data comes directly from real backend endpoints.
 * No fake data. No silent fallbacks. Errors surface loudly.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Shield,
  RefreshCw,
  Play,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Database,
  Layers,
  Wifi,
  Brain,
  Download,
  Radio,
  Cpu,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";

function api(path: string) {
  return `${BASE}api/${path.replace(/^\//, "")}`;
}

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(api(path), opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const d = await res.json(); msg = d.error ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ─── Shared primitives ────────────────────────────────────────────────────

function Badge({ label, variant = "default" }: { label: string; variant?: "ok" | "warn" | "error" | "info" | "default" }) {
  const cls = {
    ok:      "bg-green-500/15 text-green-400 border-green-500/25",
    warn:    "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    error:   "bg-red-500/15 text-red-400 border-red-500/25",
    info:    "bg-primary/15 text-primary border-primary/25",
    default: "bg-muted/40 text-muted-foreground border-border/50",
  }[variant];
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cls)}>
      {label}
    </span>
  );
}

function Pill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <Badge label={yes} variant="ok" />
    : <Badge label={no} variant="error" />;
}

function Btn({
  label, icon: Icon, onClick, loading = false, variant = "default", small = false,
}: {
  label: string; icon?: React.ElementType; onClick: () => void; loading?: boolean;
  variant?: "default" | "primary" | "danger"; small?: boolean;
}) {
  const cls = {
    default: "bg-muted/40 border-border/50 text-foreground hover:bg-muted/70",
    primary: "bg-primary/15 border-primary/30 text-primary hover:bg-primary/25",
    danger:  "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25",
  }[variant];
  return (
    <button
      disabled={loading}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border font-medium transition-all",
        small ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
        cls,
        loading && "opacity-60 cursor-not-allowed",
      )}
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : Icon && <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}

function Section({ title, icon: Icon, children, badge }: {
  title: string; icon: React.ElementType; children: React.ReactNode; badge?: React.ReactNode;
}) {
  return (
    <div className="glass-panel rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border/50 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        {badge}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function Spinner() {
  return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto my-6" />;
}

function KV({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{k}</span>
      <span className={cn("text-xs text-foreground text-right break-all", mono && "font-mono")}>{v}</span>
    </div>
  );
}

function Table({
  cols, rows, emptyMsg = "No data",
}: {
  cols: string[]; rows: React.ReactNode[][]; emptyMsg?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/40">
            {cols.map(c => (
              <th key={c} className="text-left py-2 px-2 text-muted-foreground font-medium uppercase tracking-wider text-[10px] first:pl-0">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="text-center py-6 text-muted-foreground text-xs">{emptyMsg}</td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="border-b border-border/20 hover:bg-muted/10 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="py-2 px-2 first:pl-0 font-mono">{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Symbol selector ─────────────────────────────────────────────────────

// All 28 researchable symbols: 12 V1 trading symbols + 16 research-only
const ALL_SYMBOLS = [
  // V1 — trading + data collection
  "BOOM1000","CRASH1000","BOOM900","CRASH900","BOOM600","CRASH600",
  "BOOM500","CRASH500","BOOM300","CRASH300","R_75","R_100",
  // Research-only
  "R_10","R_25","R_50",
  "RDBULL","RDBEAR",
  "JD10","JD25","JD50","JD75","JD100",
  "stpRNG","stpRNG2","stpRNG3","stpRNG5",
  "RB100","RB200",
];

const ACTIVE_SYMBOLS = ["CRASH300","BOOM300","R_75","R_100"];

function SymbolSelect({ value, onChange, includeAll = false }: {
  value: string; onChange: (s: string) => void; includeAll?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="text-xs bg-background border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50"
    >
      {includeAll && <option value="">— All symbols —</option>}
      {ALL_SYMBOLS.map(s => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

// ─── TAB: Integrity ──────────────────────────────────────────────────────

function IntegrityTab() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [grid, setGrid] = useState<any[] | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [fullReport, setFullReport] = useState<any | null>(null);
  const [fullReportLoading, setFullReportLoading] = useState(false);
  const [fullReportErr, setFullReportErr] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [days, setDays] = useState(30);

  const loadGrid = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity?days=${days}&full=${showFull}`);
      setGrid(d.results ?? []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [days, showFull]);

  const loadDetail = useCallback(async (sym: string) => {
    setDetailLoading(true);
    setDetailErr(null);
    setDetailData(null);
    setFullReport(null);
    setFullReportErr(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity/${sym}`);
      setDetailData(d);
    } catch (e: any) {
      setDetailErr(e.message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadFullReport = useCallback(async (sym: string, lookbackDays: number) => {
    setFullReportLoading(true);
    setFullReportErr(null);
    setFullReport(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity/${sym}/full?lookbackDays=${lookbackDays}`);
      setFullReport(d);
    } catch (e: any) {
      setFullReportErr(e.message);
    } finally {
      setFullReportLoading(false);
    }
  }, []);

  useEffect(() => { loadGrid(); }, []);

  // Pivot: group by symbol, TFs as columns
  const TFS = ["1m","5m","10m","20m","40m","1h","2h","4h","8h","1d","2d","4d"];

  // Build lookup: symbol+tf => row
  const lookup = new Map<string, any>();
  (grid ?? []).forEach(r => lookup.set(`${r.symbol}|${r.timeframe}`, r));

  const symbols = [...new Set((grid ?? []).map((r: any) => r.symbol))];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Lookback:</span>
          {[7,30,90,365].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn("px-2 py-1 rounded border text-xs transition-colors",
                days === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 hover:border-border text-muted-foreground"
              )}
            >{d}d</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={showFull} onChange={e => setShowFull(e.target.checked)} className="w-3 h-3" />
          Full (include gaps)
        </label>
        <Btn label="Refresh" icon={RefreshCw} onClick={loadGrid} loading={loading} small />
      </div>

      {err && <ErrorBox msg={err} />}

      <Section title="All-Symbol Integrity Grid" icon={Shield}
        badge={grid && <Badge label={`${grid.filter((r:any) => r.isHealthy).length}/${grid.length} healthy`} variant={grid.every((r:any) => r.isHealthy) ? "ok" : "warn"} />}
      >
        {loading && !grid ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border/40">
                  <th className="text-left py-2 text-muted-foreground text-[10px] uppercase tracking-wider pr-3 sticky left-0 bg-background/80">Symbol</th>
                  {TFS.map(tf => (
                    <th key={tf} className="text-center py-2 px-1 text-muted-foreground text-[10px] uppercase tracking-wider">{tf}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbols.map(sym => (
                  <tr
                    key={sym}
                    className={cn("border-b border-border/20 cursor-pointer hover:bg-muted/10 last:border-0",
                      selectedSymbol === sym && "bg-primary/5")}
                    onClick={() => {
                      setSelectedSymbol(sym === selectedSymbol ? null : sym);
                      if (sym !== selectedSymbol) loadDetail(sym);
                    }}
                  >
                    <td className="py-2 pr-3 font-mono font-medium text-foreground sticky left-0 bg-background/80">
                      <div className="flex items-center gap-1">
                        {selectedSymbol === sym ? <ChevronDown className="w-3 h-3 text-primary" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                        <span className={cn(ACTIVE_SYMBOLS.includes(sym) ? "text-primary" : "text-foreground")}>{sym}</span>
                        {ACTIVE_SYMBOLS.includes(sym) && <span className="text-[9px] text-primary/60">●</span>}
                      </div>
                    </td>
                    {TFS.map(tf => {
                      const r = lookup.get(`${sym}|${tf}`);
                      if (!r) return <td key={tf} className="text-center px-1">—</td>;
                      const healthy = r.isHealthy;
                      const cnt = r.totalCandles ?? 0;
                      return (
                        <td key={tf} className="text-center px-1 py-2">
                          <span
                            title={`${sym}/${tf}: ${cnt.toLocaleString()} candles, last=${r.lastDate ?? "never"}${r.gapCount > 0 ? `, gaps=${r.gapCount}` : ""}`}
                            className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] font-mono",
                              cnt === 0 ? "text-muted-foreground/40" :
                              healthy ? "text-green-400" : "text-yellow-400"
                            )}
                          >
                            {cnt === 0 ? "—" : cnt >= 1000 ? `${(cnt/1000).toFixed(0)}k` : cnt}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground mt-2">Click a row to expand. Green = healthy. Yellow = data exists but gaps/issues. — = no data. Active trading symbols shown in blue.</p>
          </div>
        )}
      </Section>

      {selectedSymbol && (
        <Section title={`Detail: ${selectedSymbol}`} icon={Database}>
          {detailLoading && <Spinner />}
          {detailErr && <ErrorBox msg={detailErr} />}
          {detailData && !detailLoading && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">1m Candles</div>
                  <div className="text-sm font-mono font-bold text-foreground">{(detailData.base1mCount ?? 0).toLocaleString()}</div>
                </div>
                <div className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">TFs Ready</div>
                  <div className="text-sm font-mono font-bold text-green-400">{detailData.enrichmentSummary?.ready ?? 0}</div>
                </div>
                <div className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">TFs Empty</div>
                  <div className="text-sm font-mono font-bold text-yellow-400">{detailData.enrichmentSummary?.empty ?? 0}</div>
                </div>
                <div className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">No Base</div>
                  <div className="text-sm font-mono font-bold text-red-400">{detailData.enrichmentSummary?.noBase ?? 0}</div>
                </div>
              </div>
              <Table
                cols={["TF", "Count", "First Date", "Last Date", "Status"]}
                rows={(detailData.timeframes ?? []).map((t: any) => [
                  <span className="font-semibold">{t.timeframe}</span>,
                  t.count.toLocaleString(),
                  t.firstDate ?? "—",
                  t.lastDate ?? "—",
                  <Badge label={t.status} variant={t.status === "ready" ? "ok" : t.status === "empty" ? "warn" : "error"} />,
                ])}
              />

              <div className="border-t border-border/20 pt-3">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-semibold text-foreground">Full Gap Report</span>
                  <span className="text-[10px] text-muted-foreground">(runs gap detection across all 12 TFs — may take a moment)</span>
                  <div className="flex gap-1.5 ml-auto">
                    {[30,90,365].map(d => (
                      <button
                        key={d}
                        onClick={() => loadFullReport(selectedSymbol, d)}
                        className="px-2 py-1 rounded border border-border/40 hover:border-primary/40 hover:bg-primary/10 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                      >{d}d</button>
                    ))}
                  </div>
                </div>
                {fullReportLoading && <Spinner />}
                {fullReportErr && <ErrorBox msg={fullReportErr} />}
                {fullReport && !fullReportLoading && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-muted/20 rounded-lg p-3">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Overall Health</div>
                        <div className={cn("text-sm font-mono font-bold", fullReport.overallHealthy ? "text-green-400" : "text-yellow-400")}>
                          {fullReport.overallHealthy ? "Healthy" : "Issues Detected"}
                        </div>
                      </div>
                      <div className="bg-muted/20 rounded-lg p-3">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Total Gaps</div>
                        <div className={cn("text-sm font-mono font-bold", (fullReport.totalGaps ?? 0) === 0 ? "text-green-400" : "text-yellow-400")}>
                          {(fullReport.totalGaps ?? 0).toLocaleString()}
                        </div>
                      </div>
                      <div className="bg-muted/20 rounded-lg p-3">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Missing Candles</div>
                        <div className={cn("text-sm font-mono font-bold", (fullReport.totalMissingCandles ?? 0) === 0 ? "text-green-400" : "text-yellow-400")}>
                          {(fullReport.totalMissingCandles ?? 0).toLocaleString()}
                        </div>
                      </div>
                      <div className="bg-muted/20 rounded-lg p-3">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Interpolated</div>
                        <div className={cn("text-sm font-mono font-bold", (fullReport.totalInterpolated ?? 0) === 0 ? "text-muted-foreground" : "text-orange-400")}>
                          {(fullReport.totalInterpolated ?? 0).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <Table
                      cols={["TF", "Candles", "Coverage", "Gaps", "Missing", "Interp.", "First", "Last", "Health"]}
                      rows={(fullReport.timeframes ?? []).map((t: any) => [
                        <span className="font-semibold">{t.timeframe}</span>,
                        (t.count ?? 0).toLocaleString(),
                        <span className={cn((t.coveragePct ?? 0) >= 95 ? "text-green-400" : (t.coveragePct ?? 0) >= 80 ? "text-yellow-400" : "text-red-400")}>
                          {t.coveragePct != null ? `${t.coveragePct.toFixed(1)}%` : "—"}
                        </span>,
                        <span className={cn((t.gapCount ?? 0) === 0 ? "text-muted-foreground" : "text-yellow-400")}>
                          {t.gapCount ?? 0}
                        </span>,
                        <span className={cn((t.missingCandles ?? 0) === 0 ? "text-muted-foreground" : "text-yellow-400")}>
                          {(t.missingCandles ?? 0).toLocaleString()}
                        </span>,
                        <span className={cn((t.interpolatedCount ?? 0) === 0 ? "text-muted-foreground" : "text-orange-400")}>
                          {t.interpolatedCount ?? 0}
                        </span>,
                        <span className="text-[10px]">{t.firstDate ?? "—"}</span>,
                        <span className="text-[10px]">{t.lastDate ?? "—"}</span>,
                        <Badge label={t.isHealthy ? "ok" : "issues"} variant={t.isHealthy ? "ok" : "warn"} />,
                      ])}
                    />
                    <p className="text-[10px] text-muted-foreground">Coverage = actual candles ÷ expected candles in window. Interpolated candles are carry-forward fills — excluded from signal generation.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ─── TAB: Enrichment ─────────────────────────────────────────────────────

function EnrichmentTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [status, setStatus] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<any | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);

  const loadStatus = useCallback(async (sym: string) => {
    setLoading(true);
    setErr(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity/${sym}`);
      setStatus(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(symbol); }, [symbol]);

  const runEnrich = async () => {
    setEnriching(true);
    setEnrichErr(null);
    setEnrichResult(null);
    try {
      const d = await apiFetch("research/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      setEnrichResult(d.result);
      await loadStatus(symbol);
    } catch (e: any) {
      setEnrichErr(e.message);
    } finally {
      setEnriching(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setEnrichResult(null); setEnrichErr(null); }} />
        <Btn label="Refresh Status" icon={RefreshCw} onClick={() => loadStatus(symbol)} loading={loading} small />
        <Btn label={enriching ? "Enriching…" : "Run Enrichment"} icon={Layers} onClick={runEnrich} loading={enriching} variant="primary" small />
      </div>

      {err && <ErrorBox msg={err} />}
      {enrichErr && <ErrorBox msg={enrichErr} />}

      {enrichResult && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-xs space-y-1">
          <div className="flex items-center gap-2 text-green-400 font-semibold">
            <CheckCircle className="w-3.5 h-3.5" /> Enrichment complete for {symbol}
          </div>
          <div className="text-muted-foreground">
            Inserted: <span className="text-foreground font-mono">{enrichResult.inserted?.toLocaleString() ?? 0}</span> •
            Skipped: <span className="text-foreground font-mono">{enrichResult.skipped?.toLocaleString() ?? 0}</span> •
            Duration: <span className="text-foreground font-mono">{enrichResult.durationMs}ms</span>
          </div>
          {enrichResult.errors?.length > 0 && (
            <div className="text-yellow-400">
              Errors ({enrichResult.errors.length}): {enrichResult.errors.join(", ")}
            </div>
          )}
        </div>
      )}

      <Section title={`Enrichment Status: ${symbol}`} icon={Layers}
        badge={status && (
          <span className="text-xs text-muted-foreground font-mono">
            {status.enrichmentSummary?.ready ?? "?"} ready / {(status.enrichmentSummary?.empty ?? 0) + (status.enrichmentSummary?.noBase ?? 0)} not ready
          </span>
        )}
      >
        {loading ? <Spinner /> : status ? (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Base 1m candles: <span className="text-foreground font-mono">{(status.base1mCount ?? 0).toLocaleString()}</span>
              {status.base1mCount === 0 && <span className="text-red-400 ml-2">⚠ No 1m base data — enrichment will fail</span>}
            </div>
            <Table
              cols={["Timeframe", "Interval (s)", "Candles", "First", "Last", "Status"]}
              rows={(status.timeframes ?? []).map((t: any) => [
                <span className="font-semibold text-foreground">{t.timeframe}</span>,
                t.tfSecs.toLocaleString(),
                <span className={t.count === 0 ? "text-muted-foreground/50" : "text-foreground"}>{t.count.toLocaleString()}</span>,
                t.firstDate ?? "—",
                t.lastDate ?? "—",
                <Badge
                  label={t.status}
                  variant={t.status === "ready" ? "ok" : t.status === "empty" ? "warn" : "error"}
                />,
              ])}
            />
          </div>
        ) : null}
      </Section>
    </div>
  );
}

// ─── TAB: Top-Up / Gap Repair ────────────────────────────────────────────

function TopUpTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [background, setBackground] = useState(false);

  const runTopUp = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const url = background ? "research/data-top-up?background=true" : "research/data-top-up";
      const d = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      setResult(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Data Top-Up / Gap Repair" icon={Database}>
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded p-3">
            <strong className="text-foreground">What this does:</strong> Detects missing candle intervals (gaps) in 1m and 5m base data for a symbol,
            fetches the missing ranges from the Deriv API, then re-runs multi-timeframe enrichment.
            This is safe to run repeatedly — it is idempotent.
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={symbol} onChange={setSymbol} />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={background} onChange={e => setBackground(e.target.checked)} className="w-3 h-3" />
              Background (non-blocking)
            </label>
            <Btn
              label={running ? "Running…" : `Run Top-Up for ${symbol}`}
              icon={Play}
              onClick={runTopUp}
              loading={running}
              variant="primary"
            />
          </div>

          {err && <ErrorBox msg={err} />}

          {running && !background && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Running top-up — this may take 1-2 minutes for symbols with large gaps. Do not navigate away.
            </div>
          )}

          {result && (
            <div className="space-y-3">
              {background ? (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-primary text-xs">
                  <Clock className="w-3.5 h-3.5" />
                  {result.message ?? "Job started in background"}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { k: "Gaps Found", v: result.result?.gapsFound ?? "—", color: "text-yellow-400" },
                      { k: "Gaps Repaired", v: result.result?.gapsRepaired ?? "—", color: "text-green-400" },
                      { k: "Candles Inserted", v: (result.result?.candlesInserted ?? 0).toLocaleString(), color: "text-primary" },
                      { k: "Duration", v: `${result.result?.durationMs ?? "—"}ms`, color: "text-foreground" },
                    ].map(m => (
                      <div key={m.k} className="bg-muted/20 rounded-lg p-3">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{m.k}</div>
                        <div className={cn("text-sm font-mono font-bold", m.color)}>{m.v}</div>
                      </div>
                    ))}
                  </div>
                  {(result.result?.errors ?? []).length > 0 && (
                    <ErrorBox msg={`${result.result.errors.length} error(s): ${result.result.errors.join(" | ")}`} />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

// ─── TAB: AI Research ────────────────────────────────────────────────────

function AiResearchTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [windowDays, setWindowDays] = useState(365);
  const [running, setRunning] = useState(false);
  const [bgStarted, setBgStarted] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = async () => {
    try {
      const d = await apiFetch("research/ai-analyze/status");
      setStatus(d);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const runSync = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const d = await apiFetch("research/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setResult(d.report);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  const runBackground = async () => {
    setErr(null);
    setBgStarted(false);
    try {
      await apiFetch("research/ai-analyze/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setBgStarted(true);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const displayResult = result ?? (status?.lastResult?.[symbol] ?? null);

  return (
    <div className="space-y-4">
      <Section title="AI Research Job" icon={Brain}>
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded p-3">
            Runs a structured AI analysis (GPT-4o) on stored candle data for the selected symbol.
            Extracts swing patterns, move size, frequency, and behavioral drift, then produces a research report.
            <strong className="text-foreground ml-1">Sync mode blocks until complete (~10–30s). Background mode polls independently.</strong>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setResult(null); }} />
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Window:</span>
              {[90, 180, 365].map(d => (
                <button
                  key={d}
                  onClick={() => setWindowDays(d)}
                  className={cn("px-2 py-1 rounded border text-xs",
                    windowDays === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground"
                  )}
                >{d}d</button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Btn label={running ? "Analyzing…" : "Run Sync Analysis"} icon={Play} onClick={runSync} loading={running} variant="primary" />
            <Btn label="Start Background Job" icon={Clock} onClick={runBackground} variant="default" />
            <Btn label="Refresh Status" icon={RefreshCw} onClick={loadStatus} small />
          </div>

          {err && <ErrorBox msg={err} />}
          {bgStarted && (
            <div className="flex items-center gap-2 p-2 rounded bg-primary/10 border border-primary/20 text-primary text-xs">
              <CheckCircle className="w-3.5 h-3.5" /> Background job started for {symbol}. Poll status to track completion.
            </div>
          )}
        </div>
      </Section>

      {status && (
        <Section title="Background Job Status" icon={Clock}
          badge={<Badge label={status.running ? "RUNNING" : "IDLE"} variant={status.running ? "info" : "default"} />}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(status.lastRun ?? {}).map(([sym, ts]) => (
              <KV key={sym} k={`Last run: ${sym}`} v={ts as string} mono />
            ))}
            {Object.entries(status.lastResult ?? {}).map(([sym, r]) => (
              <KV key={sym} k={`Result: ${sym}`} v={r ? "✓ Available" : "null (failed)"} />
            ))}
          </div>
          {Object.keys(status.lastRun ?? {}).length === 0 && (
            <p className="text-xs text-muted-foreground">No jobs run yet this session.</p>
          )}
        </Section>
      )}

      {displayResult && (
        <Section title={`Research Report: ${displayResult.symbol ?? symbol}`} icon={Brain}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { k: "Window", v: `${displayResult.analysisWindowDays ?? "?"} days` },
                { k: "1m Candles", v: (displayResult.totalCandles1m ?? 0).toLocaleString() },
                { k: "Swings ≥2%", v: displayResult.swingStats?.count ?? "?" },
                { k: "Large ≥30%", v: displayResult.swingStats?.largeMoves ?? "?" },
              ].map(m => (
                <div key={m.k} className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{m.k}</div>
                  <div className="text-sm font-mono font-bold text-foreground">{m.v}</div>
                </div>
              ))}
            </div>

            {displayResult.swingStats && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                <KV k="Avg Move" v={`${(displayResult.swingStats.avgMovePct ?? 0).toFixed(1)}%`} mono />
                <KV k="Median Move" v={`${(displayResult.swingStats.medianMovePct ?? 0).toFixed(1)}%`} mono />
                <KV k="Avg Hold" v={`${(displayResult.swingStats.avgHoldingHours ?? 0).toFixed(1)}h`} mono />
                <KV k="Up / Down" v={`${displayResult.swingStats.upMoves} / ${displayResult.swingStats.downMoves}`} mono />
                <KV k="Swings/Month" v={displayResult.swingStats.swingsPerMonth ?? "?"} mono />
                <KV k="Active Symbol" v={<Badge label={displayResult.isActiveTradingSymbol ? "YES" : "NO"} variant={displayResult.isActiveTradingSymbol ? "ok" : "default"} />} />
              </div>
            )}

            <div className="space-y-3 mt-2">
              {[
                ["Summary", displayResult.aiSummary],
                ["System Alignment (50–200%+ Hold)", displayResult.aiSystemAlignment],
                ["Long-Hold Analysis (≥30% moves)", displayResult.aiLongHoldAnalysis],
                ["Medium-Hold Analysis (10–30% moves)", displayResult.aiMediumHoldAnalysis],
                ["Spike Cluster Recovery Analysis", displayResult.aiSpikeClusterAnalysis],
                ["Move Frequency", displayResult.aiMoveFrequency],
                ["Move Size vs TP Targets", displayResult.aiMoveSize],
                ["Hold Duration vs System Philosophy", displayResult.aiHoldDuration],
                ["Useful Timeframes", displayResult.aiUsefulTimeframes],
                ["Repeatable Setups", displayResult.aiRepeatableSetups],
                ["Expected Signal Frequency", displayResult.aiFiringFrequency],
                ["Behavior Drift (Recent vs Older)", displayResult.aiBehaviorDrift],
                ["Promising Areas", displayResult.aiPromisingAreas],
                ["Degrading Areas", displayResult.aiDegradingAreas],
                ["New Opportunities Discovered", displayResult.aiNewOpportunities],
                ["Risk Warnings", displayResult.aiRiskWarnings],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label as string} className="space-y-1">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label as string}</div>
                  <div className="text-xs text-foreground leading-relaxed bg-muted/15 rounded p-2.5">{value as string}</div>
                </div>
              ))}
            </div>

            {Array.isArray(displayResult.longHoldOpportunities) && displayResult.longHoldOpportunities.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-green-400 uppercase tracking-wider">Long-Hold Opportunities (Engine-Aligned)</div>
                {displayResult.longHoldOpportunities.map((o: any, i: number) => (
                  <div key={i} className="rounded border border-green-500/20 bg-green-500/5 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-green-400">{o.name}</span>
                      <Badge label={o.family} variant="ok" />
                      <Badge label={o.direction} variant="info" />
                      <Badge label={o.confidence} variant={o.confidence === "high" ? "ok" : o.confidence === "medium" ? "warn" : "default"} />
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                      <KV k="Avg Move" v={`${(o.avgMovePct ?? 0).toFixed(1)}%`} mono />
                      <KV k="Avg Hold" v={`${(o.avgHoldHours ?? 0).toFixed(0)}h`} mono />
                      <KV k="Trades/Month" v={o.tradesPerMonth ?? "?"} mono />
                      <KV k="Monthly Profit" v={`~${(o.roughMonthlyProfitPct ?? 0).toFixed(0)}%`} mono />
                      <KV k="Engine Fit" v={<Badge label={o.engineFit} variant={o.engineFit === "compatible" ? "ok" : "warn"} />} />
                      <KV k="Win/Loss" v={o.winLossEstimate} />
                    </div>
                    {o.walkForwardRuleSketch && (
                      <div className="text-[10px] text-muted-foreground bg-muted/20 rounded p-1.5 font-mono leading-relaxed">{o.walkForwardRuleSketch}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="text-[10px] text-muted-foreground font-mono">
              Generated: {displayResult.generatedAt ?? "unknown"} | Data: {displayResult.dataFrom?.slice(0, 10)} → {displayResult.dataTo?.slice(0, 10)}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── TAB: Export Check ───────────────────────────────────────────────────

function ExportTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [timeframe, setTimeframe] = useState("1m");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [checking, setChecking] = useState(false);
  const [precheck, setPrecheck] = useState<any | null>(null);
  const [precheckErr, setPrecheckErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const TFS = ["1m","5m","10m","20m","40m","1h","2h","4h","8h","1d","2d","4d"];

  const runPrecheck = async () => {
    setChecking(true);
    setPrecheckErr(null);
    setPrecheck(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity/${symbol}`);

      // The enrichment status endpoint only returns derived TFs (5m+).
      // For 1m, use base1mCount directly from the response.
      let tfEntry: any;
      if (timeframe === "1m") {
        const cnt = d.base1mCount ?? 0;
        tfEntry = cnt > 0
          ? { timeframe: "1m", count: cnt, status: "ready", firstDate: null, lastDate: null }
          : null;
      } else {
        tfEntry = (d.timeframes ?? []).find((t: any) => t.timeframe === timeframe) ?? null;
      }

      setPrecheck({ symbol, timeframe, symbolDetail: d, tfEntry });
    } catch (e: any) {
      setPrecheckErr(e.message);
    } finally {
      setChecking(false);
    }
  };

  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  const triggerDownload = async () => {
    setDownloading(true);
    setDownloadErr(null);
    try {
      const res = await fetch(api("export/research"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, startDate, endDate, includeCsv: false }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const d = await res.json(); msg = d.error ?? msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${symbol}_${timeframe}_${startDate}_to_${endDate}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setDownloadErr((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Export Readiness Check" icon={Download}>
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground bg-muted/20 rounded p-3 leading-relaxed">
            Before exporting data, verify that the selected symbol/timeframe combination has sufficient data and no blocking integrity issues.
            The export endpoint streams a ZIP with JSON data chunks + manifest + validation report.
            Unsupported timeframes will return an error immediately (no silent fallbacks).
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={symbol} onChange={setSymbol} />
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1 text-foreground"
            >
              {TFS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="bg-background border border-border/50 rounded px-2 py-1 text-foreground text-xs"
              />
              <span className="text-muted-foreground">→</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="bg-background border border-border/50 rounded px-2 py-1 text-foreground text-xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Btn label={checking ? "Checking…" : "Check Readiness"} icon={Shield} onClick={runPrecheck} loading={checking} variant="default" />
            <Btn label={downloading ? "Downloading…" : "Download Export"} icon={Download} onClick={triggerDownload} loading={downloading} variant="primary" />
          </div>

          {precheckErr && <ErrorBox msg={precheckErr} />}
          {downloadErr && <ErrorBox msg={downloadErr} />}

          {precheck && (
            <div className="space-y-3">
              {precheck.tfEntry ? (
                <>
                  <div className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border text-xs font-semibold",
                    precheck.tfEntry.count > 0
                      ? "bg-green-500/10 border-green-500/20 text-green-400"
                      : "bg-red-500/10 border-red-500/20 text-red-400"
                  )}>
                    {precheck.tfEntry.count > 0 ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    {precheck.tfEntry.count > 0
                      ? `Export ready: ${precheck.tfEntry.count.toLocaleString()} candles available for ${symbol}/${timeframe}`
                      : `No data — export will fail for ${symbol}/${timeframe}`}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <KV k="Row count" v={precheck.tfEntry.count.toLocaleString()} mono />
                    <KV k="Status" v={<Badge label={precheck.tfEntry.status} variant={precheck.tfEntry.status === "ready" ? "ok" : "warn"} />} />
                    <KV k="First" v={precheck.tfEntry.firstDate ?? "—"} mono />
                    <KV k="Last" v={precheck.tfEntry.lastDate ?? "—"} mono />
                  </div>
                </>
              ) : (
                <ErrorBox msg={`No ${timeframe} data found for ${symbol} — either timeframe is not enriched or no data exists`} />
              )}
              <div className="text-[10px] text-muted-foreground">
                Note: Export validation (duplicate detection, gap reporting) runs live inside the export stream.
                Check the validation.json in the downloaded ZIP for per-export integrity details.
              </div>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

// ─── TAB: Streaming ──────────────────────────────────────────────────────

const STREAMING_STATE_STYLE: Record<string, { label: string; variant: "ok" | "warn" | "error" | "info" | "default" }> = {
  streaming: { label: "STREAMING", variant: "ok" },
  available: { label: "AVAILABLE", variant: "info" },
  idle:      { label: "IDLE",      variant: "default" },
  disabled:  { label: "DISABLED",  variant: "error" },
};

function StreamingTab() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [symData, setSymData] = useState<any | null>(null);
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [symStatus, diag] = await Promise.all([
        apiFetch("diagnostics/symbols"),
        apiFetch("data/status"),
      ]);
      setData({ symStatus, diag });
      setSymData(symStatus);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleStreaming = async (symbol: string, currentState: string) => {
    const enable = currentState === "disabled";
    setToggling(t => ({ ...t, [symbol]: true }));
    try {
      await apiFetch(`diagnostics/symbols/${symbol}/streaming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enable }),
      });
      await load();
    } catch (e: any) {
      setErr(`Toggle failed for ${symbol}: ${(e as Error).message}`);
    } finally {
      setToggling(t => ({ ...t, [symbol]: false }));
    }
  };

  useEffect(() => { load(); }, []);

  const symbols: any[] = symData?.symbols ?? [];
  const streamingCount = symbols.filter((s: any) => s.streamingState === "streaming").length;
  const availableCount = symbols.filter((s: any) => s.streamingState === "available").length;
  const idleCount      = symbols.filter((s: any) => s.streamingState === "idle").length;
  const disabledCount  = symbols.filter((s: any) => s.streamingState === "disabled").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn label="Refresh" icon={RefreshCw} onClick={load} loading={loading} small />
      </div>

      {err && <ErrorBox msg={err} />}

      <Section title="Symbol State — All 28 Known Symbols" icon={Radio}
        badge={symData && (
          <div className="flex gap-1.5">
            <Badge label={`${streamingCount} streaming`} variant="ok" />
            <Badge label={`${availableCount} available`} variant="info" />
            {idleCount > 0 && <Badge label={`${idleCount} idle`} variant="default" />}
            {disabledCount > 0 && <Badge label={`${disabledCount} disabled`} variant="error" />}
          </div>
        )}
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground bg-muted/20 rounded p-3 leading-relaxed space-y-1.5">
            <div>
              <strong className="text-foreground">28 symbols</strong> total: 12 V1 (BOOM/CRASH/R_75/R_100 series) + 16 research-only.
              <strong className="text-foreground"> 4 active trading symbols</strong> (CRASH300, BOOM300, R_75, R_100) are streamed live by default.
            </div>
            <div>
              State model: <span className="text-green-400 font-semibold">streaming</span> = receiving live ticks |{" "}
              <span className="text-primary font-semibold">available</span> = validated by Deriv, not currently subscribed |{" "}
              <span className="text-muted-foreground font-semibold">idle</span> = not validated / no live data |{" "}
              <span className="text-red-400 font-semibold">disabled</span> = explicitly turned off via toggle.
            </div>
            <div className="text-yellow-400/80">
              Note: Toggle changes are in-memory only — they reset on server restart.
              Full subscription management requires a server-side connection change.
            </div>
          </div>

          {loading ? <Spinner /> : symData && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { k: "Total Symbols", v: symbols.length },
                  { k: "Streaming", v: streamingCount, color: "text-green-400" },
                  { k: "Available", v: availableCount, color: "text-primary" },
                  { k: "Idle / Disabled", v: `${idleCount} / ${disabledCount}`, color: "text-muted-foreground" },
                ].map(m => (
                  <div key={m.k} className="bg-muted/20 rounded-lg p-3">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{m.k}</div>
                    <div className={cn("text-sm font-mono font-bold", (m as any).color ?? "text-foreground")}>{m.v}</div>
                  </div>
                ))}
              </div>

              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-2 mb-1 px-1">Active Trading Symbols (live)</div>
              <Table
                cols={["Symbol", "State", "Family", "Valid", "Ticks/5m", "Toggle"]}
                rows={symbols.filter((s: any) => s.isActiveTradingSymbol).map((s: any) => {
                  const ss = STREAMING_STATE_STYLE[s.streamingState] ?? STREAMING_STATE_STYLE.idle;
                  return [
                    <span className="font-semibold text-primary">{s.configured}</span>,
                    <Badge label={ss.label} variant={ss.variant} />,
                    <span className="text-muted-foreground">{s.instrumentFamily}</span>,
                    <Pill ok={s.activeSymbolFound} yes="YES" no="NO" />,
                    <span className="font-mono">{s.tickCount5min}</span>,
                    <button
                      disabled={toggling[s.configured]}
                      onClick={() => toggleStreaming(s.configured, s.streamingState)}
                      className={cn(
                        "text-[10px] px-2 py-0.5 rounded border font-medium transition-all",
                        s.streamingState === "disabled"
                          ? "bg-green-500/15 border-green-500/30 text-green-400 hover:bg-green-500/25"
                          : "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25",
                        toggling[s.configured] && "opacity-50 cursor-not-allowed",
                      )}
                    >
                      {toggling[s.configured] ? "…" : s.streamingState === "disabled" ? "Enable" : "Disable"}
                    </button>,
                  ];
                })}
              />

              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-3 mb-1 px-1">All Other Symbols (research / data)</div>
              <Table
                cols={["Symbol", "State", "Family", "Valid", "Research Only"]}
                rows={symbols.filter((s: any) => !s.isActiveTradingSymbol).map((s: any) => {
                  const ss = STREAMING_STATE_STYLE[s.streamingState] ?? STREAMING_STATE_STYLE.idle;
                  return [
                    <span className="font-semibold text-foreground">{s.configured}</span>,
                    <Badge label={ss.label} variant={ss.variant} />,
                    <span className="text-muted-foreground">{s.instrumentFamily}</span>,
                    <Pill ok={s.activeSymbolFound} yes="YES" no="NO" />,
                    <Badge label={s.isResearchOnly ? "RESEARCH" : "V1 DATA"} variant={s.isResearchOnly ? "default" : "info"} />,
                  ];
                })}
              />
            </>
          )}
        </div>
      </Section>

      {data?.diag && (
        <Section title="Data Stream Status" icon={Wifi}>
          <div className="space-y-2">
            <KV k="Stream Active" v={<Pill ok={data.diag.streaming} yes="YES" no="NO" />} />
            <KV k="Mode" v={data.diag.mode ?? "—"} mono />
            <KV k="Subscribed Symbols" v={(data.diag.subscribedSymbols ?? []).join(", ") || "—"} />
            <KV k="Tick Count" v={(data.diag.tickCount ?? 0).toLocaleString()} mono />
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── TAB: V3 Runtime ────────────────────────────────────────────────────

function RuntimeTab() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [features, setFeatures] = useState<Record<string, any>>({});
  const [featLoading, setFeatLoading] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [overview, risk] = await Promise.all([
        apiFetch("overview"),
        apiFetch("risk/status"),
      ]);
      setData({ overview, risk });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  const loadFeatures = async (sym: string) => {
    setFeatLoading(f => ({ ...f, [sym]: true }));
    try {
      const d = await apiFetch(`signals/features/${sym}`);
      setFeatures(f => ({ ...f, [sym]: d }));
    } catch (e: any) {
      setFeatures(f => ({ ...f, [sym]: { error: (e as Error).message } }));
    } finally {
      setFeatLoading(f => ({ ...f, [sym]: false }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn label="Refresh" icon={RefreshCw} onClick={load} loading={loading} small />
      </div>

      {err && <ErrorBox msg={err} />}

      {data?.overview && (
        <Section title="V3 Scanner Status" icon={Cpu}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <KV k="Scanner Running" v={<Pill ok={data.overview.scannerRunning ?? false} yes="YES" no="NO" />} />
            <KV k="Last Scan Time" v={data.overview.lastScanTime ? new Date(data.overview.lastScanTime).toLocaleTimeString() : "—"} mono />
            <KV k="Last Symbol Scanned" v={data.overview.lastScanSymbol ?? "—"} mono />
            <KV k="Total Scans Run" v={(data.overview.totalScansRun ?? 0).toLocaleString()} mono />
            <KV k="Total Decisions" v={(data.overview.totalDecisionsLogged ?? 0).toLocaleString()} mono />
            <KV k="Scan Interval" v={`${((data.overview.scanIntervalMs ?? 60000) / 1000).toFixed(0)}s`} mono />
          </div>
        </Section>
      )}

      {data?.risk && (
        <Section title="Risk / Position Manager Status" icon={Shield}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <KV k="Open Positions" v={data.risk.openPositions ?? "—"} mono />
            <KV k="Paper Open" v={data.risk.paperOpen ?? "—"} mono />
            <KV k="Demo Open" v={data.risk.demoOpen ?? "—"} mono />
            <KV k="Real Open" v={data.risk.realOpen ?? "—"} mono />
            <KV k="Max Concurrent" v={data.risk.maxConcurrent ?? "—"} mono />
            <KV k="Paper Active" v={<Pill ok={!!data.overview?.paperModeActive} yes="YES" no="NO" />} />
          </div>
        </Section>
      )}

      <Section title="V3 Engine Features — Live State" icon={Cpu}
        badge={<span className="text-[10px] text-muted-foreground">Active trading symbols only</span>}
      >
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            These are the computed feature vectors that the V3 coordinator sees on each scan.
            They reflect the actual state of the 8 V3 engines for the 4 active trading symbols.
            Click a symbol to load its latest features.
          </div>
          <div className="flex flex-wrap gap-2">
            {ACTIVE_SYMBOLS.map(sym => (
              <Btn
                key={sym}
                label={featLoading[sym] ? `${sym}…` : sym}
                onClick={() => loadFeatures(sym)}
                loading={featLoading[sym]}
                small
                variant={features[sym] ? "primary" : "default"}
              />
            ))}
          </div>
          {Object.entries(features).map(([sym, f]) => (
            <div key={sym} className="rounded border border-border/40 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-primary mb-2">{sym}</div>
              {f.error ? (
                <ErrorBox msg={f.error} />
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                  {Object.entries(f).filter(([k]) => !["symbol","error"].includes(k)).slice(0, 24).map(([k, v]) => (
                    <KV key={k} k={k} v={String(v ?? "—")} mono />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ─── Main V3 Backend Page ────────────────────────────────────────────────

type Tab = "integrity" | "enrichment" | "topup" | "ai" | "export" | "streaming" | "runtime";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "integrity",  label: "Integrity",  icon: Shield },
  { id: "enrichment", label: "Enrichment", icon: Layers },
  { id: "topup",      label: "Top-Up",     icon: Database },
  { id: "ai",         label: "AI Research",icon: Brain },
  { id: "export",     label: "Export",     icon: Download },
  { id: "streaming",  label: "Streaming",  icon: Radio },
  { id: "runtime",    label: "Runtime",    icon: Cpu },
];

export default function V3Backend() {
  const [tab, setTab] = useState<Tab>("integrity");

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold border bg-yellow-500/10 border-yellow-500/25 text-yellow-400 uppercase tracking-wider">
              <AlertTriangle className="w-3 h-3" /> Temporary
            </span>
            <span className="text-[10px] text-muted-foreground">Not the final V3 UI — backend verification only</span>
          </div>
          <h1 className="text-xl font-bold text-foreground">V3 Backend Verification</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Exposes Task #92 backend capabilities for end-to-end validation before the full UI rebuild.
            All data is live from real backend endpoints — no placeholders, no fake data.
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border/50 overflow-x-auto pb-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/60"
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === "integrity"  && <IntegrityTab />}
        {tab === "enrichment" && <EnrichmentTab />}
        {tab === "topup"      && <TopUpTab />}
        {tab === "ai"         && <AiResearchTab />}
        {tab === "export"     && <ExportTab />}
        {tab === "streaming"  && <StreamingTab />}
        {tab === "runtime"    && <RuntimeTab />}
      </div>
    </div>
  );
}
