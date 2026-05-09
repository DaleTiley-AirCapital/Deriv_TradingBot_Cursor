import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Settings2, Shield, Target, Radio, AlertTriangle, Power,
  TrendingUp, Save, ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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
    staleTime: 8_000,
    refetchInterval: 15_000,
  });
}

function bool(v?: string) { return v === "true"; }

// ─── Inline edit row ──────────────────────────────────────────────────────

function NumRow({ label, field, value, onUpdate, note, min, max }: {
  label: string; field: string; value: string;
  onUpdate: (k: string, v: string) => void;
  note?: string; min?: number; max?: number;
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
            min={min} max={max}
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
          className="text-sm font-semibold tabular-nums hover:text-primary transition-colors flex items-center gap-1"
          onClick={() => setEditing(true)}
        >
          {value}
          <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
        </button>
      )}
    </div>
  );
}

// ─── Toggle row ───────────────────────────────────────────────────────────

function ToggleRow({ label, field, value, onUpdate, onLabel, offLabel, variant = "default" }: {
  label: string; field: string; value: boolean;
  onUpdate: (k: string, v: string) => void;
  onLabel?: string; offLabel?: string;
  variant?: "default" | "danger" | "success";
}) {
  const colors = {
    danger:  { on: "bg-red-500/20 text-red-400 border-red-500/30", off: "bg-muted/40 text-muted-foreground border-border/50" },
    success: { on: "bg-green-500/20 text-green-400 border-green-500/30", off: "bg-muted/40 text-muted-foreground border-border/50" },
    default: { on: "bg-primary/20 text-primary border-primary/30", off: "bg-muted/40 text-muted-foreground border-border/50" },
  }[variant];

  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <button
        onClick={() => onUpdate(field, value ? "false" : "true")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all",
          value ? colors.on : colors.off
        )}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", value ? "bg-current" : "bg-muted-foreground/40")} />
        {value ? (onLabel ?? "ON") : (offLabel ?? "OFF")}
      </button>
    </div>
  );
}

// ─── Mode Section ─────────────────────────────────────────────────────────

function ModeSection({
  mode, label, data, onUpdate,
}: {
  mode: "paper" | "demo" | "real";
  label: string;
  data: SettingsMap;
  onUpdate: (key: string, value: string) => void;
}) {
  const isActive = bool(data[`${mode}_mode_active`]);
  const capital   = data[`${mode}_capital`] ?? "600";
  const eqPct     = data[`${mode}_equity_pct_per_trade`] ?? "20";
  const maxTrades = data[`${mode}_max_open_trades`] ?? "3";
  const maxDd     = data[`${mode}_max_drawdown_pct`] ?? "15";

  const borderColor = isActive
    ? mode === "paper" ? "border-amber-500/40" : mode === "demo" ? "border-blue-500/40" : "border-green-500/40"
    : "border-border/50";

  const headerBg = isActive
    ? mode === "paper" ? "bg-amber-500/8" : mode === "demo" ? "bg-blue-500/8" : "bg-green-500/8"
    : "bg-muted/10";

  const activePill = isActive
    ? mode === "paper" ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
      : mode === "demo" ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
      : "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-muted/40 text-muted-foreground border-border/50";

  return (
    <div className={cn("rounded-xl border overflow-hidden", borderColor)}>
      {/* Header with activation toggle */}
      <div className={cn("px-4 py-3 border-b border-border/30 flex items-center justify-between", headerBg)}>
        <span className="text-sm font-semibold uppercase tracking-wide">{label}</span>
        <button
          onClick={() => onUpdate(`${mode}_mode_active`, isActive ? "false" : "true")}
          className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all", activePill)}
        >
          <Power className="w-3 h-3" />
          {isActive ? "ACTIVE" : "OFF — click to activate"}
        </button>
      </div>

      {/* Settings */}
      <div className="px-4 py-3 space-y-2.5 bg-card">
        <NumRow label="Capital ($)"           field={`${mode}_capital`}                value={capital}   onUpdate={onUpdate} min={0} />
        <NumRow label="Max per-trade exposure %" field={`${mode}_equity_pct_per_trade`} value={eqPct} onUpdate={onUpdate} min={1} max={100} />
        <NumRow label="Max open positions"    field={`${mode}_max_open_trades`}        value={maxTrades} onUpdate={onUpdate} min={1} max={20} />
        <NumRow label="Max drawdown protection %" field={`${mode}_max_drawdown_pct`}   value={maxDd} onUpdate={onUpdate} min={1} max={100} />
      </div>
    </div>
  );
}

// ─── Main Settings Page ───────────────────────────────────────────────────

export default function Settings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useSettings();

  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const r = await fetch(`${BASE}api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Setting saved" });
    },
    onError: () => {
      toast({ title: "Update failed", variant: "destructive" });
    },
  });

  const onUpdate = (key: string, value: string) => updateMutation.mutate({ key, value });

  const killSwitch      = bool(data?.["kill_switch"]);
  const calibratedRuntimeProfiles = bool(data?.["use_calibrated_runtime_profiles"]);
  const withdrawalAlert = bool(data?.["suggest_withdrawal"]);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Settings2 className="w-6 h-6" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Global controls for mode activation, capital allocation, portfolio exposure, and runtime profile usage
        </p>
      </div>

      {/* Kill switch banner */}
      {killSwitch && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-400">Kill Switch Active — All Trading Halted</p>
            <p className="text-xs text-red-300/70 mt-0.5">
              No new entries across any mode. Open positions are unaffected.
              Disable below or via Diagnostics → Runtime.
            </p>
          </div>
          <button
            onClick={() => onUpdate("kill_switch", "false")}
            className="text-xs font-semibold text-red-400 border border-red-500/30 rounded px-2.5 py-1 hover:bg-red-500/20 transition-colors shrink-0"
          >
            Disable
          </button>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading settings…</p>}
      {isError && <p className="text-sm text-red-400">Failed to load settings</p>}

      {data && (
        <>
          {/* System Controls */}
          <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border/30 bg-muted/10 flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">System Controls</h2>
            </div>
            <div className="px-4 py-3 space-y-3">
              <ToggleRow
                label="Kill Switch — halt all trading"
                field="kill_switch"
                value={killSwitch}
                onUpdate={onUpdate}
                onLabel="ACTIVE — trading halted"
                offLabel="OFF — trading allowed"
                variant="danger"
              />
              <div className="h-px bg-border/20" />
              <ToggleRow
                label="Use promoted runtime profiles"
                field="use_calibrated_runtime_profiles"
                value={calibratedRuntimeProfiles}
                onUpdate={onUpdate}
                onLabel="ON — selected services read promoted runtime models"
                offLabel="OFF — services fail loudly when runtime model data is required"
                variant="success"
              />
            </div>
          </div>

          {/* Withdrawal alert */}
          {withdrawalAlert && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
              <TrendingUp className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-400">Withdrawal Suggestion Active</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Portfolio has reached the withdrawal threshold. Consider withdrawing profits to protect gains.
                </p>
              </div>
            </div>
          )}

          {/* Trading Mode Sections */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Power className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Trading Modes</h2>
              <span className="text-[11px] text-muted-foreground/60">(click mode header to activate/deactivate)</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ModeSection mode="paper" label="Paper"  data={data} onUpdate={onUpdate} />
              <ModeSection mode="demo"  label="Demo"   data={data} onUpdate={onUpdate} />
              <ModeSection mode="real"  label="Real"   data={data} onUpdate={onUpdate} />
            </div>
          </div>


          {/* Streaming Settings */}
          <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border/30 bg-muted/10 flex items-center gap-2">
              <Radio className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Streaming &amp; Connectivity</h2>
            </div>
            <div className="px-4 py-3 space-y-2.5">
              {[
                ["deriv_app_id", "Deriv App ID"],
                ["deriv_api_token_paper", "API Token — Paper"],
                ["deriv_api_token_demo", "API Token — Demo"],
                ["deriv_api_token_real", "API Token — Real"],
              ].map(([key, label]) => data[key] !== undefined && (
                <div key={key} className="flex items-center justify-between gap-4 py-0.5">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span className="text-xs font-mono text-foreground/60">{data[key]?.length > 8 ? `${data[key].slice(0, 4)}…${data[key].slice(-4)}` : data[key] ? "***" : "not set"}</span>
                </div>
              ))}
              {!["deriv_api_token_paper","deriv_api_token_demo","deriv_api_token_real"].some(k => data[k]) && (
                <p className="text-xs text-muted-foreground/60">
                  API tokens are configured via environment variables. Use the setup wizard to configure tokens.
                </p>
              )}
            </div>
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
