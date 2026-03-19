import React from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { 
  Activity, 
  BarChart2, 
  Radio, 
  History, 
  ShieldAlert, 
  Database,
  Settings,
  TrendingUp
} from "lucide-react";
import { useGetDataStatus } from "@workspace/api-client-react";

const NAV_ITEMS = [
  { name: "Overview", href: "/", icon: Activity },
  { name: "Research", href: "/research", icon: BarChart2 },
  { name: "Signals", href: "/signals", icon: Radio },
  { name: "Trades", href: "/trades", icon: History },
  { name: "Risk", href: "/risk", icon: ShieldAlert },
  { name: "Data", href: "/data", icon: Database },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  
  const { data: statusData } = useGetDataStatus({
    query: { refetchInterval: 5000, retry: false }
  });

  const mode = statusData?.mode || "idle";

  const isLive = mode === "live";
  const isPaper = mode === "paper";
  const isActive = isLive || isPaper || mode === "collecting";

  const modeColor = isLive
    ? "text-destructive"
    : isPaper
    ? "text-warning"
    : mode === "collecting"
    ? "text-primary"
    : "text-muted-foreground";

  const modeDot = isLive
    ? "bg-destructive"
    : isPaper
    ? "bg-warning"
    : mode === "collecting"
    ? "bg-primary"
    : "bg-muted-foreground/50";

  const sidebarBorder = isLive
    ? "border-destructive/30"
    : isPaper
    ? "border-warning/30"
    : "border-border";

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <aside className={cn(
        "w-60 border-r flex flex-col z-20 relative",
        sidebarBorder
      )}
        style={{
          background: "linear-gradient(180deg, hsl(228 45% 11%) 0%, hsl(228 42% 9%) 100%)",
          boxShadow: "2px 0 20px rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.04)"
        }}
      >
        <div className="h-14 flex items-center px-5 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div className={cn(
              "w-7 h-7 rounded-lg flex items-center justify-center",
              isLive ? "bg-destructive/20" : isPaper ? "bg-warning/20" : "bg-primary/20"
            )}>
              <TrendingUp className={cn(
                "w-4 h-4",
                isLive ? "text-destructive" : isPaper ? "text-warning" : "text-primary"
              )} />
            </div>
            <div>
              <h1 className="font-semibold text-sm text-foreground leading-none">Deriv Quant</h1>
              <p className="text-[10px] text-muted-foreground mt-0.5">Research Platform</p>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-border/40">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">System</span>
            <div className={cn("flex items-center gap-1.5 text-[11px] font-semibold", modeColor)}>
              <span className="relative flex h-1.5 w-1.5">
                {isActive && (
                  <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", modeDot)}></span>
                )}
                <span className={cn("relative inline-flex rounded-full h-1.5 w-1.5", modeDot)}></span>
              </span>
              {mode.toUpperCase()}
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const isActiveLink = location === item.href;
            return (
              <Link key={item.name} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group relative",
                isActiveLink 
                  ? "bg-primary/12 text-primary" 
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}>
                {isActiveLink && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />
                )}
                <item.icon className={cn(
                  "w-4 h-4 flex-shrink-0 transition-colors",
                  isActiveLink ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-border/40">
          <p className="text-[10px] text-muted-foreground/40 text-center font-mono">v0.1.0</p>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {(isLive || isPaper) && (
          <div className={cn(
            "flex items-center justify-center gap-2 py-2 text-xs font-bold uppercase tracking-widest z-20 relative",
            isLive 
              ? "bg-destructive/10 text-destructive border-b border-destructive/20" 
              : "bg-warning/10 text-warning border-b border-warning/20"
          )}>
            <span className="relative flex h-1.5 w-1.5">
              <span className={cn(
                "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                isLive ? "bg-destructive" : "bg-warning"
              )}></span>
              <span className={cn(
                "relative inline-flex rounded-full h-1.5 w-1.5",
                isLive ? "bg-destructive" : "bg-warning"
              )}></span>
            </span>
            {isLive ? "LIVE TRADING — REAL MONEY AT RISK" : "PAPER TRADING — SIMULATED POSITIONS"}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 md:p-8 relative">
          {children}
        </div>
      </main>
    </div>
  );
}
