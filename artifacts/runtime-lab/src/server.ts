import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dataAudit, DEFAULT_SYMBOLS, normalizeRequest } from "./data.js";
import { generateRule, runControlComparison, runFingerprints, runWalkForward } from "./lab.js";
import type { LabRequest, LabRun } from "./types.js";

const runs = new Map<string, LabRun>();
const port = Number(process.env.PORT ?? 4177);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, { ok: true, service: "runtime-lab" });
    }
    if (request.method === "GET" && url.pathname === "/symbols") {
      return json(response, { symbols: DEFAULT_SYMBOLS });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return html(response, renderIndex());
    }
    if (request.method === "GET" && url.pathname.startsWith("/runs/")) {
      const id = url.pathname.split("/").filter(Boolean)[1];
      const run = id ? runs.get(id) : null;
      if (!run) return json(response, { error: "run_not_found" }, 404);
      return json(response, run);
    }
    if (request.method === "POST" && url.pathname.startsWith("/runs/")) {
      const kind = url.pathname.split("/").filter(Boolean)[1] ?? "";
      const body = await readJson(request);
      const run = await executeRun(kind, body);
      runs.set(run.id, run);
      return json(response, run);
    }
    return json(response, { error: "not_found" }, 404);
  } catch (error) {
    return json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, () => {
  console.log(`[RuntimeLab] listening on ${port}`);
});

async function executeRun(kind: string, request: LabRequest): Promise<LabRun> {
  const normalized = normalizeRequest(request);
  const id = `${kind}-${Date.now()}`;
  try {
    const result = await runByKind(kind, normalized);
    return {
      id,
      kind,
      createdAt: new Date().toISOString(),
      request: normalized,
      status: "completed",
      result,
    };
  } catch (error) {
    return {
      id,
      kind,
      createdAt: new Date().toISOString(),
      request: normalized,
      status: "failed",
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runByKind(kind: string, request: LabRequest): Promise<unknown> {
  switch (kind) {
    case "data-audit":
      return dataAudit(request);
    case "fingerprints":
      return runFingerprints(request);
    case "control-comparison":
      return runControlComparison(request);
    case "generate-rules":
      return generateRule(request);
    case "walk-forward":
      return runWalkForward(request);
    default:
      throw new Error(`unknown_run_kind:${kind}`);
  }
}

async function readJson(request: IncomingMessage): Promise<LabRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as LabRequest;
}

function json(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function html(response: ServerResponse, payload: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function renderIndex(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Runtime Lab</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080d1f; color: #e8eefc; }
    body { margin: 0; min-height: 100vh; background: #080d1f; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 24px; }
    h1 { margin: 0 0 6px; font-size: 32px; }
    p { color: #9db4d3; line-height: 1.5; }
    .badge { border: 1px solid #246bfe; color: #9ec5ff; padding: 6px 10px; border-radius: 999px; font-size: 13px; }
    .panel { border: 1px solid #22304c; background: #111a31; border-radius: 8px; padding: 18px; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    label { display: block; font-size: 12px; color: #8eacd3; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
    select, input, button { width: 100%; box-sizing: border-box; background: #080d1f; color: #e8eefc; border: 1px solid #26385c; border-radius: 8px; padding: 10px 12px; font: inherit; }
    button { cursor: pointer; background: #0d4f63; border-color: #1099c8; font-weight: 700; }
    button.secondary { background: #141f38; border-color: #33466e; }
    .actions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    pre { white-space: pre-wrap; overflow: auto; max-height: 620px; background: #050915; border: 1px solid #1c2944; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #22304c; vertical-align: top; }
    th { color: #9db4d3; font-size: 12px; text-transform: uppercase; }
    @media (max-width: 760px) {
      main { padding: 18px; }
      header, .grid, .actions { grid-template-columns: 1fr; display: grid; }
      h1 { font-size: 26px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Runtime Lab</h1>
        <p>Strict no-lookahead research harness. Detected moves are labels only; walk-forward runs decide from current candle data.</p>
      </div>
      <div class="badge">Lab only - no allocator, no promotion, no live trading</div>
    </header>
    <section class="panel">
      <div class="grid">
        <div><label for="serviceId">Service</label><select id="serviceId"><option>R_75</option><option>CRASH300</option><option>BOOM300</option><option>R_100</option></select></div>
        <div><label for="family">Family</label><select id="family"><option value="all">all</option><option>breakout</option><option>reversal</option><option>continuation</option><option>crash_expansion</option><option>boom_expansion</option></select></div>
        <div><label for="direction">Direction</label><select id="direction"><option value="all">all</option><option value="buy">buy</option><option value="sell">sell</option></select></div>
        <div><label for="targetPct">Target %</label><input id="targetPct" type="number" value="5" min="1" step="0.5" /></div>
      </div>
      <div class="actions">
        <button data-run="data-audit">Data Audit</button>
        <button data-run="fingerprints">Fingerprints</button>
        <button data-run="control-comparison">Controls</button>
        <button data-run="generate-rules">Generate Rule</button>
        <button data-run="walk-forward">Walk-Forward</button>
      </div>
    </section>
    <section class="panel">
      <h2>Latest Result</h2>
      <div id="summary"></div>
      <pre id="output">No run yet.</pre>
    </section>
  </main>
  <script>
    const output = document.getElementById("output");
    const summary = document.getElementById("summary");
    const controls = {
      serviceId: document.getElementById("serviceId"),
      family: document.getElementById("family"),
      direction: document.getElementById("direction"),
      targetPct: document.getElementById("targetPct")
    };
    function payload() {
      return {
        serviceId: controls.serviceId.value,
        family: controls.family.value,
        direction: controls.direction.value,
        targetPct: Number(controls.targetPct.value)
      };
    }
    async function run(kind) {
      output.textContent = "Running " + kind + "...";
      summary.innerHTML = "";
      const res = await fetch("/runs/" + kind, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload())
      });
      const json = await res.json();
      renderSummary(json);
      output.textContent = JSON.stringify(json, null, 2);
    }
    function renderSummary(run) {
      const result = run.result || {};
      const wf = result.summary;
      if (!wf) {
        summary.innerHTML = "<p>Status: " + run.status + " | Run: " + run.kind + "</p>";
        return;
      }
      summary.innerHTML = \`
        <table>
          <tr><th>Trades</th><th>Win Rate</th><th>Profit Factor</th><th>Avg PnL</th><th>Max DD</th><th>False Positives</th></tr>
          <tr>
            <td>\${wf.trades}</td>
            <td>\${(wf.winRate * 100).toFixed(2)}%</td>
            <td>\${wf.profitFactor == null ? "inf/no losses" : wf.profitFactor.toFixed(2)}</td>
            <td>\${wf.averagePnlPct.toFixed(2)}%</td>
            <td>\${wf.maxDrawdownPct.toFixed(2)}%</td>
            <td>\${wf.falsePositiveTrades}</td>
          </tr>
        </table>\`;
    }
    document.querySelectorAll("button[data-run]").forEach((button) => {
      button.addEventListener("click", () => run(button.dataset.run));
    });
  </script>
</body>
</html>`;
}
