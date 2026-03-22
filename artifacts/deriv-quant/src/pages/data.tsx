import React, { useState } from "react";
import { 
  useGetDataStatus, 
  useStartStream, 
  useStopStream,
  useGetTicks,
  useGetCandles,
  getGetDataStatusQueryKey,
  useGetSpikeEvents
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Select } from "@/components/ui-elements";
import { formatNumber, cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Database, Play, Square } from "lucide-react";

const ALL_SYMBOLS = [
  { value: "BOOM1000", label: "Boom 1000" },
  { value: "CRASH1000", label: "Crash 1000" },
  { value: "BOOM900", label: "Boom 900" },
  { value: "CRASH900", label: "Crash 900" },
  { value: "BOOM600", label: "Boom 600" },
  { value: "CRASH600", label: "Crash 600" },
  { value: "BOOM500", label: "Boom 500" },
  { value: "CRASH500", label: "Crash 500" },
  { value: "BOOM300", label: "Boom 300" },
  { value: "CRASH300", label: "Crash 300" },
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" },
  { value: "RDBULL", label: "Bull Market" },
  { value: "RDBEAR", label: "Bear Market" },
  { value: "JD10", label: "Jump 10" },
  { value: "JD25", label: "Jump 25" },
  { value: "JD50", label: "Jump 50" },
  { value: "JD75", label: "Jump 75" },
  { value: "JD100", label: "Jump 100" },
  { value: "stpRNG", label: "Step Index" },
  { value: "STP2", label: "Step 200" },
  { value: "STP3", label: "Step 300" },
  { value: "STP4", label: "Step 400" },
  { value: "STP5", label: "Step 500" },
  { value: "RDBR100", label: "Range Break 100" },
  { value: "RDBR200", label: "Range Break 200" },
];

const ALL_STREAM_SYMBOLS = ALL_SYMBOLS.map(s => s.value);

export default function DataManager() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'ticks' | 'candles' | 'spikes'>('ticks');
  const [symbol, setSymbol] = useState("BOOM1000");

  const { data: status } = useGetDataStatus({ query: { refetchInterval: 3000 } });
  
  const invalidator = {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetDataStatusQueryKey() })
  };

  const { mutate: startStream, isPending: startingStream } = useStartStream({ mutation: invalidator });
  const { mutate: stopStream, isPending: stoppingStream } = useStopStream({ mutation: invalidator });

  const { data: ticks } = useGetTicks({ symbol, limit: 15 }, { query: { enabled: tab === 'ticks', refetchInterval: 2000 } });
  const { data: candles } = useGetCandles({ symbol, timeframe: 'M1', limit: 15 }, { query: { enabled: tab === 'candles' } });
  const { data: spikes } = useGetSpikeEvents({ symbol, limit: 15 }, { query: { enabled: tab === 'spikes' } });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Data Pipeline</h1>
          <p className="page-subtitle">Tick ingestion, derived candles, and event labelling</p>
        </div>
      </div>

      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>
            <Database className="w-4 h-4 text-primary" />
            Stream Control
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center py-2.5 border-b border-border/40">
            <span className="text-sm text-muted-foreground">Status</span>
            <Badge variant={status?.streaming ? "success" : "outline"}>
              {status?.streaming ? "Streaming" : "Offline"}
            </Badge>
          </div>
          <div className="flex justify-between items-center py-2.5 border-b border-border/40">
            <span className="text-sm text-muted-foreground">Tick Count</span>
            <span className="font-mono tabular-nums text-sm font-semibold">{formatNumber(status?.tickCount, 0)}</span>
          </div>
          <div className="pt-2 flex gap-2">
            <Button 
              variant="outline" 
              className="flex-1 text-success border-success/40 hover:bg-success/8 hover:border-success/60"
              disabled={status?.streaming}
              onClick={() => startStream({ data: { symbols: ALL_STREAM_SYMBOLS }})}
              isLoading={startingStream}
            >
              <Play className="w-3.5 h-3.5" />
              Start
            </Button>
            <Button 
              variant="outline" 
              className="flex-1 text-destructive border-destructive/40 hover:bg-destructive/8 hover:border-destructive/60"
              disabled={!status?.streaming}
              onClick={() => stopStream()}
              isLoading={stoppingStream}
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <div className="flex flex-col sm:flex-row justify-between border-b border-border/50">
          <div className="flex">
            {(['ticks', 'candles', 'spikes'] as const).map(t => (
              <button
                key={t}
                className={cn(
                  "px-5 py-3 text-sm font-medium tracking-wide transition-colors capitalize",
                  tab === t
                    ? "text-primary border-b-2 border-primary bg-primary/5"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setTab(t)}
              >
                {t === 'ticks' ? 'Raw Ticks' : t === 'candles' ? 'M1 Candles' : 'Spike Events'}
              </button>
            ))}
          </div>
          <div className="p-2 flex items-center border-t sm:border-t-0 border-border/50">
            <Select className="h-8 w-44 text-xs" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {ALL_SYMBOLS.map(s => (
                <option key={s.value} value={s.value}>{s.value}</option>
              ))}
            </Select>
          </div>
        </div>
        
        <div className="overflow-x-auto">
          {tab === 'ticks' && (
            <table>
              <thead><tr><th>Time</th><th>Symbol</th><th className="text-right">Quote</th><th className="text-right">Epoch</th></tr></thead>
              <tbody>
                {!ticks?.length
                  ? <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">No tick data</td></tr>
                  : ticks.map(t => (
                    <tr key={t.id}>
                      <td className="mono-num text-muted-foreground text-xs">{new Date(t.createdAt).toLocaleTimeString()}</td>
                      <td className="text-sm font-medium text-foreground">{symbol}</td>
                      <td className="text-right mono-num font-semibold">{formatNumber(t.quote, 4)}</td>
                      <td className="text-right mono-num text-xs text-muted-foreground/50">{t.epochTs}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          )}
          {tab === 'candles' && (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="text-right">Open</th>
                  <th className="text-right">High</th>
                  <th className="text-right">Low</th>
                  <th className="text-right">Close</th>
                  <th className="text-right">Ticks</th>
                </tr>
              </thead>
              <tbody>
                {!candles?.length
                  ? <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No candle data</td></tr>
                  : candles.map(c => (
                    <tr key={c.id}>
                      <td className="mono-num text-muted-foreground text-xs">{new Date(c.openTs * 1000).toLocaleTimeString()}</td>
                      <td className="text-right mono-num">{formatNumber(c.open, 3)}</td>
                      <td className="text-right mono-num text-success">{formatNumber(c.high, 3)}</td>
                      <td className="text-right mono-num text-destructive">{formatNumber(c.low, 3)}</td>
                      <td className="text-right mono-num font-semibold">{formatNumber(c.close, 3)}</td>
                      <td className="text-right mono-num text-muted-foreground">{c.tickCount}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          )}
          {tab === 'spikes' && (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Direction</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">Ticks Since Last</th>
                </tr>
              </thead>
              <tbody>
                {!spikes?.length
                  ? <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">No spike events</td></tr>
                  : spikes.map(s => (
                    <tr key={s.id}>
                      <td className="mono-num text-muted-foreground text-xs">{new Date(s.eventTs * 1000).toLocaleTimeString()}</td>
                      <td><Badge variant={s.direction === 'up' ? 'success' : 'destructive'}>{s.direction}</Badge></td>
                      <td className="text-right mono-num font-semibold">{formatNumber(s.spikeSize, 2)}</td>
                      <td className="text-right mono-num text-muted-foreground">{s.ticksSincePreviousSpike || '—'}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
