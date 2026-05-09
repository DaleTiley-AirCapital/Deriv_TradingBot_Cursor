import React, { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import {
  Activity,
  BarChart2,
  Bot,
  Zap,
  History,
  Database,
  Settings,
  TrendingUp,
  MoreHorizontal,
  X,
  Play,
  Square,
  Power,
  HelpCircle,
} from "lucide-react";
import {
  useGetOverview,
  useGetAccountInfo,
  useToggleTradingMode,
  useStopTrading,
  getGetOpenTradesQueryKey,
  getGetTradeHistoryQueryKey,
  getGetLivePositionsQueryKey,
  getGetOverviewQueryKey,
  getGetDataStatusQueryKey,
  getGetAccountInfoQueryKey,
} from "@workspace/api-client-react";
import type { ToggleTradingModeRequestMode } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AiChat } from "./AiChat";

const NAV_ITEMS = [
  { name: "Overview",         href: "/",          icon: Activity  },
  { name: "Allocator Decisions", href: "/decisions", icon: Zap       },
  { name: "Trades",           href: "/trades",    icon: History   },
  { name: "Research",         href: "/research",  icon: BarChart2 },
  { name: "Data",             href: "/data",      icon: Database  },
  { name: "Settings",         href: "/settings",  icon: Settings  },
  { name: "Help",             href: "/help",      icon: HelpCircle},
];

const MOBILE_PRIMARY = NAV_ITEMS.slice(0, 4);
const MOBILE_MORE    = NAV_ITEMS.slice(4);

type Breakpoint = "mobile" | "tablet" | "desktop";

function useBreakpoint(): Breakpoint {
  const get = (): Breakpoint => {
    if (typeof window === "undefined") return "desktop";
    if (window.innerWidth < 768)  return "mobile";
    if (window.innerWidth < 1024) return "tablet";
    return "desktop";
  };
  const [bp, setBp] = useState<Breakpoint>(get);
  useEffect(() => {
    const handler = () => setBp(get());
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return bp;
}

function useModeInfo() {
  const { data: overviewData } = useGetOverview({
    query: { queryKey: getGetOverviewQueryKey(), refetchInterval: 5000, retry: false },
  });
  const mode = overviewData?.mode || "idle";
  const isLive      = mode === "live";
  const isDemo      = mode === "demo";
  const isPaper     = mode === "paper";
  const isCollect   = mode === "collecting";
  const isScanning  = Boolean(overviewData?.scannerRunning);
  const isActive    = isLive || isDemo || isPaper || isScanning || isCollect;

  const modeColor   = isLive ? "text-destructive" : isDemo ? "text-primary" : isPaper ? "text-warning" : isScanning ? "text-green-400" : isCollect ? "text-primary" : "text-muted-foreground";
  const modeDot     = isLive ? "bg-destructive"   : isDemo ? "bg-primary"   : isPaper ? "bg-warning"   : isScanning ? "bg-green-400" : isCollect ? "bg-primary"   : "bg-muted-foreground/50";
  const logoAccent  = isLive ? "bg-destructive/20 text-destructive" : isDemo ? "bg-primary/20 text-primary" : isPaper ? "bg-warning/20 text-warning" : isScanning ? "bg-green-400/20 text-green-400" : "bg-primary/20 text-primary";
  const sidebarBorder = isLive ? "border-destructive/30" : isDemo ? "border-primary/30" : isPaper ? "border-warning/30" : isScanning ? "border-green-400/30" : "border-border";

  return { mode, isLive, isDemo, isPaper, isScanning, isActive, modeColor, modeDot, logoAccent, sidebarBorder };
}

function useTradingControls() {
  const queryClient = useQueryClient();
  const { data: overview } = useGetOverview({ query: { queryKey: getGetOverviewQueryKey(), refetchInterval: 5000 } });
  const { data: accountInfo } = useGetAccountInfo({ query: { queryKey: getGetAccountInfoQueryKey(), refetchInterval: 30000 } });

  const invalidator = {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetOpenTradesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTradeHistoryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLivePositionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDataStatusQueryKey() });
    }
  };

  const { mutate: toggleMode, isPending: toggling } = useToggleTradingMode({ mutation: invalidator });
  const { mutate: stopTrades, isPending: stopping } = useStopTrading({ mutation: invalidator });

  const paperActive = overview?.paperModeActive ?? false;
  const demoActive = overview?.demoModeActive ?? false;
  const realActive = overview?.realModeActive ?? false;
  const isTrading = paperActive || demoActive || realActive;

  const demoAccount = (accountInfo as any)?.demo;
  const realAccount = (accountInfo as any)?.real;

  const demoBalance = demoAccount?.connected && demoAccount.balance != null
    ? `${demoAccount.currency || "USD"} ${demoAccount.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  const demoLoginId = demoAccount?.loginid || null;

  const realBalanceStr = realAccount?.connected && realAccount.balance != null
    ? `${realAccount.currency || "USD"} ${realAccount.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  const realLoginId = realAccount?.loginid || null;

  const realBalance = accountInfo?.connected && accountInfo.balance != null
    ? `${accountInfo.currency || "USD"} ${accountInfo.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  return { paperActive, demoActive, realActive, isTrading, toggling, stopping, toggleMode, stopTrades, realBalance, demoBalance, demoLoginId, realBalanceStr, realLoginId };
}

type TradingControls = ReturnType<typeof useTradingControls>;

function ModeToggleButtons({ compact = false, controls }: { compact?: boolean; controls: TradingControls }) {
  const { paperActive, demoActive, realActive, isTrading, toggling, stopping, toggleMode, stopTrades } = controls;

  const modes = [
    { mode: "paper" as const, label: "P", fullLabel: "Paper", active: paperActive, color: "warning" },
    { mode: "demo" as const, label: "D", fullLabel: "Demo", active: demoActive, color: "primary" },
    { mode: "real" as const, label: "R", fullLabel: "Real", active: realActive, color: "destructive" },
  ] as const;

  return (
    <div className={cn("flex items-center flex-wrap", compact ? "gap-1" : "gap-1.5")}>
      {modes.map(({ mode, label, fullLabel, active, color }) => (
        <button
          key={mode}
          onClick={() => toggleMode({ data: { mode: mode as ToggleTradingModeRequestMode, active: !active, ...(mode === "real" && !active ? { confirmed: true } : {}) } })}
          disabled={toggling}
          title={fullLabel}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all border whitespace-nowrap",
            compact ? "px-1.5 py-0.5" : "px-2 py-1",
            active
              ? "border-current opacity-100"
              : "border-transparent opacity-60 hover:opacity-100",
          )}
          style={active ? {
            backgroundColor: `hsl(var(--${color}) / 0.15)`,
            borderColor: `hsl(var(--${color}) / 0.4)`,
            color: `hsl(var(--${color}))`,
          } : undefined}
        >
          {active ? <Square className="w-2.5 h-2.5" fill="currentColor" /> : <Play className="w-2.5 h-2.5" />}
          <span className="hidden sm:inline">{fullLabel}</span>
          <span className="sm:hidden">{label}</span>
        </button>
      ))}
      <button
        onClick={() => isTrading ? stopTrades() : undefined}
        disabled={stopping || !isTrading}
        title="Stop all trading"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md font-bold uppercase tracking-wider transition-all border whitespace-nowrap",
          compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]",
          isTrading
            ? "bg-destructive/15 border-destructive/40 text-destructive hover:bg-destructive/25"
            : "bg-muted/30 border-border/50 text-muted-foreground",
        )}
      >
        <Power className="w-2.5 h-2.5" />
        <span className="hidden sm:inline">Idle</span>
      </button>
    </div>
  );
}

function BalanceDisplay({ controls }: { controls: TradingControls }) {
  const { demoBalance, demoLoginId, realBalanceStr, realLoginId } = controls;
  return (
    <div className="pt-1 space-y-2">
      <div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <p className="text-[9px] text-muted-foreground uppercase tracking-widest">Demo{demoLoginId ? ` · ${demoLoginId}` : ""}</p>
        </div>
        <p className="text-sm font-bold text-foreground font-mono mt-0.5 pl-3">{demoBalance || "—"}</p>
      </div>
      <div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
          <p className="text-[9px] text-muted-foreground uppercase tracking-widest">Real{realLoginId ? ` · ${realLoginId}` : ""}</p>
        </div>
        <p className="text-sm font-bold text-foreground font-mono mt-0.5 pl-3">{realBalanceStr || "—"}</p>
      </div>
    </div>
  );
}

/* ─── Desktop: full labeled sidebar ─────────────────────────────────────── */
function DesktopLayout({ children, location, tradingControls }: { children: React.ReactNode; location: string; tradingControls: TradingControls }) {
  const { mode, isLive, isPaper, isActive, modeColor, modeDot, logoAccent, sidebarBorder } = useModeInfo();
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <aside
        className={cn("w-60 border-r flex flex-col z-20 relative", sidebarBorder)}
        style={{
          background: "linear-gradient(180deg, hsl(228 45% 11%) 0%, hsl(228 42% 9%) 100%)",
          boxShadow: "2px 0 20px rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.04)",
        }}
      >
        <div className="h-14 flex items-center px-5 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center", logoAccent)}>
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <h1 className="font-semibold text-sm text-foreground leading-none">Deriv Trading</h1>
              <p className="text-[10px] text-muted-foreground mt-0.5">Long Hold</p>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-border/40 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">System</span>
            <div className={cn("flex items-center gap-1.5 text-[11px] font-semibold", modeColor)}>
              <span className="relative flex h-1.5 w-1.5">
                {isActive && <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", modeDot)} />}
                <span className={cn("relative inline-flex rounded-full h-1.5 w-1.5", modeDot)} />
              </span>
              {mode.toUpperCase()}
            </div>
          </div>
          <ModeToggleButtons compact controls={tradingControls} />
          <BalanceDisplay controls={tradingControls} />
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const isActiveLink = location === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group relative",
                  isActiveLink ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {isActiveLink && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />}
                <item.icon className={cn("w-4 h-4 flex-shrink-0 transition-colors", isActiveLink ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => setChatOpen((value) => !value)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 group relative",
              chatOpen ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {chatOpen && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />}
            <Bot className={cn("w-4 h-4 flex-shrink-0", chatOpen ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
            <span>Chat</span>
          </button>
        </div>

        <div className="px-4 py-3 border-t border-border/40">
          <p className="text-[10px] text-muted-foreground/50 font-mono">v{APP_VERSION}</p>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-background">
        <TradingBanner isLive={isLive} isPaper={isPaper} />
        <div className="flex-1 overflow-y-auto p-6 md:p-8 relative bg-background">{children}</div>
      </main>
      <AiChat
        open={chatOpen}
        onOpenChange={setChatOpen}
        hideTrigger
        panelClassName="left-[252px] right-auto bottom-6 md:bottom-6"
      />
    </div>
  );
}


/* ─── Tablet: icon rail + top bar ───────────────────────────────────────── */
function TabletLayout({ children, location, tradingControls }: { children: React.ReactNode; location: string; tradingControls: TradingControls }) {
  const [chatOpen, setChatOpen] = useState(false);
  const { isLive, isPaper, isScanning, isActive, modeColor, modeDot, logoAccent, sidebarBorder } = useModeInfo();

  const modeLabel  = isLive ? "LIVE" : isPaper ? "PAPER" : isScanning ? "SCANNING" : isActive ? "ON" : "IDLE";
  const modeBadge  = isLive
    ? "bg-destructive/15 border-destructive/30 text-destructive"
    : isPaper
    ? "bg-warning/15 border-warning/30 text-warning"
    : isScanning
    ? "bg-green-400/15 border-green-400/30 text-green-400"
    : isActive
    ? "bg-primary/15 border-primary/30 text-primary"
    : "bg-muted/20 border-border text-muted-foreground";
  const modeDotColor = isLive ? "bg-destructive" : isPaper ? "bg-warning" : isScanning ? "bg-green-400" : isActive ? "bg-primary" : "bg-muted-foreground/50";

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden flex-col">

      {/* Top bar */}
      <header
        className={cn("flex items-center border-b shrink-0 z-20", sidebarBorder)}
        style={{
          height: 50,
          background: "linear-gradient(180deg, hsl(228 45% 11%) 0%, hsl(228 42% 9%) 100%)",
        }}
      >
        {/* Logo cell — same width as rail so they visually align */}
        <div className="flex items-center justify-center border-r border-border/50 shrink-0" style={{ width: 68, height: "100%" }}>
          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center", logoAccent)}>
            <TrendingUp className="w-4 h-4" />
          </div>
        </div>

        {/* App name */}
        <div className="px-4 flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-none">Deriv Trading</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Long Hold</p>
        </div>

        <div className="flex items-center gap-2 mr-3 shrink-0">
          <ModeToggleButtons compact controls={tradingControls} />
          <button
            type="button"
            onClick={() => setChatOpen((value) => !value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors",
              chatOpen ? "border-primary/40 bg-primary/15 text-primary" : "border-border/50 text-muted-foreground hover:text-foreground",
            )}
          >
            <Bot className="w-3.5 h-3.5" />
            Chat
          </button>
        </div>

        <div className="border-l border-border/50 px-4 py-2 text-right shrink-0">
          <p className="text-[9px] text-muted-foreground uppercase tracking-widest">Real Balance</p>
          <p className="text-sm font-bold text-foreground font-mono mt-0.5">{tradingControls.realBalance || "—"}</p>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Icon rail */}
        <aside
          className={cn("border-r flex flex-col shrink-0 pt-2 overflow-y-auto", sidebarBorder)}
          style={{
            width: 68,
            background: "linear-gradient(180deg, hsl(228 45% 11%) 0%, hsl(228 42% 9%) 100%)",
          }}
        >
          {NAV_ITEMS.map((item) => {
            const isActiveLink = location === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                title={item.name}
                className={cn(
                  "flex flex-col items-center gap-1 py-3 w-full relative transition-all duration-150",
                  isActiveLink
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                style={{
                  background: isActiveLink ? "hsl(var(--primary) / 0.1)" : "transparent",
                  borderLeft: isActiveLink ? "3px solid hsl(var(--primary))" : "3px solid transparent",
                }}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="text-[9px] font-medium leading-none">{item.name}</span>
              </Link>
            );
          })}
        </aside>

        {/* Page content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
          <TradingBanner isLive={isLive} isPaper={isPaper} />
          <div className="flex-1 overflow-y-auto p-5 relative bg-background">{children}</div>
        </main>
      </div>
      <AiChat
        open={chatOpen}
        onOpenChange={setChatOpen}
        hideTrigger
        panelClassName="left-[84px] right-auto bottom-6 md:bottom-6"
      />
    </div>
  );
}


/* ─── Mobile: header + bottom tabs ──────────────────────────────────────── */
function MobileLayout({ children, location, tradingControls }: { children: React.ReactNode; location: string; tradingControls: TradingControls }) {
  const [showMore, setShowMore] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const { isLive, isPaper, isScanning, isActive, logoAccent, sidebarBorder, modeDot } = useModeInfo();

  const modeLabel = isLive ? "LIVE" : isPaper ? "PAPER" : isScanning ? "SCANNING" : isActive ? "ON" : "IDLE";
  const modeBadge = isLive
    ? "bg-destructive/15 border-destructive/30 text-destructive"
    : isPaper
    ? "bg-warning/15 border-warning/30 text-warning"
    : isScanning
    ? "bg-green-400/15 border-green-400/30 text-green-400"
    : isActive
    ? "bg-primary/15 border-primary/30 text-primary"
    : "bg-muted/20 border-border text-muted-foreground";

  const isMoreActive = MOBILE_MORE.some((m) => m.href === location);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden">

      {/* Mobile top bar */}
      <header
        className={cn("flex items-center justify-between px-4 shrink-0 border-b", sidebarBorder)}
        style={{
          height: 52,
          background: "linear-gradient(180deg, hsl(228 45% 11%) 0%, hsl(228 42% 9%) 100%)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", logoAccent)}>
            <TrendingUp className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground leading-none truncate">Deriv Trading</p>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Long Hold</p>
          </div>
        </div>
        <ModeToggleButtons compact controls={tradingControls} />
      </header>

      {/* Page content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-background">
        <TradingBanner isLive={isLive} isPaper={isPaper} />
        <div className="flex-1 overflow-y-auto p-4 relative bg-background">{children}</div>
      </main>

      {/* More drawer */}
      {showMore && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShowMore(false)} />
          <div
            className="fixed left-0 right-0 z-40 rounded-t-2xl border-t border-border"
            style={{
              bottom: 60,
              background: "hsl(220 18% 14%)",
              boxShadow: "0 -8px 32px rgba(0,0,0,0.6)",
            }}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">More</p>
              <button onClick={() => setShowMore(false)} className="text-muted-foreground p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            {MOBILE_MORE.map((item) => {
              const isActiveLink = location === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setShowMore(false)}
                  className={cn(
                    "flex items-center gap-4 w-full px-5 py-3.5 text-left transition-colors",
                    isActiveLink ? "text-primary bg-primary/8" : "text-foreground hover:bg-muted/30",
                  )}
                >
                  <item.icon className={cn("w-5 h-5", isActiveLink ? "text-primary" : "text-muted-foreground")} />
                  <span className="text-[15px] font-medium">{item.name}</span>
                  {isActiveLink && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setChatOpen(true);
                setShowMore(false);
              }}
              className="flex items-center gap-4 w-full px-5 py-3.5 text-left text-foreground hover:bg-muted/30"
            >
              <Bot className="w-5 h-5 text-muted-foreground" />
              <span className="text-[15px] font-medium">Chat</span>
            </button>
            <div className="h-4" />
          </div>
        </>
      )}

      {/* Bottom tab bar */}
      <nav
        className={cn("flex items-center shrink-0 border-t z-20", sidebarBorder)}
        style={{ height: 60, background: "hsl(220 18% 14%)", paddingBottom: 2 }}
      >
        {MOBILE_PRIMARY.map((tab) => {
          const isActiveLink = location === tab.href;
          return (
            <Link
              key={tab.name}
              href={tab.href}
              onClick={() => setShowMore(false)}
              className="flex-1 flex flex-col items-center gap-1 py-2 relative"
            >
              <tab.icon className={cn("w-5 h-5", isActiveLink ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("text-[9.5px] font-medium", isActiveLink ? "text-primary" : "text-muted-foreground")}>
                {tab.name}
              </span>
              {isActiveLink && <span className="absolute bottom-0 w-5 h-0.5 bg-primary rounded-t-full" />}
            </Link>
          );
        })}

        {/* More button */}
        <button
          onClick={() => setShowMore((s) => !s)}
          className="flex-1 flex flex-col items-center gap-1 py-2 relative"
        >
          <MoreHorizontal className={cn("w-5 h-5", (isMoreActive || showMore) ? "text-primary" : "text-muted-foreground")} />
          <span className={cn("text-[9.5px] font-medium", (isMoreActive || showMore) ? "text-primary" : "text-muted-foreground")}>
            More
          </span>
        </button>
      </nav>
      <AiChat
        open={chatOpen}
        onOpenChange={setChatOpen}
        hideTrigger
        panelClassName="right-3 left-3 w-auto bottom-[72px] md:bottom-24"
      />
    </div>
  );
}

/* ─── Shared trading banner ──────────────────────────────────────────────── */
function TradingBanner({ isLive, isPaper }: { isLive: boolean; isPaper: boolean }) {
  if (!isLive && !isPaper) return null;
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 py-2 text-xs font-bold uppercase tracking-widest z-10 shrink-0",
        isLive ? "bg-destructive/10 text-destructive border-b border-destructive/20" : "bg-warning/10 text-warning border-b border-warning/20",
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", isLive ? "bg-destructive" : "bg-warning")} />
        <span className={cn("relative inline-flex rounded-full h-1.5 w-1.5", isLive ? "bg-destructive" : "bg-warning")} />
      </span>
      {isLive ? "LIVE TRADING — REAL MONEY AT RISK" : "PAPER TRADING — SIMULATED POSITIONS"}
    </div>
  );
}

/* ─── Root layout — picks the right layout per screen size ──────────────── */
export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const bp = useBreakpoint();
  const tradingControls = useTradingControls();

  const layout = bp === "mobile"
    ? <MobileLayout location={location} tradingControls={tradingControls}>{children}</MobileLayout>
    : bp === "tablet"
      ? <TabletLayout location={location} tradingControls={tradingControls}>{children}</TabletLayout>
      : <DesktopLayout location={location} tradingControls={tradingControls}>{children}</DesktopLayout>;

  return layout;
}
