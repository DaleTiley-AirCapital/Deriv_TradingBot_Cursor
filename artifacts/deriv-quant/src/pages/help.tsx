import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  ChevronDown,
  Download,
  FlaskConical,
  Layers,
  Package,
  Settings2,
  TrendingUp,
} from "lucide-react";
import { ACTIVE_SERVICE_SYMBOLS, getSymbolLabel } from "@/lib/symbolCatalog";

const BASE = import.meta.env.BASE_URL || "/";

interface ReleaseEntry {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

interface VersionInfo {
  name: string;
  version: string;
  lastUpdated: string;
  deployedAt?: string | null;
  deploymentId?: string | null;
  gitCommitSha?: string | null;
  gitCommitMessage?: string | null;
  releases: ReleaseEntry[];
}

const CRASH_FAMILY_RESEARCH = `# Crash Family

Crash-family services are state-first, not generic trend-only systems.

Core states
- drift up / recovery
- crash event
- post-crash shock
- post-crash recovery
- failed recovery

Key engine design points
- bars or ticks since crash matter more than generic oscillator extremes
- crash magnitude and recovery quality decide whether follow-through or recovery is more likely
- volatility compression and expansion help time when a move is still developing
- drift persistence helps separate tactical shorts from structural recovery
- event-aware risk is mandatory because short trades are tactical and long trades capture drift or recovery

Trade philosophy
- short trades are tactical: crash follow-through or failed recovery
- long trades exploit drift and recovery
- late offset labels are evaluation metadata only and never become live runtime rules`;

const VOLATILITY_SERIES_RESEARCH = `# Volatility Series

R_75 and R_100 belong to the standard volatility family and should use a regime-first, volatility-normalised, symbol-specific engine.

R_75 priorities
- trend_continuation
- breakout_continuation
- pullback_continuation
- gated mean reversion only when calibration supports it

R_100 priorities
- stricter volatility-expansion and impulse-continuation engine
- stronger filters
- wider ATR logic
- smaller sizing

Key engine design points
- EMA stack, slope, and distance
- ADX and DI structure
- Donchian breakout and position inside range
- Bollinger bandwidth and percent B
- ATR percentile or rank
- volatility expansion and compression
- CHOP, efficiency, and Hurst where available
- multi-timeframe alignment
- candle anatomy and MFE or MAE lifecycle labels`;

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatLiveSince(value: string | null | undefined) {
  if (!value) return "Live since unknown";
  const deployed = new Date(value);
  if (Number.isNaN(deployed.getTime())) return "Live since unknown";
  const diffMs = Date.now() - deployed.getTime();
  const totalMinutes = Math.max(0, Math.floor(diffMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `Live for ${minutes}m`;
  if (hours < 24) return `Live for ${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `Live for ${days}d ${remHours}h`;
}

function shortSha(value: string | null | undefined) {
  const sha = String(value ?? "").trim();
  return sha ? sha.slice(0, 7) : "unknown";
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <Icon className="w-5 h-5 text-primary" />
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card p-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{body}</p>
    </div>
  );
}

function ResearchAccordion({
  title,
  summary,
  sourceFile,
  lastUpdated,
  markdown,
}: {
  title: string;
  summary: string;
  sourceFile: string;
  lastUpdated: string;
  markdown: string;
}) {
  return (
    <details className="rounded-lg border border-border/40 bg-card p-4 group">
      <summary className="list-none cursor-pointer flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{summary}</p>
          <p className="text-[11px] text-muted-foreground mt-2">
            Last updated {lastUpdated} | Source file {sourceFile}
          </p>
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground mt-0.5 transition-transform group-open:rotate-180" />
      </summary>
      <pre className="mt-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground bg-background/60 border border-border/30 rounded-lg p-3 overflow-x-auto">
        {markdown}
      </pre>
    </details>
  );
}

export default function Help() {
  const { data } = useQuery<VersionInfo>({
    queryKey: ["/api/version"],
    queryFn: async () => {
      const res = await fetch(`${BASE}api/version`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 60_000,
  });

  const commitLine = `${shortSha(data?.gitCommitSha)} ${String(data?.gitCommitMessage ?? "commit summary unavailable")}`;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-10">
      <div className="flex items-start gap-4 pb-6 border-b border-border/40">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {data?.name ?? "Deriv Trading - Long Hold V3.1"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Shared trading platform with independent symbol services and a portfolio allocator.
          </p>
          <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 bg-primary/10 text-primary px-2.5 py-1 rounded-full">
              <Package className="w-3 h-3" /> v{data?.version ?? "current"}
            </span>
            <span>Updated {data?.lastUpdated ?? "-"}</span>
            <span>Last deploy: {formatLiveSince(data?.deployedAt)}</span>
            <span>Commit: {commitLine}</span>
            <span>Deployed at: {formatDateTime(data?.deployedAt)}</span>
          </div>
          {data?.deploymentId ? (
            <details className="mt-3 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">Deployment details</summary>
              <div className="mt-2 rounded-lg border border-border/30 bg-card px-3 py-2">
                Railway deployment id: {data.deploymentId}
              </div>
            </details>
          ) : null}
        </div>
      </div>

      <Section title="Architecture" icon={Layers}>
        <Card
          title="Canonical flow"
          body="Symbol Service -> Trade Candidate -> Portfolio Allocator -> Trade Execution/Manager. Symbol services own calibration models, runtime models, feature snapshots, trigger or archetype detection, candidate creation, and trade management policy. The allocator owns only capital, exposure, and portfolio risk gates."
        />
        <Card
          title="Current active services"
          body={ACTIVE_SERVICE_SYMBOLS.map((symbol) => `${symbol} (${getSymbolLabel(symbol)})`).join(" | ")}
        />
        <Card
          title="Portfolio objective"
          body="The 50 percent monthly target is a portfolio-level objective across active services. Individual symbols such as CRASH300, BOOM300, R_75, and R_100 are contributors, not standalone mandatory 50 percent engines."
        />
      </Section>

      <Section title="Research Workflow" icon={FlaskConical}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            title="Per-service sequence"
            body="Full Calibration -> Review calibration runs -> Stage Research Model -> Promote Runtime -> Run parity and trigger validation -> Run backtests -> Export reports -> Run integrated elite synthesis -> Stage a paper-only candidate when it is ready."
          />
          <Card
            title="Current handover"
            body="CRASH300 is preserved as the V3.1 paper-only baseline candidate while symbol-service optimisation moves next to R_75, then BOOM300, then R_100 after full calibration."
          />
        </div>
      </Section>

      <Section title="Deep Research" icon={BookOpen}>
        <div className="space-y-4">
          <ResearchAccordion
            title="Crash Family"
            summary="Crash-family services are state-first systems where recovery quality, crash recency, and event-aware risk matter more than generic trend labels."
            sourceFile="docs/research/deep-research-report.md"
            lastUpdated="2026-05-09"
            markdown={CRASH_FAMILY_RESEARCH}
          />
          <ResearchAccordion
            title="Volatility Series"
            summary="R_75 and R_100 belong to the volatility family and should use volatility-normalised, regime-first, symbol-specific engines instead of Crash-family state labels."
            sourceFile="docs/research/deep-research-report.md"
            lastUpdated="2026-05-09"
            markdown={VOLATILITY_SERIES_RESEARCH}
          />
        </div>
      </Section>

      <Section title="Page Guide" icon={BookOpen}>
        <div className="space-y-3">
          {[
            { page: "Overview", path: "/", desc: "Global system state, streaming health, allocator and portfolio snapshot, and active service summary." },
            { page: "Engine Decisions", path: "/decisions", desc: "Selected service decisions, candidate or rejection status, fail reasons, allocator outcomes, and runtime evidence." },
            { page: "Trades", path: "/trades", desc: "Service-filtered open and closed trades plus attribution, with allocator and symbol-service fields separated." },
            { page: "Research", path: "/research", desc: "Per-service calibration, runtime model, reports, backtests, worker jobs, and integrated elite synthesis exports. CRASH300 V3.1 baseline artifacts remain visible here and are not live-approved." },
            { page: "Data", path: "/data", desc: "Streaming state, candle coverage, exports, and runtime diagnostics. Historical feature snapshots stay diagnostic only." },
            { page: "Settings", path: "/settings", desc: "Global controls only: kill switch, mode activation, promoted runtime profile toggle, capital, exposure, open positions, and drawdown protection." },
          ].map((item) => (
            <div key={item.page} className="flex items-start gap-3 rounded-lg border border-border/40 bg-card px-4 py-3">
              <span className="font-mono text-[11px] text-primary bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 shrink-0 mt-0.5">{item.path}</span>
              <div>
                <p className="text-sm font-medium text-foreground">{item.page}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Runtime State" icon={Activity}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            title="What a Trade Candidate owns"
            body="Symbol, direction, runtime family or archetype, calibrated base family, bucket, entry reason, quality or elite score, confidence, TP, SL, trailing policy, candidate expiry, and model source or version."
          />
          <Card
            title="What the allocator owns"
            body="Cross-service candidate ranking, available capital, max total exposure, max per-symbol exposure, max per-trade exposure, max open positions, and portfolio-level drawdown or risk gates."
          />
          <Card
            title="Paper candidate caution"
            body="A staged synthesis candidate is paper-only unless runtime mimic validation, demo validation, and a later manual promotion all pass. Staging does not enable live trading."
          />
          <Card
            title="R_75 next"
            body="R_75 is the next active optimisation target and uses the Volatility Series template: trend continuation, breakout continuation, pullback continuation, and gated mean reversion only if calibration supports it."
          />
        </div>
      </Section>

      <Section title="Exports" icon={Download}>
        <Card
          title="Download behavior"
          body="Heavy JSON exports live under the Research reports flow. Current CRASH300 synthesis, selected-trades, and return-amplification exports are V3.1 baseline research artifacts only and are not live-approved."
        />
      </Section>

      <Section title="Release History" icon={Package}>
        <div className="space-y-3">
          {(data?.releases ?? []).map((release) => (
            <div key={release.version} className="rounded-lg border border-border/40 bg-card p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">v{release.version}</span>
                <span className="text-xs text-muted-foreground">- {release.title}</span>
              </div>
              <p className="text-xs text-muted-foreground/70 mt-1">{release.date}</p>
              <ul className="mt-3 space-y-1.5">
                {release.changes.map((change, index) => (
                  <li key={index} className="text-sm text-muted-foreground">{change}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
