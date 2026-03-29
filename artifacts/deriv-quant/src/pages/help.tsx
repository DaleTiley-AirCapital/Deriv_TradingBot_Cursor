import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, TrendingUp, Package, Calendar } from "lucide-react";

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

export default function Help() {
  const { data, isLoading } = useQuery<VersionInfo>({
    queryKey: ["/api/version"],
    queryFn: async () => {
      const res = await fetch(`${BASE}api/version`);
      if (!res.ok) throw new Error("Failed to fetch version info");
      return res.json();
    },
    staleTime: 60_000,
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "2.0.0": true });

  const toggle = (version: string) =>
    setExpanded((prev) => ({ ...prev, [version]: !prev[version] }));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-start gap-4 pb-6 border-b border-border/40">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{data?.name ?? "Deriv Trading - Long Hold"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Capital extraction platform for Deriv synthetic indices — large capital, long hold, maximum profit.
          </p>
          <div className="flex items-center gap-4 mt-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-mono bg-primary/10 text-primary px-2.5 py-1 rounded-full">
              <Package className="w-3 h-3" />
              v{data?.version ?? "2.0.0"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" />
              Last updated: {data?.lastUpdated ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">Core Strategy</h2>
        <div className="rounded-lg border border-border/40 bg-card p-4 space-y-3 text-sm text-muted-foreground">
          <p>
            Targets real moves of <span className="text-foreground font-medium">50–200%+</span> on Boom, Crash, and Volatility indices.
            Take profit is the primary exit. The 30% trailing stop is a safety net only. 72-hour profitable exit is a capital efficiency backstop.
          </p>
          <p>
            Active trading symbols: <span className="text-foreground font-medium">CRASH300, BOOM300, R_75, R_100</span>.
          </p>
          <p>
            Scoring: 5-dimension empirical Big Move Readiness Score with thresholds — Paper ≥85, Demo ≥90, Real ≥92.
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4">Release History</h2>
        <div className="space-y-3">
          {(data?.releases ?? []).map((release) => {
            const isOpen = !!expanded[release.version];
            return (
              <div key={release.version} className="rounded-lg border border-border/40 bg-card overflow-hidden">
                <button
                  onClick={() => toggle(release.version)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground">v{release.version}</span>
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
                          <span className="text-primary mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-primary/60" />
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
      </div>
    </div>
  );
}
