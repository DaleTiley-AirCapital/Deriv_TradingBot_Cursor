import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Shield, RefreshCw, Play, CheckCircle, XCircle, AlertTriangle,
  Clock, Database, Layers, Wifi, Brain, Download, Radio, Cpu,
  ChevronDown, ChevronRight, Loader2, Wrench, Settings2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const d = await res.json(); msg = d.error ?? d.message ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const ALL_SYMBOLS = [
  "BOOM1000","CRASH1000","BOOM900","CRASH900","BOOM600","CRASH600",
  "BOOM500","CRASH500","BOOM300","CRASH300","R_75","R_100",
  "R_10","R_25","R_50","RDBULL","RDBEAR",
  "JD10","JD25","JD50","JD75","JD100",
  "stpRNG","stpRNG2","stpRNG3","stpRNG5","RB100","RB200",
];
const ACTIVE_SYMBOLS = ["CRASH300","BOOM300","R_75","R_100"];

// ─── Primitives ───────────────────────────────────────────────────────────

function Pill({ variant, label }: { variant: "ok"|"warn"|"error"|"info"|"default"; label: string }) {
  const cls = {
    ok:      "bg-green-500/15 text-green-400 border-green-500/25",
    warn:    "bg-amber-500/15 text-amber-400 border-amber-500/25",
    error:   "bg-red-500/15 text-red-400 border-red-500/25",
    info:    "bg-primary/15 text-primary border-primary/25",
    default: "bg-muted/40 text-muted-foreground border-border/50",
  }[variant];
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cls)}>{label}</span>;
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function Spinner() { return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto my-6" />; }

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{k}</span>
      <span className={cn("text-xs text-foreground text-right break-all", mono && "font-mono")}>{v}</span>
    </div>
  );
}

function Panel({ title, icon: Icon, badge, children }: {
  title: string; icon: React.ElementType; badge?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between gap-3 bg-muted/10">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {badge}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Btn({ label, icon: Icon, onClick, loading, variant = "default", small }: {
  label: string; icon?: React.ElementType; onClick: () => void;
  loading?: boolean; variant?: "default"|"primary"|"danger"; small?: boolean;
}) {
  const cls = {
    default: "bg-muted/40 border-border/50 text-foreground hover:bg-muted/70",
    primary: "bg-primary/15 border-primary/30 text-primary hover:bg-primary/25",
    danger:  "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25",
  }[variant];
  return (
    <button disabled={loading} onClick={onClick}
      className={cn("inline-flex items-center gap-1.5 rounded border font-medium transition-all",
        small ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs", cls,
        loading && "opacity-60 cursor-not-allowed")}>
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : Icon && <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}

function SymbolSelect({ value, onChange, includeAll }: {
  value: string; onChange: (s: string) => void; includeAll?: boolean;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="text-xs bg-background border border-border/50 rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary/50">
      {includeAll && <option value="">— All symbols —</option>}
      {ALL_SYMBOLS.map(s => (
        <option key={s} value={s}>{s}{ACTIVE_SYMBOLS.includes(s) ? " ●" : ""}</option>
      ))}
    </select>
  );
}

// ─── TAB: Integrity ───────────────────────────────────────────────────────

const TFS = ["1m","5m","10m","20m","40m","1h","2h","4h","8h","1d","2d","4d"];

function IntegrityTab() {
  const [days, setDays] = useState(30);
  const [showFull, setShowFull] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string|null>(null);
  const [grid, setGrid] = useState<any[]|null>(null);
  const [selected, setSelected] = useState<string|null>(null);
  const [detail, setDetail] = useState<any|null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadGrid = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const d = await apiFetch(`diagnostics/data-integrity?days=${days}&full=${showFull}`);
      setGrid(d.results ?? []);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [days, showFull]);

  const loadDetail = useCallback(async (sym: string) => {
    setDetailLoading(true); setDetail(null);
    try { setDetail(await apiFetch(`diagnostics/data-integrity/${sym}`)); }
    catch {}
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { loadGrid(); }, []);

  const lookup = new Map<string, any>();
  (grid ?? []).forEach(r => lookup.set(`${r.symbol}|${r.timeframe}`, r));
  const symbols = [...new Set((grid ?? []).map((r: any) => r.symbol))];
  const healthy = (grid ?? []).filter((r: any) => r.isHealthy).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Lookback:</span>
          {[7,30,90,365].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={cn("px-2 py-1 rounded border text-xs transition-colors",
                days === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
              {d}d
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={showFull} onChange={e => setShowFull(e.target.checked)} className="w-3 h-3" />
          Include gaps
        </label>
        <Btn label="Refresh" icon={RefreshCw} onClick={loadGrid} loading={loading} small />
      </div>

      {err && <ErrorBox msg={err} />}

      <Panel title="All-Symbol Integrity Grid" icon={Shield}
        badge={grid && <Pill variant={grid.every((r: any) => r.isHealthy) ? "ok" : "warn"} label={`${healthy}/${grid.length} healthy`} />}>
        {loading && !grid ? <Spinner /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/40">
                    <th className="text-left py-2 text-muted-foreground text-[10px] uppercase tracking-wider pr-3 sticky left-0 bg-card">Symbol</th>
                    {TFS.map(tf => (
                      <th key={tf} className="text-center py-2 px-1 text-muted-foreground text-[10px] uppercase tracking-wider">{tf}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {symbols.map(sym => (
                    <tr key={sym}
                      className={cn("border-b border-border/20 cursor-pointer hover:bg-muted/10 last:border-0", selected === sym && "bg-primary/5")}
                      onClick={() => { const next = selected === sym ? null : sym; setSelected(next); if (next) loadDetail(next); }}
                    >
                      <td className="py-2 pr-3 font-mono font-medium sticky left-0 bg-card">
                        <div className="flex items-center gap-1">
                          {selected === sym ? <ChevronDown className="w-3 h-3 text-primary" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                          <span className={ACTIVE_SYMBOLS.includes(sym) ? "text-primary" : "text-foreground"}>{sym}</span>
                          {ACTIVE_SYMBOLS.includes(sym) && <span className="text-[9px] text-primary/60">●</span>}
                        </div>
                      </td>
                      {TFS.map(tf => {
                        const r = lookup.get(`${sym}|${tf}`);
                        if (!r) return <td key={tf} className="text-center px-1 text-muted-foreground/30">—</td>;
                        const cnt = r.totalCandles ?? 0;
                        return (
                          <td key={tf} className="text-center px-1 py-2">
                            <span
                              title={`${cnt.toLocaleString()} candles${r.gapCount > 0 ? `, gaps=${r.gapCount}` : ""}`}
                              className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] font-mono",
                                cnt === 0 ? "text-muted-foreground/30" : r.isHealthy ? "text-green-400" : "text-amber-400")}
                            >
                              {cnt === 0 ? "—" : cnt >= 1000 ? `${(cnt/1000).toFixed(0)}k` : cnt}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {symbols.length === 0 && !loading && (
                    <tr><td colSpan={TFS.length + 1} className="text-center py-6 text-xs text-muted-foreground">No data — click Refresh</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              Click row to expand. <span className="text-green-400">Green</span> = healthy · <span className="text-amber-400">Amber</span> = gaps/issues · — = no data · Active symbols shown in blue.
            </p>
          </>
        )}
      </Panel>

      {selected && (
        <Panel title={`Detail: ${selected}`} icon={Database}>
          {detailLoading ? <Spinner /> : detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "1m Candles",  value: (detail.base1mCount ?? 0).toLocaleString(), color: "text-foreground" },
                  { label: "TFs Ready",   value: String(detail.enrichmentSummary?.ready ?? 0), color: "text-green-400" },
                  { label: "TFs Empty",   value: String(detail.enrichmentSummary?.empty ?? 0), color: "text-amber-400" },
                  { label: "No Base",     value: String(detail.enrichmentSummary?.noBase ?? 0), color: "text-red-400" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-muted/20 rounded-lg p-3">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                    <div className={cn("text-sm font-mono font-bold", color)}>{value}</div>
                  </div>
                ))}
              </div>
              {detail.timeframes && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/40">
                        {["TF","Count","First Date","Last Date","Status"].map(c => (
                          <th key={c} className="text-left py-2 px-2 text-muted-foreground text-[10px] uppercase tracking-wider font-medium first:pl-0">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.timeframes.map((t: any, i: number) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-muted/10 last:border-0">
                          <td className="py-2 font-mono font-semibold pl-0">{t.timeframe}</td>
                          <td className="py-2 px-2 font-mono">{t.count?.toLocaleString() ?? "—"}</td>
                          <td className="py-2 px-2 font-mono text-muted-foreground">{t.firstDate ?? "—"}</td>
                          <td className="py-2 px-2 font-mono text-muted-foreground">{t.lastDate ?? "—"}</td>
                          <td className="py-2 px-2">
                            <Pill variant={t.status === "ready" ? "ok" : t.status === "empty" ? "warn" : "error"} label={t.status ?? "unknown"} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

// ─── TAB: Enrichment ──────────────────────────────────────────────────────

function EnrichmentTab() {
  const [repairSym, setRepairSym] = useState("CRASH300");
  const [repairRunning, setRepairRunning] = useState(false);
  const [repairResult, setRepairResult] = useState<any|null>(null);
  const [repairErr, setRepairErr] = useState<string|null>(null);

  const [reconcileSym, setReconcileSym] = useState("CRASH300");
  const [reconcileRunning, setReconcileRunning] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<any|null>(null);
  const [reconcileErr, setReconcileErr] = useState<string|null>(null);

  const [enrichSym, setEnrichSym] = useState("CRASH300");
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichResult, setEnrichResult] = useState<any|null>(null);
  const [enrichErr, setEnrichErr] = useState<string|null>(null);

  const runRepair = async () => {
    setRepairRunning(true); setRepairErr(null); setRepairResult(null);
    try {
      const d = await apiFetch("research/repair-interpolated", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: repairSym }),
      });
      setRepairResult(d);
    } catch (e: any) { setRepairErr(e.message); }
    finally { setRepairRunning(false); }
  };

  const runReconcile = async () => {
    setReconcileRunning(true); setReconcileErr(null); setReconcileResult(null);
    try {
      const d = await apiFetch("research/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: reconcileSym }),
      });
      setReconcileResult(d);
    } catch (e: any) { setReconcileErr(e.message); }
    finally { setReconcileRunning(false); }
  };

  const runEnrich = async () => {
    setEnrichRunning(true); setEnrichErr(null); setEnrichResult(null);
    try {
      const d = await apiFetch("research/enrich", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: enrichSym }),
      });
      setEnrichResult(d);
    } catch (e: any) { setEnrichErr(e.message); }
    finally { setEnrichRunning(false); }
  };

  return (
    <div className="space-y-4">
      <Panel title="Repair Interpolated Candles" icon={Wrench}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded p-3">
            Scans all <code className="text-primary">isInterpolated=true</code> candles in 1m and 5m tables and attempts to
            replace them with real API candles. Unrecoverable candles (e.g. market closures, API history limits) remain.
            May take 2–5 minutes for symbols with many interpolated rows.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={repairSym} onChange={setRepairSym} />
            <Btn label={repairRunning ? "Repairing…" : "Repair Interpolated"} icon={Play} onClick={runRepair} loading={repairRunning} variant="primary" />
          </div>
          {repairErr && <ErrorBox msg={repairErr} />}
          {repairResult && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { k: "Found (before)", v: (repairResult.summary?.totalBefore ?? 0).toLocaleString(), c: "text-amber-400" },
                { k: "Recovered",      v: (repairResult.summary?.totalRecovered ?? 0).toLocaleString(), c: "text-green-400" },
                { k: "Unrecoverable",  v: (repairResult.summary?.totalUnrecoverable ?? 0).toLocaleString(), c: repairResult.summary?.totalUnrecoverable > 0 ? "text-red-400" : "text-muted-foreground" },
              ].map(m => (
                <div key={m.k} className="bg-muted/20 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{m.k}</div>
                  <div className={cn("text-sm font-mono font-bold", m.c)}>{m.v}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Reconcile" icon={RefreshCw}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            Reconciles stored candles against the Deriv API to identify gaps and fill where possible.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={reconcileSym} onChange={setReconcileSym} />
            <Btn label={reconcileRunning ? "Reconciling…" : "Run Reconcile"} icon={Play} onClick={runReconcile} loading={reconcileRunning} variant="primary" />
          </div>
          {reconcileErr && <ErrorBox msg={reconcileErr} />}
          {reconcileResult && (
            <div className="mt-2 rounded bg-muted/20 p-3 space-y-1">
              {Object.entries(reconcileResult.summary ?? reconcileResult).map(([k, v]) => (
                <KV key={k} k={k} v={String(v)} mono />
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Enrich (Multi-TF Aggregation)" icon={Layers}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            Re-runs the multi-timeframe aggregation pipeline — derives 5m, 10m, 20m, 40m, 1h, 2h, 4h, 8h, 1d, 2d, 4d from base 1m data.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={enrichSym} onChange={setEnrichSym} />
            <Btn label={enrichRunning ? "Enriching…" : "Run Enrichment"} icon={Play} onClick={runEnrich} loading={enrichRunning} variant="primary" />
          </div>
          {enrichErr && <ErrorBox msg={enrichErr} />}
          {enrichResult && (
            <div className="mt-2 rounded bg-muted/20 p-3 space-y-1">
              {Object.entries(enrichResult.summary ?? enrichResult).map(([k, v]) => (
                <KV key={k} k={k} v={String(v)} mono />
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ─── TAB: Top-Up ─────────────────────────────────────────────────────────

function TopUpTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any|null>(null);
  const [err, setErr] = useState<string|null>(null);

  const run = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const d = await apiFetch("research/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, days, type: "topup" }),
      });
      setResult(d);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  return (
    <div className="space-y-4">
      <Panel title="Data Top-Up" icon={Database}>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded p-3">
            Fetches recent candle data from Deriv API and stores it for the selected symbol.
            Used to bring symbols up-to-date after a gap in streaming or to bootstrap new symbols.
            Lookback controls how many days of history to request.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <SymbolSelect value={symbol} onChange={setSymbol} />
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Lookback:</span>
              {[7, 30, 90, 180].map(d => (
                <button key={d} onClick={() => setDays(d)}
                  className={cn("px-2 py-1 rounded border text-xs transition-colors",
                    days === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Btn label={running ? "Running top-up…" : `Top-Up ${symbol} (${days}d)`} icon={Play} onClick={run} loading={running} variant="primary" />
          </div>
          {err && <ErrorBox msg={err} />}
          {result && (
            <div className="mt-2 rounded bg-muted/20 p-3 space-y-1">
              <div className="text-xs font-semibold text-green-400 mb-2 flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5" /> Top-up complete
              </div>
              {Object.entries(result.summary ?? result).map(([k, v]) => (
                <KV key={k} k={k} v={String(v)} mono />
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ─── TAB: AI Research ────────────────────────────────────────────────────

function AiResearchTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [windowDays, setWindowDays] = useState(365);
  const [running, setRunning] = useState(false);
  const [bgStarted, setBgStarted] = useState(false);
  const [result, setResult] = useState<any|null>(null);
  const [err, setErr] = useState<string|null>(null);
  const [status, setStatus] = useState<any|null>(null);
  const interval = useRef<ReturnType<typeof setInterval>|null>(null);

  const loadStatus = async () => {
    try { setStatus(await apiFetch("research/ai-analyze/status")); } catch {}
  };

  useEffect(() => {
    loadStatus();
    interval.current = setInterval(loadStatus, 4000);
    return () => { if (interval.current) clearInterval(interval.current); };
  }, []);

  const runSync = async () => {
    setRunning(true); setErr(null); setResult(null);
    try { const d = await apiFetch("research/ai-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, windowDays }) }); setResult(d.report ?? d); }
    catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  const runBg = async () => {
    setErr(null); setBgStarted(false);
    try { await apiFetch("research/ai-analyze/background", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, windowDays }) }); setBgStarted(true); }
    catch (e: any) { setErr(e.message); }
  };

  const displayResult = result ?? (status?.lastResult?.[symbol] ?? null);

  return (
    <div className="space-y-4">
      <Panel title="AI Research Analysis" icon={Brain}
        badge={status && <Pill variant={status.running ? "info" : "default"} label={status.running ? "RUNNING" : "IDLE"} />}>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 rounded p-3">
            GPT-4o structured analysis on stored candle data. Extracts swing patterns, move size,
            frequency, and behavioral drift. <strong className="text-foreground">Sync mode blocks ~10–30s.</strong> Background polls independently.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setResult(null); }} />
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Window:</span>
              {[90, 180, 365].map(d => (
                <button key={d} onClick={() => setWindowDays(d)}
                  className={cn("px-2 py-1 rounded border", windowDays === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground")}>{d}d</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Btn label={running ? "Analyzing…" : "Run Sync"} icon={Play} onClick={runSync} loading={running} variant="primary" />
            <Btn label="Start Background" icon={Clock} onClick={runBg} />
            <Btn label="Refresh Status" icon={RefreshCw} onClick={loadStatus} small />
          </div>
          {err && <ErrorBox msg={err} />}
          {bgStarted && (
            <div className="flex items-center gap-2 p-2 rounded bg-primary/10 border border-primary/20 text-primary text-xs">
              <CheckCircle className="w-3.5 h-3.5" /> Background job started for {symbol} ({windowDays}d).
            </div>
          )}
        </div>
      </Panel>

      {status && Object.keys(status.lastRun ?? {}).length > 0 && (
        <Panel title="Background Job Status" icon={Clock}>
          <div className="space-y-1">
            {Object.entries(status.lastRun ?? {}).map(([sym, ts]) => (
              <KV key={sym} k={`Last run: ${sym}`} v={String(ts)} mono />
            ))}
          </div>
        </Panel>
      )}

      {displayResult && (
        <Panel title={`Research Report — ${symbol}`} icon={Brain}>
          {typeof displayResult === "string" ? (
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap bg-muted/20 rounded p-3 leading-relaxed max-h-96 overflow-y-auto">{displayResult}</pre>
          ) : (
            <div className="space-y-0">
              {Object.entries(displayResult).map(([k, v]) => <KV key={k} k={k} v={JSON.stringify(v)} mono />)}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

// ─── TAB: Export ─────────────────────────────────────────────────────────

function ExportTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [from, setFrom] = useState(() => { const d = new Date(); d.setMonth(d.getMonth()-3); return d.toISOString().split("T")[0]; });
  const [to, setTo] = useState(() => new Date().toISOString().split("T")[0]);
  const [fmt, setFmt] = useState<"csv"|"json">("csv");
  const [precheck, setPrecheck] = useState<any|null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckErr, setPrecheckErr] = useState<string|null>(null);

  const runPrecheck = async () => {
    setPrechecking(true); setPrecheck(null); setPrecheckErr(null);
    try { setPrecheck(await apiFetch(`export/precheck?symbol=${symbol}&from=${from}&to=${to}`)); }
    catch (e: any) { setPrecheckErr(e.message); }
    finally { setPrechecking(false); }
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = `${BASE}api/export/range?symbol=${symbol}&from=${from}&to=${to}&format=${fmt}`;
    link.download = `${symbol}_${from}_${to}.${fmt}`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  return (
    <div className="space-y-4">
      <Panel title="Export Candle Data" icon={Download}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground w-16">Symbol:</span><SymbolSelect value={symbol} onChange={setSymbol} /></div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16">Format:</span>
                <div className="flex gap-1.5">
                  {(["csv","json"] as const).map(f => (
                    <button key={f} onClick={() => setFmt(f)}
                      className={cn("px-2.5 py-1 rounded border text-xs", fmt === f ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground")}>{f.toUpperCase()}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground w-10">From:</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none" /></div>
              <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground w-10">To:</span><input type="date" value={to} onChange={e => setTo(e.target.value)} className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none" /></div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Btn label="Precheck" icon={ChevronRight} onClick={runPrecheck} loading={prechecking} />
            <Btn label={`Download ${fmt.toUpperCase()}`} icon={Download} onClick={download} variant="primary" />
          </div>
          {precheckErr && <ErrorBox msg={precheckErr} />}
        </div>
      </Panel>

      {precheck && (
        <Panel title={`Precheck — ${symbol}`} icon={CheckCircle}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { k: "1m Candles",    v: (precheck.count1m ?? precheck.totalRows ?? 0).toLocaleString() },
              { k: "5m Candles",    v: precheck.count5m?.toLocaleString() ?? "—" },
              { k: "Date Range",    v: precheck.from && precheck.to ? `${precheck.from} → ${precheck.to}` : "—" },
              { k: "Interpolated",  v: precheck.interpolatedCount?.toLocaleString() ?? "—" },
            ].map(({ k, v }) => (
              <div key={k} className="bg-muted/20 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{k}</div>
                <div className="text-sm font-mono font-bold text-foreground">{v}</div>
              </div>
            ))}
          </div>
          {(precheck.warnings ?? []).map((w: string, i: number) => (
            <div key={i} className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

// ─── TAB: Streaming ───────────────────────────────────────────────────────

function StreamingTab() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any|null>(null);
  const [err, setErr] = useState<string|null>(null);
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true); setErr(null);
    try { setData(await apiFetch("diagnostics/symbols")); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (sym: string, currentlyStreaming: boolean) => {
    setToggling(t => ({ ...t, [sym]: true }));
    try {
      await apiFetch(`diagnostics/symbols/${encodeURIComponent(sym)}/streaming`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentlyStreaming }),
      });
      await load();
    } catch {}
    finally { setToggling(t => ({ ...t, [sym]: false })); }
  };

  const startAll = async () => {
    try { await apiFetch("data/stream/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); await load(); } catch {}
  };

  const stopAll = async () => {
    try { await apiFetch("data/stream/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); await load(); } catch {}
  };

  const symbols: any[] = data?.symbols ?? data ?? [];
  const streaming = symbols.filter((s: any) => s.streamingState === "streaming" || s.streaming).length;

  return (
    <div className="space-y-4">
      <Panel title="Per-Symbol Streaming State" icon={Radio}
        badge={<Pill variant={streaming > 0 ? "ok" : "default"} label={`${streaming} streaming`} />}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Btn label="Refresh" icon={RefreshCw} onClick={load} loading={loading} small />
            <Btn label="Start All" icon={Wifi} onClick={startAll} variant="primary" small />
            <Btn label="Stop All" icon={XCircle} onClick={stopAll} variant="danger" small />
          </div>
          {err && <ErrorBox msg={err} />}
          {loading && !data ? <Spinner /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40">
                    {["Symbol","State","M1 Candles","M5 Candles","Last Updated","Control"].map(c => (
                      <th key={c} className="text-left py-2 px-2 text-muted-foreground text-[10px] uppercase tracking-wider font-medium first:pl-0">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {symbols.map((s: any) => {
                    const isActive = ACTIVE_SYMBOLS.includes(s.symbol);
                    const isStreaming = s.streamingState === "streaming" || s.streaming === true;
                    return (
                      <tr key={s.symbol} className={cn("border-b border-border/20 hover:bg-muted/10 last:border-0", isActive && "bg-primary/3")}>
                        <td className="py-2 pl-0 font-mono font-medium">
                          <span className={isActive ? "text-primary" : "text-foreground"}>{s.symbol}</span>
                          {isActive && <span className="ml-1 text-[9px] text-primary/60">●</span>}
                        </td>
                        <td className="py-2 px-2">
                          <Pill variant={isStreaming ? "ok" : "default"} label={s.streamingState ?? (isStreaming ? "Streaming" : "Idle")} />
                        </td>
                        <td className="py-2 px-2 font-mono text-muted-foreground">{s.count1m?.toLocaleString() ?? "—"}</td>
                        <td className="py-2 px-2 font-mono text-muted-foreground">{s.count5m?.toLocaleString() ?? "—"}</td>
                        <td className="py-2 px-2 font-mono text-muted-foreground text-[11px]">{s.lastTickTs ? new Date(s.lastTickTs).toLocaleString() : "—"}</td>
                        <td className="py-2 px-2">
                          <button
                            onClick={() => toggle(s.symbol, isStreaming)}
                            disabled={toggling[s.symbol]}
                            className={cn("text-[11px] px-2 py-0.5 rounded border font-medium transition-all",
                              isStreaming ? "border-red-500/30 text-red-400 hover:bg-red-500/10" : "border-primary/30 text-primary hover:bg-primary/10",
                              toggling[s.symbol] && "opacity-50 cursor-not-allowed")}
                          >
                            {toggling[s.symbol] ? "…" : isStreaming ? "Stop" : "Stream"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {symbols.length === 0 && !loading && (
                    <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">No data — click Refresh</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ─── TAB: Runtime ─────────────────────────────────────────────────────────

function RuntimeTab() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any|null>(null);
  const [err, setErr] = useState<string|null>(null);
  const [features, setFeatures] = useState<Record<string, any>>({});
  const [featLoading, setFeatLoading] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true); setErr(null);
    try { setData(await apiFetch("overview")); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const loadFeatures = async (sym: string) => {
    setFeatLoading(f => ({ ...f, [sym]: true }));
    try {
      const result = await apiFetch(`signals/features/${sym}`);
      setFeatures(prev => ({ ...prev, [sym]: result }));
    } catch (e: any) {
      setFeatures(prev => ({ ...prev, [sym]: { error: (e as Error).message } }));
    } finally {
      setFeatLoading(f => ({ ...f, [sym]: false }));
    }
  };

  const toggleKS = async (current: boolean) => {
    try {
      await fetch(`${BASE}api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "kill_switch", value: current ? "false" : "true" }) });
      await load();
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn label="Refresh" icon={RefreshCw} onClick={load} loading={loading} small />
      </div>
      {err && <ErrorBox msg={err} />}

      {data && (
        <>
          <Panel title="System Overview" icon={Settings2}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
              <KV k="Active Mode" v={<Pill variant={data.mode === "idle" ? "default" : "ok"} label={data.mode?.toUpperCase() ?? "IDLE"} />} />
              <KV k="Tick Streaming" v={<Pill variant={data.streamingOnline ? "ok" : "warn"} label={data.streamingOnline ? "Online" : "Offline"} />} />
              <KV k="Scanner Running" v={<Pill variant={data.scannerRunning ? "ok" : "warn"} label={data.scannerRunning ? "Running" : "Stopped"} />} />
              <KV k="Kill Switch" v={
                <button onClick={() => toggleKS(data.killSwitchActive)}
                  className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold transition-all",
                    data.killSwitchActive ? "bg-red-500/15 text-red-400 border-red-500/25 hover:bg-red-500/25" : "bg-muted/40 text-muted-foreground border-border/50 hover:bg-muted/60")}>
                  {data.killSwitchActive ? "ACTIVE — click to disable" : "OFF — click to enable"}
                </button>
              } />
              <KV k="Last Scan Symbol" v={data.lastScanSymbol ?? "—"} mono />
              <KV k="Total Scans Run" v={(data.totalScansRun ?? 0).toLocaleString()} mono />
              <KV k="Total Decisions Logged" v={(data.totalDecisionsLogged ?? 0).toLocaleString()} mono />
              <KV k="Streaming Symbols" v={String(data.subscribedSymbolCount ?? "—")} mono />
            </div>
          </Panel>

          {data.perMode && (
            <Panel title="Per-Mode Status" icon={Shield}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(["paper","demo","real"] as const).map(m => {
                  const pm = data.perMode[m] ?? {};
                  const isActive = data.paperModeActive && m === "paper" || data.demoModeActive && m === "demo" || data.realModeActive && m === "real";
                  return (
                    <div key={m} className="space-y-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold uppercase">{m}</span>
                        <Pill variant={isActive ? "ok" : "default"} label={isActive ? "ACTIVE" : "OFF"} />
                      </div>
                      <KV k="Capital" v={pm.capital ? `$${pm.capital}` : "—"} mono />
                      <KV k="Min Score" v={String(pm.minScore ?? "—")} mono />
                      <KV k="Open Trades" v={String(pm.openTrades ?? "—")} mono />
                      <KV k="P&L" v={pm.pnl != null ? `$${Number(pm.pnl).toFixed(2)}` : "—"} mono />
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </>
      )}

      <Panel title="V3 Engine Features — Live State" icon={Cpu}
        badge={<span className="text-[10px] text-muted-foreground">Active symbols only</span>}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            Computed feature vectors that the V3 coordinator sees on each scan. Click a symbol to load its latest features.
          </p>
          <div className="flex flex-wrap gap-2">
            {ACTIVE_SYMBOLS.map(sym => (
              <Btn key={sym} label={featLoading[sym] ? `${sym}…` : sym}
                onClick={() => loadFeatures(sym)} loading={featLoading[sym]} small
                variant={features[sym] ? "primary" : "default"} />
            ))}
          </div>
          {Object.entries(features).map(([sym, f]) => (
            <div key={sym} className="rounded border border-border/40 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-primary mb-2">{sym}</div>
              {f.error ? <ErrorBox msg={f.error} /> : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-0">
                  {Object.entries(f).filter(([k]) => !["symbol","error"].includes(k)).slice(0, 24).map(([k, v]) => (
                    <KV key={k} k={k} v={String(v ?? "—")} mono />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────

type Tab = "integrity" | "enrichment" | "topup" | "ai" | "export" | "streaming" | "runtime";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "integrity",  label: "Integrity",   icon: Shield },
  { id: "enrichment", label: "Enrichment",  icon: Layers },
  { id: "topup",      label: "Top-Up",      icon: Database },
  { id: "ai",         label: "AI Research", icon: Brain },
  { id: "export",     label: "Export",      icon: Download },
  { id: "streaming",  label: "Streaming",   icon: Radio },
  { id: "runtime",    label: "Runtime",     icon: Cpu },
];

export default function Diagnostics() {
  const [tab, setTab] = useState<Tab>("integrity");

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Settings2 className="w-6 h-6 text-muted-foreground" />
          Diagnostics
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Low-level operational tools — data integrity, enrichment, top-up, AI research, streaming, and runtime state
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border/50 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/60"
            )}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "integrity"  && <IntegrityTab />}
      {tab === "enrichment" && <EnrichmentTab />}
      {tab === "topup"      && <TopUpTab />}
      {tab === "ai"         && <AiResearchTab />}
      {tab === "export"     && <ExportTab />}
      {tab === "streaming"  && <StreamingTab />}
      {tab === "runtime"    && <RuntimeTab />}
    </div>
  );
}
