import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown, ChevronRight, TrendingUp, Package, Calendar, Zap,
  Database, Brain, Shield, Target, Activity, BarChart3, Radio,
  AlertTriangle, CheckCircle, Clock, BookOpen, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  releases: ReleaseEntry[];
}

const ENGINES: {
  name: string; symbol: string; direction: "up" | "down" | "both";
  desc: string;
}[] = [
  { name: "Boom Expansion", symbol: "BOOM300", direction: "down", desc: "Primary BOOM300 sell engine. Enters after spike-cluster exhaustion near structural highs and rides the natural drift-down leg." },
  { name: "Boom Expansion Long", symbol: "BOOM300", direction: "up", desc: "Secondary BOOM300 buy engine. Enters low-hazard drift-down exhaustion reversals and captures rebound expansions." },
  { name: "Crash Expansion",   symbol: "CRASH300", direction: "down", desc: "Mirrors Boom Expansion for Crash indices. Enters on spike-drop events and targets the continuation sell-off after a Crash spike cluster. Requires direction=down." },
  { name: "R75 Continuation",  symbol: "R_75",     direction: "both", desc: "Follows high-momentum trends on Volatility 75. Enters in the direction of the dominant trend after mean-to-range confirmation. Avoids counter-trend entries." },
  { name: "R75 Reversal",      symbol: "R_75",     direction: "both", desc: "Fades exhausted moves on Volatility 75. Enters counter-trend at extreme range positions where MA deviation is at maximum. High score required." },
  { name: "R75 Breakout",      symbol: "R_75",     direction: "both", desc: "Captures ATR-surge breakouts on Volatility 75. Triggers when range expansion score exceeds the symbol's volatility profile threshold." },
  { name: "R100 Continuation", symbol: "R_100",    direction: "both", desc: "High-momentum trend following on Volatility 100 — calibrated for the higher-volatility index with larger position movement expectations." },
  { name: "R100 Reversal",     symbol: "R_100",    direction: "both", desc: "Exhaustion reversal on Volatility 100. Same 6-component native score structure as R75 Reversal, calibrated to R_100's higher volatility profile." },
  { name: "R100 Breakout",     symbol: "R_100",    direction: "both", desc: "ATR-burst range breakout on Volatility 100. Looks for volatility squeeze followed by directional expansion with confirmation." },
];

const SCORE_GATES = [
  { mode: "Paper", threshold: 60, color: "text-amber-400", note: "Simulated orders against paper capital" },
  { mode: "Demo",  threshold: 65, color: "text-blue-400",  note: "Real orders against Deriv virtual account" },
  { mode: "Real",  threshold: 70, color: "text-red-400",   note: "Live orders with real capital" },
];

const FAQ_ITEMS: { q: string; a: string; icon: React.ReactNode }[] = [
  {
    q: "What are the TP/SL targets?",
    a: "Take profit is calibrated to capture 50–200%+ moves. This is the PRIMARY exit — most trade lifecycle decisions are made relative to TP. The trailing stop is a SAFETY NET only — it activates only after price has moved at least 30% of the TP target distance, then trails at an ATR-proportional distance. There are NO time-based exits. Trades hold 9–44 days until TP, SL, or trailing stop closes them. Never change TP to smaller targets; that defeats the purpose of this system.",
    icon: <Target className="w-4 h-4 text-primary" />,
  },
  {
    q: "What is the difference between Paper, Demo, and Real modes?",
    a: "Paper mode uses simulated orders against paper capital — no Deriv account required. Positions are tracked internally with floating PnL, no real money changes hands. Demo mode sends real orders to Deriv's virtual account (VRTC prefix). Real mode sends live orders using real capital. Each mode has its own score gate: Paper ≥ 60, Demo ≥ 65, Real ≥ 70. These gates will be raised as engine calibration data accumulates.",
    icon: <Shield className="w-4 h-4 text-primary" />,
  },
  {
    q: "Why did a high-scoring signal get blocked?",
    a: "A signal that passes the engine's composite score gate may still be blocked by system-level gates: Kill switch active, daily/weekly loss limit reached, maximum drawdown exceeded, open risk limit hit, maximum concurrent trades reached, AI disagreement (if AI verification is enabled), or trading mode not active. The Engine Decisions page explains each blocking gate with the specific reason code and detail.",
    icon: <Zap className="w-4 h-4 text-amber-400" />,
  },
  {
    q: "How does native engine scoring work?",
    a: "Each of the 9 engines computes its own 6-component native score (0–100) using dimensions specific to that symbol and entry type. For example, BOOM300/CRASH300 engines score cluster pressure, displacement, exhaustion, recovery quality, entry efficiency, and expected move magnitude. R_75/R_100 engines score trend quality, pullback quality, slope, structure, entry efficiency, and expected move. All six components combine into a single native score. There is no shared generic scoring path — each engine's dimensions are calibrated to that specific market behaviour.",
    icon: <BarChart3 className="w-4 h-4 text-primary" />,
  },
  {
    q: "What is the candidate lifecycle?",
    a: "Signals progress through a lifecycle: idle → watch → qualified → tradeable → executed. A signal enters watch when it first crosses the engine gate. It must score consistently above the gate across multiple evaluation cycles to reach tradeable state. This multi-window confirmation prevents single-candle false positives. The Engine Decisions page shows the lifecycle state, score trend, and the specific gate that blocked or approved each signal.",
    icon: <Clock className="w-4 h-4 text-amber-400" />,
  },
  {
    q: "What is the AI Verdict?",
    a: "After the engine scores a signal above threshold, a GPT-4o model independently evaluates it using regime context, all 6 scoring dimensions, and trade parameters. It returns Agree, Disagree, or Uncertain with reasoning. A Disagree does not automatically block the trade unless 'AI Verification' is enabled in settings — but it is always logged. 'Skipped' means the signal was blocked by a gate before reaching the AI layer.",
    icon: <Brain className="w-4 h-4 text-primary" />,
  },
  {
    q: "What does 'Interpolated' mean in the Data page?",
    a: "When tick-derived candle data has gaps (e.g. no ticks arrived for a minute), the system inserts synthetic interpolated candles using the previous real close to maintain time continuity. These are NOT real market data. Signals are penalized or blocked if too many interpolated candles appear in the evaluation window. Use Data → Data Operations → Repair Interpolated to attempt recovery from the Deriv API.",
    icon: <AlertTriangle className="w-4 h-4 text-amber-400" />,
  },
  {
    q: "Why is streaming offline for some symbols?",
    a: "Streaming means the server is actively receiving real-time ticks from Deriv's API for that symbol. It requires a valid Deriv API token configured in Settings. The 4 active trading symbols (CRASH300, BOOM300, R_75, R_100) should be streaming during active hours. Other symbols may be idle — they have historical candle data but no live tick feed. Toggle streaming per symbol in the Data page → Symbol State tab.",
    icon: <Radio className="w-4 h-4 text-green-400" />,
  },
  {
    q: "What does the Coordinator do?",
    a: "For symbols with multiple engines (R_75, R_100), the V3 Symbol Coordinator resolves conflicts when multiple engines fire simultaneously. Priority: breakout > continuation > reversal. Direction conflicts are suppressed unless the confidence gap between engines is ≥ 0.12. The Coordinator output feeds the Portfolio Allocator, which gates the final entry based on capital, equity %, current portfolio state, and risk limits (kill switch, drawdown, concurrent trade caps). The Engine Decisions page shows coordinator and allocator outcomes.",
    icon: <Layers className="w-4 h-4 text-primary" />,
  },
  {
    q: "How do I read the scoring dimensions in the Decisions panel?",
    a: "Each dimension shows a bar from 0 to 100. Higher bars are better. A dimension at 50 is neutral. The displayed dimensions are engine-specific — Boom/Crash engines show cluster pressure, displacement, exhaustion, etc. R_75/R_100 engines show trend quality, pullback quality, slope, etc. The composite score (native score) is a weighted combination of all six components. Weak components are called out explicitly in the rejection reason when a signal is blocked.",
    icon: <Activity className="w-4 h-4 text-primary" />,
  },
];

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        {icon}
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function FaqAccordion({ items }: { items: typeof FAQ_ITEMS }) {
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-border/40 bg-card overflow-hidden">
          <button
            onClick={() => setOpen(o => ({ ...o, [i]: !o[i] }))}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
          >
            <div className="shrink-0">{item.icon}</div>
            <span className="flex-1 text-sm font-medium text-foreground">{item.q}</span>
            {open[i]
              ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
          </button>
          {open[i] && (
            <div className="px-4 pb-4 pt-0 border-t border-border/20">
              <p className="text-sm text-muted-foreground leading-relaxed mt-3">{item.a}</p>
            </div>
          )}
        </div>
      ))}
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

  const [relExpanded, setRelExpanded] = useState<Record<string, boolean>>({ "3.0.0": true });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-10">
      {/* Header */}
      <div className="flex items-start gap-4 pb-6 border-b border-border/40">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {data?.name ?? "Deriv Trading — Long Hold V3"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Large capital · long hold · maximum profit — Boom, Crash, and Volatility synthetic indices
          </p>
          <div className="flex items-center gap-4 mt-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-mono bg-primary/10 text-primary px-2.5 py-1 rounded-full">
              <Package className="w-3 h-3" /> v{data?.version ?? "3.0.0"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" /> {data?.lastUpdated ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Core Strategy */}
      <Section title="Core Strategy" icon={<Target className="w-5 h-5 text-primary" />}>
        <div className="rounded-lg border border-border/40 bg-card p-4 space-y-4 text-sm text-muted-foreground">
          <p>
            Targets real price moves of <span className="text-foreground font-semibold">50–200%+</span> on
            Boom, Crash, and Volatility synthetic indices using a multi-engine, multi-window
            confirmation framework. This system is designed for <strong className="text-foreground">large capital, long hold</strong> — not
            scalping or frequent trading.
          </p>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-2">Active Trading Symbols</p>
              <div className="flex flex-wrap gap-1.5">
                {["CRASH300", "BOOM300", "R_75", "R_100"].map(s => (
                  <span key={s} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-2">Score Gates</p>
              <div className="space-y-1">
                {SCORE_GATES.map(g => (
                  <div key={g.mode} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{g.mode}</span>
                    <span className={cn("font-bold tabular-nums", g.color)}>≥ {g.threshold}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md bg-primary/5 border border-primary/15 px-3 py-2.5">
            <p className="text-xs text-muted-foreground/90 leading-relaxed">
              <strong className="text-primary">Exit hierarchy:</strong> TP hit (primary) → ATR-proportional trailing stop (safety, activates after 30% of TP distance).
              No time-based exits — trades hold 9–44 days. Never reduce TP targets — the 50–200%+ mandate is non-negotiable.
            </p>
          </div>
        </div>
      </Section>

      {/* Mode Thresholds */}
      <Section title="Trading Modes" icon={<Shield className="w-5 h-5 text-primary" />}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {SCORE_GATES.map(g => (
            <div key={g.mode} className="rounded-lg border border-border/40 bg-card p-4">
              <p className={cn("text-sm font-bold", g.color)}>{g.mode}</p>
              <p className={cn("text-2xl font-bold tabular-nums mt-1", g.color)}>≥ {g.threshold}</p>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">{g.note}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground/70 mt-2">
          Current score gates: Paper ≥ 60, Demo ≥ 65, Real ≥ 70.
          Gates will be raised as engine calibration data accumulates.
          See Research → Backtest for engine score distributions.
        </p>
      </Section>

      {/* Signal Engines */}
      <Section title="Signal Engines" icon={<Zap className="w-5 h-5 text-primary" />}>
        <div className="space-y-2">
          {ENGINES.map(e => (
            <div key={e.name} className="rounded-lg border border-border/40 bg-card p-4">
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-foreground">{e.name}</span>
                  <span className={cn(
                    "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold",
                    e.direction === "up"   ? "bg-green-500/12 text-green-400"
                    : e.direction === "down" ? "bg-red-500/12 text-red-400"
                    : "bg-blue-500/12 text-blue-400"
                  )}>
                    {e.direction === "up" ? "↑ BUY" : e.direction === "down" ? "↓ SELL" : "↑↓ BOTH"}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-muted-foreground shrink-0">{e.symbol}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{e.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Native Engine Scoring */}
      <Section title="6-Component Native Engine Scoring" icon={<BarChart3 className="w-5 h-5 text-primary" />}>
        <div className="rounded-lg border border-border/40 bg-card p-4 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Each engine scores its own 6 components specific to that symbol and entry type.
            There is no shared generic scoring path — dimensions differ by engine.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Boom / Crash Engines</p>
              {[
                { dim: "Spike Cluster Pressure", desc: "Density of recent spikes in the relevant direction — measures how active the spike regime is." },
                { dim: "Displacement",           desc: "How far price has moved in the intended direction from the cluster, normalized to range." },
                { dim: "Exhaustion Quality",     desc: "Whether the prior counter-move shows exhaustion characteristics (small body, reversal wicks)." },
                { dim: "Recovery Quality",       desc: "Price recovering toward the cluster after the exhaustion candle — confirms setup validity." },
                { dim: "Entry Efficiency",       desc: "How close the current bar is to the optimal entry point within the setup structure." },
                { dim: "Expected Move",          desc: "Projected magnitude of the continuation move as a percentage of recent range." },
              ].map(({ dim, desc }) => (
                <div key={dim} className="flex gap-2">
                  <CheckCircle className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-foreground">{dim}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Volatility Engines (R_75 / R_100)</p>
              {[
                { dim: "Trend Quality",     desc: "Strength and consistency of the dominant trend direction over the evaluation window." },
                { dim: "Pullback Quality",  desc: "Whether the current retracement is shallow and structured (good for continuation entries)." },
                { dim: "Slope",             desc: "Gradient of the primary moving average — steep slope confirms directional momentum." },
                { dim: "Structure",         desc: "Alignment of price with higher-timeframe support/resistance levels." },
                { dim: "Entry Efficiency",  desc: "Proximity to the optimal entry point based on pullback depth and candle structure." },
                { dim: "Expected Move",     desc: "Projected move magnitude as percentage of the recent swing range." },
              ].map(({ dim, desc }) => (
                <div key={dim} className="flex gap-2">
                  <CheckCircle className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-foreground">{dim}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground pt-3 border-t border-border/30 leading-relaxed">
            All six components combine into a single <strong className="text-foreground">Native Score (0–100)</strong>.
            Weak components (below ~30) are called out explicitly in the Engine Decisions rejection reason.
            Multi-window confirmation requires the score to hold across consecutive evaluation cycles.
          </p>
        </div>
      </Section>

      {/* FAQ */}
      <Section title="Frequently Asked Questions" icon={<BookOpen className="w-5 h-5 text-primary" />}>
        <FaqAccordion items={FAQ_ITEMS} />
      </Section>

      {/* Pages Reference */}
      <Section title="Pages Reference" icon={<Database className="w-5 h-5 text-primary" />}>
        <div className="space-y-2">
          {[
            { page: "Overview",         path: "/",            desc: "System status, portfolio snapshot, mode summary, engine config, data health. Start here." },
            { page: "Engine Decisions", path: "/decisions",   desc: "Every signal decision — scored, classified by state (traded/pending/approved/rejected/blocked/suppressed), with coordinator reasoning and AI verdict." },
            { page: "Trades",           path: "/trades",      desc: "Open positions with floating PnL and progress to TP, closed trade history with exit reasons, attribution by symbol and engine." },
            { page: "Research",         path: "/research",    desc: "Two tabs: AI Analysis (GPT-4o structured research reports per symbol) and Backtest (V3 isolated backtest engine — replay historical candles through live engines, export results as JSON)." },
            { page: "Data",             path: "/data",        desc: "Streaming state for all 28 symbols · candle coverage · data operations · top-up · ZIP export · runtime engine state." },
            { page: "Settings",         path: "/settings",    desc: "Trading mode activation, kill switch, capital, score thresholds, AI verification, streaming config." },
            { page: "Diagnostics",      path: "/diagnostics", desc: "Advanced debug access — raw feature vectors and kill switch. Operational runtime content lives in Data." },
          ].map(({ page, path, desc }) => (
            <div key={page} className="flex items-start gap-3 rounded-lg border border-border/40 bg-card px-4 py-3">
              <span className="font-mono text-[11px] text-primary bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 shrink-0 mt-0.5">{path}</span>
              <div>
                <p className="text-sm font-medium text-foreground">{page}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Release History */}
      {data?.releases && data.releases.length > 0 && (
        <Section title="Release History" icon={<Package className="w-5 h-5 text-primary" />}>
          <div className="space-y-3">
            {data.releases.map(release => {
              const isOpen = !!relExpanded[release.version];
              return (
                <div key={release.version} className="rounded-lg border border-border/40 bg-card overflow-hidden">
                  <button
                    onClick={() => setRelExpanded(p => ({ ...p, [release.version]: !isOpen }))}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                  >
                    {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">v{release.version}</span>
                        <span className="text-xs text-muted-foreground">— {release.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground/60 mt-0.5">{release.date}</p>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-0 border-t border-border/20">
                      <ul className="space-y-1.5 mt-3">
                        {release.changes.map((change, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <span className="text-primary mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-primary/60 inline-block" />
                            {change}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

