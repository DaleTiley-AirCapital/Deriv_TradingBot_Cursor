import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Database,
  Download,
  FlaskConical,
  Layers,
  Package,
  Settings2,
  TrendingUp,
  Zap,
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
  releases: ReleaseEntry[];
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-10">
      <div className="flex items-start gap-4 pb-6 border-b border-border/40">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {data?.name ?? "Deriv Trading"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Shared trading platform with independent symbol services and a portfolio allocator.
          </p>
          <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 bg-primary/10 text-primary px-2.5 py-1 rounded-full">
              <Package className="w-3 h-3" /> v{data?.version ?? "current"}
            </span>
            <span>Updated {data?.lastUpdated ?? "-"}</span>
            <span>Last redeploy {formatDateTime(data?.deployedAt)}</span>
            {data?.deploymentId ? <span>Deploy {data.deploymentId}</span> : null}
          </div>
        </div>
      </div>

      <Section title="Architecture" icon={Layers}>
        <Card
          title="Canonical flow"
          body="Symbol Service â†’ Trade Candidate â†’ Portfolio Allocator â†’ Trade Execution/Manager. Symbol services own calibration models, runtime models, feature snapshots, trigger or archetype detection, candidate creation, and trade management policy. The allocator owns only capital, exposure, and portfolio risk gates."
        />
        <Card
          title="Current active services"
          body={ACTIVE_SERVICE_SYMBOLS.map((symbol) => `${symbol} (${getSymbolLabel(symbol)})`).join(" Â· ")}
        />
      </Section>

      <Section title="Research Workflow" icon={FlaskConical}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            title="Per-service sequence"
            body="Full Calibration â†’ Review calibration runs â†’ Stage Research Model â†’ Promote Runtime â†’ Run parity and trigger validation â†’ Run backtests â†’ Export reports. CRASH300 is the current template for this workflow."
          />
          <Card
            title="Reports"
            body="Use Research â†’ Reports to export detected moves, calibration profiles, pass results, parity, phase identifiers, backtest summaries, trades, attribution, reconciliation, and policy comparisons for the selected service."
          />
        </div>
      </Section>

      <Section title="Page Guide" icon={BookOpen}>
        <div className="space-y-3">
          {[
            { page: "Overview", path: "/", desc: "Global system state, streaming health, allocator and portfolio snapshot, and active service summary." },
            { page: "Engine Decisions", path: "/decisions", desc: "Selected service decisions, candidate or rejection status, fail reasons, allocator outcomes, and runtime evidence." },
            { page: "Trades", path: "/trades", desc: "Service-filtered open and closed trades plus attribution, with allocator and symbol-service fields separated." },
            { page: "Research", path: "/research", desc: "Service-specific calibration, runtime model, reports, backtests, and advanced diagnostics. The old analysis-first workflow has been removed from active use." },
            { page: "Data", path: "/data", desc: "Streaming state, candle coverage, exports, and runtime diagnostics. Legacy V3 feature snapshots are clearly labeled as diagnostics only." },
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
        </div>
      </Section>

      <Section title="Exports" icon={Download}>
        <Card
          title="Download behavior"
          body="Heavy JSON exports live under the Research reports flow. The UI should download report artifacts instead of rendering large payloads inline. Missing service artifacts should fail loudly with a visible error instead of silently falling back."
        />
      </Section>

      <Section title="Release History" icon={Package}>
        <div className="space-y-3">
          {(data?.releases ?? []).map((release) => (
            <div key={release.version} className="rounded-lg border border-border/40 bg-card p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">v{release.version}</span>
                <span className="text-xs text-muted-foreground">â€” {release.title}</span>
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


