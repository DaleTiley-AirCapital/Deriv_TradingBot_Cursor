import { useState, lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import SetupWizard from "@/pages/setup";

// V3 primary pages — fresh ownership
import Overview from "@/pages/overview";
import Decisions from "@/pages/decisions";
import Trades from "@/pages/trades";
import Research from "@/pages/research";
import DataManager from "@/pages/data";
import Settings from "@/pages/settings";
import Help from "@/pages/help";
import Diagnostics from "@/pages/diagnostics";

// Legacy V2 pages — retired from primary ownership, accessible under /legacy/* only
const LegacyOverview = lazy(() => import("@/pages/legacy/overview"));
const LegacySignals = lazy(() => import("@/pages/legacy/signals"));
const LegacyTrades = lazy(() => import("@/pages/legacy/trades"));
const LegacyResearch = lazy(() => import("@/pages/legacy/research"));
const LegacySettings = lazy(() => import("@/pages/legacy/settings"));
const LegacyV3Backend = lazy(() => import("@/pages/legacy/v3-backend"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    }
  }
});

const BASE = import.meta.env.BASE_URL || "/";

function SetupGate({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["/api/setup/status"],
    queryFn: async () => {
      const res = await fetch(`${BASE}api/setup/status`);
      if (!res.ok) throw new Error("Failed to check setup status");
      return res.json();
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Unable to connect to server</p>
          <button onClick={() => refetch()} className="text-primary underline text-sm">Retry</button>
        </div>
      </div>
    );
  }

  if (!dismissed && data && !data.initialSetupComplete) {
    return (
      <SetupWizard onComplete={() => {
        setDismissed(true);
        queryClient.invalidateQueries({ queryKey: ["/api/setup/status"] });
      }} />
    );
  }

  return <>{children}</>;
}

function LegacyFallback() {
  return (
    <div className="p-6 flex items-center justify-center min-h-48">
      <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

function Router() {
  return (
    <AppLayout>
      <Switch>
        {/* ─── V3 Primary Routes ──────────────────────────────── */}
        <Route path="/" component={Overview} />
        <Route path="/decisions" component={Decisions} />
        <Route path="/trades" component={Trades} />
        <Route path="/research" component={Research} />
        <Route path="/data" component={DataManager} />
        <Route path="/settings" component={Settings} />
        <Route path="/help" component={Help} />
        <Route path="/diagnostics" component={Diagnostics} />

        {/* ─── Legacy V2 Routes — dev/reference only ───────────── */}
        <Route path="/legacy/overview">
          {() => <Suspense fallback={<LegacyFallback />}><LegacyOverview /></Suspense>}
        </Route>
        <Route path="/legacy/signals">
          {() => <Suspense fallback={<LegacyFallback />}><LegacySignals /></Suspense>}
        </Route>
        <Route path="/legacy/trades">
          {() => <Suspense fallback={<LegacyFallback />}><LegacyTrades /></Suspense>}
        </Route>
        <Route path="/legacy/research">
          {() => <Suspense fallback={<LegacyFallback />}><LegacyResearch /></Suspense>}
        </Route>
        <Route path="/legacy/settings">
          {() => <Suspense fallback={<LegacyFallback />}><LegacySettings /></Suspense>}
        </Route>
        <Route path="/legacy/v3-backend">
          {() => <Suspense fallback={<LegacyFallback />}><LegacyV3Backend /></Suspense>}
        </Route>

        {/* ─── Compat shims — redirect old URLs to V3 ──────────── */}
        <Route path="/signals" component={Decisions} />
        <Route path="/v3-backend" component={Diagnostics} />

        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <SetupGate>
            <Router />
          </SetupGate>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
