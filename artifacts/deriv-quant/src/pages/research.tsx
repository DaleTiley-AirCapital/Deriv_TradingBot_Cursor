import { useQuery } from "@tanstack/react-query";
import { FlaskConical, BarChart3, Download, RefreshCw, Database, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL || "/";

function useSyncQuery<T>(path: string, interval = 60_000) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: async () => {
      const r = await fetch(`${BASE}${path.replace(/^\//, "")}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    refetchInterval: interval,
    staleTime: interval / 2,
  });
}

interface SymbolStatus {
  symbol: string;
  tier: string;
  count1m: number;
  count5m: number;
  totalCandles: number;
  oldestDate?: string;
  newestDate?: string;
  status: string;
}

interface DataStatus {
  symbols?: SymbolStatus[];
}

const ACTIVE = ["CRASH300", "BOOM300", "R_75", "R_100"];

function HealthDot({ status }: { status?: string }) {
  const color = status === "current" ? "bg-green-400"
    : status === "stale" ? "bg-amber-400"
    : "bg-red-400";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

function formatNum(n: number) {
  if (!n) return "0";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
    : String(n);
}

export default function Research() {
  const status = useSyncQuery<DataStatus>("api/research/data-status", 60_000);

  const symbols = status.data?.symbols ?? [];
  const active = symbols.filter(s => ACTIVE.includes(s.symbol));
  const others = symbols.filter(s => !ACTIVE.includes(s.symbol));

  const totalCandles = symbols.reduce((s, x) => s + (x.totalCandles ?? 0), 0);
  const totalM1 = symbols.reduce((s, x) => s + (x.count1m ?? 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            Research
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Market data coverage · strategy analysis · AI research
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => status.refetch()} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Total Candles</p>
            <p className="text-2xl font-bold tabular-nums">{formatNum(totalCandles)}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{formatNum(totalM1)} M1 bars</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Symbols Tracked</p>
            <p className="text-2xl font-bold tabular-nums">{symbols.length}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{active.length} active · {others.length} research</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Active Symbols</p>
            <p className="text-2xl font-bold tabular-nums">{ACTIVE.length}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">CRASH300 · BOOM300 · R_75 · R_100</p>
          </CardContent>
        </Card>
      </div>

      {/* Active symbol coverage */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Active Symbol Coverage
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {status.isLoading ? (
            <p className="text-xs text-muted-foreground px-4 pb-4">Loading data coverage…</p>
          ) : active.length === 0 ? (
            <div className="text-center py-8">
              <Database className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No coverage data available</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/50">
                    <th className="text-left py-2 px-4 font-medium">Symbol</th>
                    <th className="text-right py-2 px-3 font-medium">M1 Candles</th>
                    <th className="text-right py-2 px-3 font-medium">M5 Candles</th>
                    <th className="text-right py-2 px-3 font-medium">Total</th>
                    <th className="text-left py-2 px-3 font-medium">Oldest</th>
                    <th className="text-center py-2 px-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map(s => (
                    <tr key={s.symbol} className="border-b border-border/30 hover:bg-muted/20 bg-primary/2">
                      <td className="py-2.5 px-4">
                        <span className="font-semibold">{s.symbol}</span>
                        <Badge variant="outline" className="ml-2 text-[10px] border-primary/30 text-primary">ACTIVE</Badge>
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">{formatNum(s.count1m)}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{formatNum(s.count5m)}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums font-medium">{formatNum(s.totalCandles)}</td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground">
                        {s.oldestDate ? new Date(s.oldestDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <HealthDot status={s.status} />
                          <span className="text-[11px] capitalize">{s.status}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* All other symbols */}
      {others.length > 0 && (
        <Card>
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              Research / Non-Active Symbols
              <Badge variant="outline" className="ml-1 text-[10px]">{others.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/50">
                    <th className="text-left py-2 px-4 font-medium">Symbol</th>
                    <th className="text-right py-2 px-3 font-medium">M1</th>
                    <th className="text-right py-2 px-3 font-medium">M5</th>
                    <th className="text-right py-2 px-3 font-medium">Total</th>
                    <th className="text-center py-2 px-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map(s => (
                    <tr key={s.symbol} className="border-b border-border/30 hover:bg-muted/20">
                      <td className="py-2 px-4 font-medium text-muted-foreground">{s.symbol}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-sm">{formatNum(s.count1m)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-sm text-muted-foreground">{formatNum(s.count5m)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-sm font-medium">{formatNum(s.totalCandles)}</td>
                      <td className="py-2 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <HealthDot status={s.status} />
                          <span className="text-[10px] capitalize text-muted-foreground">{s.status}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Diagnostics link */}
      <Card className="border-dashed border-muted-foreground/20">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
            <div>
              <p className="text-sm text-muted-foreground font-medium">Advanced data controls</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Enrichment, repair, top-up, and AI analysis are in{" "}
                <a href="diagnostics" className="text-primary underline underline-offset-2">Diagnostics</a>
              </p>
            </div>
            <div className="ml-auto">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" asChild>
                <a href="diagnostics"><Download className="w-3 h-3" />Export</a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
