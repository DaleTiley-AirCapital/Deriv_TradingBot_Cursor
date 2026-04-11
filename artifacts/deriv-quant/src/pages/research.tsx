import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FlaskConical, Brain, Download, Play, RefreshCw,
  Loader2, CheckCircle, XCircle, ChevronRight, AlertTriangle,
  FileText, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts).then(async r => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const d = await r.json(); msg = d.error ?? d.message ?? msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  });
}

const ALL_SYMBOLS = [
  "BOOM300","CRASH300","R_75","R_100",
  "BOOM1000","CRASH1000","BOOM900","CRASH900","BOOM600","CRASH600","BOOM500","CRASH500",
  "R_10","R_25","R_50","RDBULL","RDBEAR",
  "JD10","JD25","JD50","JD75","JD100",
  "stpRNG","stpRNG2","stpRNG3","stpRNG5","RB100","RB200",
];
const ACTIVE = ["CRASH300", "BOOM300", "R_75", "R_100"];

type Tab = "ai" | "export";
const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "ai",     label: "AI Analysis", icon: Brain    },
  { id: "export", label: "Export Data", icon: Download },
];

function StatusPill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 border border-green-500/25"><CheckCircle className="w-3 h-3" />{yes}</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-400 border border-red-500/25"><XCircle className="w-3 h-3" />{no}</span>;
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function SuccessBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
      <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="break-all">{msg}</span>
    </div>
  );
}

function SymbolSelect({ value, onChange, label }: { value: string; onChange: (s: string) => void; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
      >
        {ALL_SYMBOLS.map(s => (
          <option key={s} value={s}>{s}{ACTIVE.includes(s) ? " ●" : ""}</option>
        ))}
      </select>
    </div>
  );
}

// ─── AI Analysis Tab ──────────────────────────────────────────────────────

function AiAnalysisTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [windowDays, setWindowDays] = useState(365);
  const [running, setRunning] = useState(false);
  const [bgStarted, setBgStarted] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = async () => {
    try {
      const d = await apiFetch("research/ai-analyze/status");
      setStatus(d);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    intervalRef.current = setInterval(loadStatus, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const runSync = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const d = await apiFetch("research/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setResult(d.report ?? d);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  const runBackground = async () => {
    setErr(null); setBgStarted(false);
    try {
      await apiFetch("research/ai-analyze/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setBgStarted(true);
    } catch (e: any) { setErr(e.message); }
  };

  const displayResult = result ?? (status?.lastResult?.[symbol] ?? null);

  return (
    <div className="space-y-5">
      {/* Config */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">AI Research Analysis</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Runs a GPT-4o structured analysis on stored candle data for the selected symbol.
            Extracts swing patterns, move size distribution, frequency, and behavioral drift.
            Produces a research report. <strong className="text-foreground">Sync mode blocks until complete (~10–30s).</strong>
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setResult(null); }} label="Symbol:" />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Window:</span>
            {[90, 180, 365].map(d => (
              <button key={d} onClick={() => setWindowDays(d)}
                className={cn("px-2 py-1 rounded border text-xs transition-colors",
                  windowDays === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runSync}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? "Analyzing…" : "Run Sync Analysis"}
          </button>
          <button
            onClick={runBackground}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border/50 text-foreground text-xs font-medium hover:border-border hover:bg-muted/30 transition-colors"
          >
            <Clock className="w-3.5 h-3.5" /> Start Background Job
          </button>
          <button onClick={loadStatus}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border/40 text-muted-foreground text-xs hover:border-border transition-colors">
            <RefreshCw className="w-3 h-3" /> Status
          </button>
        </div>
        {err && <ErrorBox msg={err} />}
        {bgStarted && <SuccessBox msg={`Background analysis started for ${symbol} (${windowDays}d window). Check status panel.`} />}
      </div>

      {/* Background job status */}
      {status && (
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Background Job Status</h3>
            <StatusPill ok={!status.running} yes="Idle" no="Running" />
          </div>
          {Object.keys(status.lastRun ?? {}).length === 0 ? (
            <p className="text-xs text-muted-foreground">No jobs run yet this session.</p>
          ) : (
            <div className="space-y-1">
              {Object.entries(status.lastRun ?? {}).map(([sym, ts]) => (
                <div key={sym} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-muted-foreground">{sym}</span>
                  <span className="text-foreground">{String(ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Result */}
      {displayResult && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">Research Report — {symbol}</h3>
          </div>
          {typeof displayResult === "string" ? (
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap bg-muted/20 rounded p-3 leading-relaxed max-h-96 overflow-y-auto">
              {displayResult}
            </pre>
          ) : (
            <div className="space-y-2">
              {Object.entries(displayResult).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 py-1.5 border-b border-border/20 last:border-0">
                  <span className="text-xs text-muted-foreground w-40 shrink-0">{k}</span>
                  <span className="text-xs font-mono text-foreground break-all">{JSON.stringify(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Export Data Tab ──────────────────────────────────────────────────────

function ExportTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().split("T")[0];
  });
  const [to, setTo] = useState(() => new Date().toISOString().split("T")[0]);
  const [format, setFormat] = useState<"json" | "csv">("csv");
  const [precheck, setPrecheck] = useState<any | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckErr, setPrecheckErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const runPrecheck = async () => {
    setPrechecking(true); setPrecheck(null); setPrecheckErr(null);
    try {
      const d = await apiFetch(`export/precheck?symbol=${symbol}&from=${from}&to=${to}`);
      setPrecheck(d);
    } catch (e: any) { setPrecheckErr(e.message); }
    finally { setPrechecking(false); }
  };

  const runExport = async () => {
    setExporting(true); setExportErr(null);
    try {
      const url = `${BASE}api/export/range?symbol=${symbol}&from=${from}&to=${to}&format=${format}`;
      const link = document.createElement("a");
      link.href = url;
      link.download = `${symbol}_${from}_${to}.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e: any) { setExportErr(e.message); }
    finally { setExporting(false); }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Export Candle Data</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Download historical candle data by date range for external analysis or backup.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <SymbolSelect value={symbol} onChange={setSymbol} label="Symbol:" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-16">Format:</span>
              <div className="flex gap-1.5">
                {(["csv", "json"] as const).map(f => (
                  <button key={f} onClick={() => setFormat(f)}
                    className={cn("px-2.5 py-1 rounded border text-xs transition-colors",
                      format === f ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10">From:</span>
              <input
                type="date"
                value={from}
                onChange={e => setFrom(e.target.value)}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10">To:</span>
              <input
                type="date"
                value={to}
                onChange={e => setTo(e.target.value)}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap pt-1">
          <button onClick={runPrecheck} disabled={prechecking}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border/50 text-foreground text-xs font-medium hover:border-border hover:bg-muted/30 transition-colors disabled:opacity-60">
            {prechecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Precheck
          </button>
          <button onClick={runExport} disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60">
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Download {format.toUpperCase()}
          </button>
        </div>

        {precheckErr && <ErrorBox msg={precheckErr} />}
        {exportErr && <ErrorBox msg={exportErr} />}
      </div>

      {precheck && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400" />
            <h3 className="text-sm font-semibold">Precheck Results — {symbol}</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "1m Candles",   value: (precheck.count1m ?? precheck.totalRows ?? 0).toLocaleString() },
              { label: "5m Candles",   value: (precheck.count5m ?? "—").toLocaleString?.() ?? "—" },
              { label: "Date Range",   value: precheck.from && precheck.to ? `${precheck.from} → ${precheck.to}` : "—" },
              { label: "Interpolated", value: precheck.interpolatedCount != null ? precheck.interpolatedCount.toLocaleString() : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="bg-muted/20 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                <div className="text-sm font-mono font-bold text-foreground">{value}</div>
              </div>
            ))}
          </div>
          {precheck.warnings?.length > 0 && (
            <div className="space-y-1">
              {precheck.warnings.map((w: string, i: number) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Data Status Summary ──────────────────────────────────────────────────

function DataSummaryBanner() {
  const { data } = useQuery({
    queryKey: ["research/data-status"],
    queryFn: () => apiFetch("research/data-status"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  if (!data?.symbols) return null;

  const total = data.symbols.reduce((s: number, x: any) => s + (x.totalCandles ?? 0), 0);
  const current = data.symbols.filter((s: any) => s.status === "current").length;
  const stale = data.symbols.filter((s: any) => s.status === "stale").length;
  const noData = data.symbols.filter((s: any) => !s.status || s.status === "none").length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[
        { label: "Total Candles",    value: total >= 1_000_000 ? `${(total / 1_000_000).toFixed(2)}M` : `${(total / 1_000).toFixed(0)}K`, color: "text-foreground" },
        { label: "Symbols Tracked",  value: String(data.symbols.length), color: "text-foreground" },
        { label: "Current",          value: String(current),  color: "text-green-400" },
        { label: "Stale / No Data",  value: `${stale} / ${noData}`, color: stale + noData > 0 ? "text-amber-400" : "text-muted-foreground" },
      ].map(({ label, value, color }) => (
        <div key={label} className="rounded-xl border border-border/50 bg-card px-4 py-3">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
          <p className={cn("text-xl font-bold tabular-nums mt-0.5", color)}>{value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────

export default function Research() {
  const [tab, setTab] = useState<Tab>("ai");

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-primary" />
          Research
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          AI market analysis · candle data export · Data operations moved to Data console
        </p>
      </div>

      {/* Data summary */}
      <DataSummaryBanner />

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
      {tab === "ai"     && <AiAnalysisTab />}
      {tab === "export" && <ExportTab />}
    </div>
  );
}
