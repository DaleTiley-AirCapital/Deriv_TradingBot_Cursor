import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight, BarChart2, Clock, CircleSlash } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const BASE = import.meta.env.BASE_URL || "/";

function useSyncQuery<T>(path: string, interval = 15_000) {
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

interface Trade {
  id: number;
  symbol: string;
  strategyName: string;
  side: string;
  entryTs: string;
  exitTs?: string;
  entryPrice: number;
  exitPrice?: number;
  sl: number;
  tp: number;
  size: number;
  pnl?: number;
  status: string;
  mode: string;
  exitReason?: string;
  confidence?: number;
}

function formatTs(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function SideChip({ side }: { side: string }) {
  const up = side?.toUpperCase();
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold uppercase ${
      up === "BUY" ? "text-green-400" : "text-red-400"
    }`}>
      {up === "BUY" ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {up}
    </span>
  );
}

function ModeChip({ mode }: { mode: string }) {
  const m = mode?.toUpperCase();
  const color = m === "PAPER" ? "border-amber-500/30 text-amber-400 bg-amber-500/10"
    : m === "DEMO" ? "border-blue-500/30 text-blue-400 bg-blue-500/10"
    : m === "REAL" ? "border-green-500/30 text-green-400 bg-green-500/10"
    : "border-border text-muted-foreground";
  return <Badge variant="outline" className={`text-[10px] ${color}`}>{m}</Badge>;
}

function PnlCell({ pnl }: { pnl?: number }) {
  if (pnl == null) return <span className="text-muted-foreground/50">—</span>;
  const pos = pnl >= 0;
  return (
    <span className={`tabular-nums font-semibold text-sm ${pos ? "text-green-400" : "text-red-400"}`}>
      {pos ? "+" : ""}${pnl.toFixed(2)}
    </span>
  );
}

function TradeRow({ t }: { t: Trade }) {
  const isOpen = t.status === "open";
  return (
    <tr className="border-b border-border/30 hover:bg-muted/20 transition-colors">
      <td className="py-2.5 px-4">
        <div className="flex items-center gap-2">
          <SideChip side={t.side} />
          <span className="font-semibold text-sm">{t.symbol}</span>
          <ModeChip mode={t.mode} />
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{t.strategyName}</div>
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatTs(t.entryTs)}
      </td>
      <td className="py-2.5 px-3 tabular-nums text-sm font-medium">
        {t.entryPrice.toFixed(4)}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground/60 tabular-nums">
        SL {t.sl.toFixed(4)} / TP {t.tp.toFixed(4)}
      </td>
      <td className="py-2.5 px-3 text-center">
        {isOpen ? (
          <Badge variant="outline" className="border-amber-500/30 text-amber-400 bg-amber-500/8 text-[10px]">
            OPEN
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">{t.exitReason ?? "closed"}</span>
        )}
      </td>
      <td className="py-2.5 px-4 text-right">
        <PnlCell pnl={t.pnl} />
      </td>
    </tr>
  );
}

export default function Trades() {
  const open = useSyncQuery<Trade[]>("api/trade/open", 10_000);
  const history = useSyncQuery<Trade[]>("api/trade/history", 30_000);

  const openTrades = open.data ?? [];
  const closedTrades = history.data ?? [];

  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length > 0
    ? ((winners / closedTrades.length) * 100).toFixed(1) : "—";

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Trades</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Open positions and closed trade history across all modes
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Open</p>
            <p className="text-2xl font-bold tabular-nums">{openTrades.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Closed</p>
            <p className="text-2xl font-bold tabular-nums">{closedTrades.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Win Rate</p>
            <p className="text-2xl font-bold tabular-nums">{winRate}{typeof winRate === "string" && winRate !== "—" ? "%" : ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Total P&L</p>
            <p className={`text-2xl font-bold tabular-nums ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Open positions */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" />
            Open Positions
            {openTrades.length > 0 && (
              <Badge className="ml-1 bg-amber-500/15 text-amber-400 border-amber-500/25 text-[10px]">
                {openTrades.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {open.isLoading ? (
            <p className="text-xs text-muted-foreground px-4 pb-4">Loading…</p>
          ) : openTrades.length === 0 ? (
            <div className="text-center py-10">
              <CircleSlash className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No open positions</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Waiting for engine approval with score ≥85 (paper) / ≥90 (demo) / ≥92 (real)
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/50">
                    <th className="text-left py-2 px-4 font-medium">Symbol / Strategy</th>
                    <th className="text-left py-2 px-3 font-medium">Entry Time</th>
                    <th className="text-left py-2 px-3 font-medium">Entry</th>
                    <th className="text-left py-2 px-3 font-medium">SL / TP</th>
                    <th className="text-center py-2 px-3 font-medium">Status</th>
                    <th className="text-right py-2 px-4 font-medium">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {openTrades.map(t => <TradeRow key={t.id} t={t} />)}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trade history */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-primary" />
            Trade History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.isLoading ? (
            <p className="text-xs text-muted-foreground px-4 pb-4">Loading…</p>
          ) : closedTrades.length === 0 ? (
            <div className="text-center py-10">
              <BarChart2 className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No trade history</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Closed trades will appear here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/50">
                    <th className="text-left py-2 px-4 font-medium">Symbol / Strategy</th>
                    <th className="text-left py-2 px-3 font-medium">Entry Time</th>
                    <th className="text-left py-2 px-3 font-medium">Entry</th>
                    <th className="text-left py-2 px-3 font-medium">SL / TP</th>
                    <th className="text-center py-2 px-3 font-medium">Exit Reason</th>
                    <th className="text-right py-2 px-4 font-medium">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.slice(0, 100).map(t => <TradeRow key={t.id} t={t} />)}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
