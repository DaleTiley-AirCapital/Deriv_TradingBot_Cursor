import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings2, Shield, Target, Radio, Save, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL || "/";

type SettingsMap = Record<string, string>;

function useSettings() {
  return useQuery<SettingsMap>({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/settings`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 10_000,
  });
}

function bool(v?: string) { return v === "true"; }
function num(v?: string, fallback = 0) { return parseFloat(v ?? "") || fallback; }

function Row({ label, field, value, onUpdate, note }: {
  label: string; field: string; value: string;
  onUpdate: (k: string, v: string) => void;
  note?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <div>
        <span className="text-xs text-muted-foreground">{label}</span>
        {note && <span className="text-[10px] text-muted-foreground/50 ml-1.5">({note})</span>}
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            className="w-20 text-right text-sm font-medium bg-muted border border-border rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
            type="number"
            value={val}
            onChange={e => setVal(e.target.value)}
          />
          <button
            className="text-[11px] text-primary font-medium hover:underline"
            onClick={() => { onUpdate(field, val); setEditing(false); }}
          >Save</button>
          <button
            className="text-[11px] text-muted-foreground hover:underline"
            onClick={() => { setVal(value); setEditing(false); }}
          >×</button>
        </div>
      ) : (
        <button
          className="text-sm font-semibold tabular-nums hover:text-primary transition-colors"
          onClick={() => setEditing(true)}
        >
          {value}
        </button>
      )}
    </div>
  );
}

function ModeSection({ mode, label, data, onUpdate }: {
  mode: "paper" | "demo" | "real";
  label: string;
  data: SettingsMap;
  onUpdate: (key: string, value: string) => void;
}) {
  const isActive = bool(data[`${mode}_mode_active`]);
  const capital = data[`${mode}_capital`] ?? "600";
  const minScore = data[`${mode}_min_composite_score`] ?? (mode === "paper" ? "85" : mode === "demo" ? "90" : "92");
  const eqPct = data[`${mode}_equity_pct_per_trade`] ?? "20";
  const maxTrades = data[`${mode}_max_open_trades`] ?? "3";
  const maxDd = data[`${mode}_max_drawdown_pct`] ?? "15";

  const borderColor = isActive
    ? mode === "paper" ? "border-amber-500/40" : mode === "demo" ? "border-blue-500/40" : "border-green-500/40"
    : "border-border/50";
  const badgeClass = isActive
    ? mode === "paper" ? "border-amber-500/30 text-amber-400 bg-amber-500/10"
      : mode === "demo" ? "border-blue-500/30 text-blue-400 bg-blue-500/10"
      : "border-green-500/30 text-green-400 bg-green-500/10"
    : "border-border text-muted-foreground";

  return (
    <Card className={`${borderColor} ${isActive ? "bg-primary/2" : ""}`}>
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span className="uppercase tracking-wide">{label}</span>
          <Badge variant="outline" className={badgeClass}>
            {isActive ? "ACTIVE" : "OFF"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2.5">
        <Row label="Capital ($)" field={`${mode}_capital`} value={capital} onUpdate={onUpdate} />
        <Row label="Min Score" field={`${mode}_min_composite_score`} value={minScore} onUpdate={onUpdate}
          note={mode === "paper" ? "≥85" : mode === "demo" ? "≥90" : "≥92"} />
        <Row label="Equity % / trade" field={`${mode}_equity_pct_per_trade`} value={eqPct} onUpdate={onUpdate} />
        <Row label="Max open trades" field={`${mode}_max_open_trades`} value={maxTrades} onUpdate={onUpdate} />
        <Row label="Max drawdown %" field={`${mode}_max_drawdown_pct`} value={maxDd} onUpdate={onUpdate} />
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useSettings();

  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const r = await fetch(`${BASE}api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Setting updated" });
    },
    onError: () => {
      toast({ title: "Update failed", variant: "destructive" });
    },
  });

  const onUpdate = (key: string, value: string) => updateMutation.mutate({ key, value });

  const killSwitch = bool(data?.["kill_switch"]);
  const aiVerification = bool(data?.["ai_verification_enabled"]);
  const streaming = bool(data?.["streaming"]);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Settings2 className="w-6 h-6" />
            Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            V3 system configuration — mode thresholds, capital, risk limits
          </p>
        </div>
      </div>

      {/* Kill switch warning */}
      {killSwitch && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Kill Switch Active</p>
            <p className="text-xs text-red-300/70 mt-0.5">All trading is halted. Disable via Diagnostics.</p>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading settings…</p>}
      {isError && <p className="text-sm text-red-400">Failed to load settings</p>}

      {data && (
        <>
          {/* System controls */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Target className="w-4 h-4 text-primary" />
                System Controls
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">AI Verification</span>
                <Badge variant="outline" className={aiVerification
                  ? "border-green-500/30 text-green-400 bg-green-500/10"
                  : "border-muted text-muted-foreground"}>
                  {aiVerification ? "ENABLED" : "DISABLED"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Live Streaming</span>
                <Badge variant="outline" className={streaming
                  ? "border-green-500/30 text-green-400 bg-green-500/10"
                  : "border-muted text-muted-foreground"}>
                  <Radio className="w-3 h-3 mr-1" />
                  {streaming ? "ON" : "OFF"}
                </Badge>
              </div>
              {data["streaming_symbols"] && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Streaming symbols</span>
                  <span className="text-xs font-mono">{data["streaming_symbols"]}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Min composite score (global)</span>
                <span className="text-sm font-semibold tabular-nums">{data["min_composite_score"] ?? "80"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Score thresholds callout */}
          <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-primary">Score Thresholds (Non-Negotiable)</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Paper ≥ 85 · Demo ≥ 90 · Real ≥ 92 · TP target 50–200%+
                </p>
              </div>
            </div>
          </div>

          {/* Mode sections */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ModeSection mode="paper" label="Paper" data={data} onUpdate={onUpdate} />
            <ModeSection mode="demo" label="Demo" data={data} onUpdate={onUpdate} />
            <ModeSection mode="real" label="Real" data={data} onUpdate={onUpdate} />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
            <Save className="w-3 h-3" />
            Click any value to edit inline. Changes are saved immediately.
          </div>
        </>
      )}
    </div>
  );
}
