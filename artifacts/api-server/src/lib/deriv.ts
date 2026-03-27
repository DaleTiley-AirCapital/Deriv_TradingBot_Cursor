import WebSocket from "ws";
import { db, ticksTable, candlesTable, spikeEventsTable, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createDecipheriv, scryptSync } from "crypto";
import { recordTick, validateActiveSymbols, isSymbolValid, markSymbolError, markSymbolSubscribed, startWatchdog, getAllSymbolStatuses, getApiSymbol } from "./symbolValidator.js";

const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

export const V1_DEFAULT_SYMBOLS = [
  "BOOM1000", "CRASH1000", "BOOM900", "CRASH900",
  "BOOM600", "CRASH600", "BOOM500", "CRASH500",
  "BOOM300", "CRASH300",
  "R_75", "R_100",
];

export type TradingMode = "paper" | "demo" | "real";

export interface BackfillSymbolProgress {
  symbol: string;
  phase: string;
  pct: number;
  candles: number;
  ticks: number;
  oldestDate?: string;
}

const TIMEFRAMES: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

interface DerivTick {
  epoch: number;
  quote: number;
  symbol: string;
}

interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DerivTickHistory {
  prices: number[];
  times: number[];
}

interface BuyContractResponse {
  buy: {
    contract_id: number;
    transaction_id: number;
    buy_price: number;
    start_time: number;
    longcode: string;
  };
  error?: { message: string; code: string };
}

interface SellContractResponse {
  sell: {
    transaction_id: number;
    sold_for: number;
    balance_after: number;
  };
  error?: { message: string; code: string };
}

interface AccountBalanceResponse {
  balance: {
    balance: number;
    currency: string;
    loginid: string;
  };
  error?: { message: string; code: string };
}

interface ProposalResponse {
  proposal: {
    id: string;
    ask_price: number;
    spot: number;
    spot_time: number;
  };
  error?: { message: string; code: string };
}

const symbolState: Record<string, {
  lastTickPrice: number | null;
  tickChanges: number[];
  ticksSinceLastSpike: number;
  openCandles: Record<string, { open: number; high: number; low: number; close: number; openTs: number; tickCount: number }>;
}> = {};

function getSymbolState(symbol: string) {
  if (!symbolState[symbol]) {
    symbolState[symbol] = {
      lastTickPrice: null,
      tickChanges: [],
      ticksSinceLastSpike: 0,
      openCandles: {},
    };
  }
  return symbolState[symbol];
}

async function detectAndStoreSpike(symbol: string, quote: number, epochTs: number) {
  const state = getSymbolState(symbol);

  if (state.lastTickPrice === null) {
    state.lastTickPrice = quote;
    return;
  }

  const change = Math.abs(quote - state.lastTickPrice);
  state.tickChanges.push(change);
  state.ticksSinceLastSpike++;

  if (state.tickChanges.length > 500) {
    state.tickChanges.shift();
  }

  if (state.tickChanges.length >= 50) {
    const mean = state.tickChanges.reduce((a, b) => a + b, 0) / state.tickChanges.length;
    const variance = state.tickChanges.reduce((a, b) => a + (b - mean) ** 2, 0) / state.tickChanges.length;
    const stdDev = Math.sqrt(variance);

    const zScore = stdDev > 0 ? (change - mean) / stdDev : 0;

    if (zScore > 4.0) {
      const direction = quote > state.lastTickPrice ? "up" : "down";
      const prevSpikeTicks = state.ticksSinceLastSpike;

      console.log(`[Deriv] SPIKE detected on ${symbol}: ${direction} by ${change.toFixed(4)} (z=${zScore.toFixed(2)}) after ${prevSpikeTicks} ticks`);

      await db.insert(spikeEventsTable).values({
        symbol,
        eventTs: epochTs,
        direction,
        spikeSize: change,
        ticksSincePreviousSpike: prevSpikeTicks,
      });

      state.ticksSinceLastSpike = 0;
    }
  }

  state.lastTickPrice = quote;
}

async function updateOpenCandles(symbol: string, quote: number, epochTs: number) {
  const state = getSymbolState(symbol);

  for (const [tf, seconds] of Object.entries(TIMEFRAMES)) {
    const candleOpenTs = Math.floor(epochTs / seconds) * seconds;
    const key = `${tf}:${candleOpenTs}`;
    const prevKey = Object.keys(state.openCandles).find(k => k.startsWith(`${tf}:`) && k !== key);

    if (!state.openCandles[key]) {
      if (prevKey && state.openCandles[prevKey]) {
        const prev = state.openCandles[prevKey];
        const prevOpenTs = parseInt(prevKey.split(":")[1]);
        try {
          await db.insert(candlesTable).values({
            symbol,
            timeframe: tf,
            openTs: prevOpenTs,
            closeTs: prevOpenTs + seconds,
            open: prev.open,
            high: prev.high,
            low: prev.low,
            close: prev.close,
            tickCount: prev.tickCount,
          }).onConflictDoNothing();
        } catch {
          // ignore duplicate
        }
        delete state.openCandles[prevKey];
      }

      state.openCandles[key] = {
        open: quote,
        high: quote,
        low: quote,
        close: quote,
        openTs: candleOpenTs,
        tickCount: 1,
      };
    } else {
      const c = state.openCandles[key];
      c.high = Math.max(c.high, quote);
      c.low = Math.min(c.low, quote);
      c.close = quote;
      c.tickCount++;
    }
  }
}

class DerivClient {
  private ws: WebSocket | null = null;
  private apiToken: string;
  authorized = false;
  private streaming = false;
  private subscribedSymbols: Set<string> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests: Map<string, (data: unknown) => void> = new Map();
  private reqId = 1;
  private latestQuotes: Map<string, number> = new Map();
  public apiToConfiguredMap: Map<string, string> = new Map();

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  private nextReqId(): number {
    return this.reqId++;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      console.log("[Deriv] Connecting to Deriv WebSocket API...");
      this.ws = new WebSocket(DERIV_WS_URL);

      this.ws.on("open", async () => {
        console.log("[Deriv] Connected. Authorizing...");
        try {
          await this.authorize();
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          this.handleMessage(data);
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on("error", (err) => {
        console.error("[Deriv] WebSocket error:", err.message);
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[Deriv] Connection closed (${code}: ${reason}). Reconnecting in 5s...`);
        this.authorized = false;
        this.ws = null;
        if (this.streaming) {
          this.reconnectTimer = setTimeout(() => this.reconnect(), 5000);
        }
      });
    });
  }

  private configuredToApiSymbol(configured: string): string {
    for (const [api, cfg] of this.apiToConfiguredMap.entries()) {
      if (cfg === configured) return api;
    }
    return configured;
  }

  private async reconnect() {
    try {
      await this.connect();
      for (const symbol of this.subscribedSymbols) {
        const apiSymbol = this.configuredToApiSymbol(symbol);
        await this.subscribeToTicks(apiSymbol);
      }
    } catch (err) {
      console.error("[Deriv] Reconnect failed:", err);
      this.reconnectTimer = setTimeout(() => this.reconnect(), 10000);
    }
  }

  private send(payload: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const reqId = this.nextReqId();
      const message = { ...payload, req_id: reqId };
      this.pendingRequests.set(String(reqId), resolve);

      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          this.pendingRequests.delete(String(reqId));
          reject(err);
        }
      });

      setTimeout(() => {
        if (this.pendingRequests.has(String(reqId))) {
          this.pendingRequests.delete(String(reqId));
          reject(new Error(`Request ${reqId} timed out`));
        }
      }, 30000);
    });
  }

  private handleMessage(data: Record<string, unknown>) {
    const reqId = data.req_id as string | undefined;

    if (reqId && this.pendingRequests.has(String(reqId))) {
      const resolve = this.pendingRequests.get(String(reqId))!;
      this.pendingRequests.delete(String(reqId));
      resolve(data);
    }

    if (data.msg_type === "tick" && data.tick) {
      const tick = data.tick as DerivTick;
      const configuredName = this.apiToConfiguredMap.get(tick.symbol) || tick.symbol;
      this.latestQuotes.set(configuredName, tick.quote);
      this.processTick(tick).catch(console.error);
    }
  }

  private async processTick(tick: DerivTick) {
    const apiSymbol = tick.symbol;
    const configuredSymbol = this.apiToConfiguredMap.get(apiSymbol) || apiSymbol;
    const { epoch, quote } = tick;

    recordTick(configuredSymbol, quote, epoch);

    await db.insert(ticksTable).values({
      symbol: configuredSymbol,
      epochTs: epoch,
      quote,
    }).onConflictDoNothing();

    await detectAndStoreSpike(configuredSymbol, quote, epoch);
    await updateOpenCandles(configuredSymbol, quote, epoch);
  }

  public authData: Record<string, unknown> | null = null;

  private async authorize(): Promise<void> {
    const response = await this.send({ authorize: this.apiToken }) as Record<string, unknown>;
    if (response.error) {
      const err = response.error as Record<string, unknown>;
      throw new Error(`Deriv auth failed: ${err.message}`);
    }
    this.authorized = true;
    this.authData = (response.authorize || null) as Record<string, unknown> | null;
    console.log("[Deriv] Authorized successfully.");
  }

  async subscribeToTicks(symbol: string): Promise<void> {
    if (!this.authorized) throw new Error("Not authorized");
    console.log(`[Deriv] Subscribing to ticks for ${symbol}...`);
    await this.send({ ticks: symbol, subscribe: 1 });
  }

  async getTickHistory(symbol: string, count = 5000): Promise<DerivTickHistory | null> {
    if (!this.authorized) throw new Error("Not authorized");
    console.log(`[Deriv] Fetching ${count} historical ticks for ${symbol}...`);
    const response = await this.send({
      ticks_history: symbol,
      count,
      end: "latest",
      style: "ticks",
    }) as Record<string, unknown>;

    if (response.error) {
      const err = response.error as Record<string, unknown>;
      console.error(`[Deriv] Tick history error for ${symbol}:`, err.message);
      return null;
    }

    return response.history as DerivTickHistory;
  }

  async getCandleHistoryWithEnd(symbol: string, granularity: number, count = 5000, endEpoch?: number, silent = false): Promise<DerivCandle[] | null> {
    if (!this.authorized) throw new Error("Not authorized");
    const tf = Object.entries(TIMEFRAMES).find(([, s]) => s === granularity)?.[0] || `${granularity}s`;
    if (!silent) {
      const endLabel = endEpoch ? new Date(endEpoch * 1000).toISOString().slice(0, 10) : "latest";
      console.log(`[Deriv] Fetching ${count} candles (${tf}) for ${symbol} ending ${endLabel}...`);
    }
    const response = await this.send({
      ticks_history: symbol,
      count,
      end: endEpoch ?? "latest",
      style: "candles",
      granularity,
    }) as Record<string, unknown>;

    if (response.error) {
      const err = response.error as Record<string, unknown>;
      console.error(`[Deriv] Candle history error for ${symbol}:`, err.message);
      return null;
    }

    return response.candles as DerivCandle[];
  }

  async getCandleHistory(symbol: string, granularity: number, count = 1000): Promise<DerivCandle[] | null> {
    if (!this.authorized) throw new Error("Not authorized");
    const tf = Object.entries(TIMEFRAMES).find(([, s]) => s === granularity)?.[0] || `${granularity}s`;
    console.log(`[Deriv] Fetching ${count} candles (${tf}) for ${symbol}...`);
    const response = await this.send({
      ticks_history: symbol,
      count,
      end: "latest",
      style: "candles",
      granularity,
    }) as Record<string, unknown>;

    if (response.error) {
      const err = response.error as Record<string, unknown>;
      console.error(`[Deriv] Candle history error for ${symbol}:`, err.message);
      return null;
    }

    return response.candles as DerivCandle[];
  }

  async getAccountBalance(): Promise<{ balance: number; currency: string } | null> {
    if (!this.authorized) throw new Error("Not authorized");
    const response = await this.send({ balance: 1 }) as AccountBalanceResponse;
    if (response.error) {
      console.error("[Deriv] Balance error:", response.error.message);
      return null;
    }
    return { balance: response.balance.balance, currency: response.balance.currency };
  }

  async getPortfolio(): Promise<{ contracts: Array<{ contract_id: number; buy_price: number; payout: number; symbol: string; contract_type: string; currency: string }> } | null> {
    if (!this.authorized) throw new Error("Not authorized");
    const response = await this.send({ portfolio: 1 }) as Record<string, unknown>;
    if ((response as Record<string, unknown>).error) {
      console.error("[Deriv] Portfolio error:", ((response as Record<string, unknown>).error as Record<string, string>).message);
      return null;
    }
    const portfolio = (response as Record<string, unknown>).portfolio as Record<string, unknown>;
    const contracts = (portfolio?.contracts || []) as Array<{ contract_id: number; buy_price: number; payout: number; symbol: string; contract_type: string; currency: string }>;
    return { contracts };
  }

  async getOpenContractPnl(): Promise<{ totalBuyPrice: number; totalPayout: number; unrealizedPnl: number }> {
    const portfolio = await this.getPortfolio();
    if (!portfolio || portfolio.contracts.length === 0) {
      return { totalBuyPrice: 0, totalPayout: 0, unrealizedPnl: 0 };
    }
    let totalBuyPrice = 0;
    let totalPayout = 0;
    for (const c of portfolio.contracts) {
      totalBuyPrice += c.buy_price;
      totalPayout += c.payout;
    }
    return { totalBuyPrice, totalPayout, unrealizedPnl: totalPayout - totalBuyPrice };
  }

  async getSpotPrice(symbol: string): Promise<number | null> {
    const cached = this.latestQuotes.get(symbol);
    if (cached) return cached;
    if (!this.authorized) throw new Error("Not authorized");
    const response = await this.send({
      proposal: 1,
      amount: 1,
      basis: "stake",
      contract_type: "CALL",
      currency: "USD",
      duration: 1,
      duration_unit: "m",
      symbol,
    }) as ProposalResponse;
    if (response.error) {
      console.error(`[Deriv] Spot price error for ${symbol}:`, response.error.message);
      return null;
    }
    const spot = response.proposal.spot;
    this.latestQuotes.set(symbol, spot);
    return spot;
  }

  async buyContract(params: {
    symbol: string;
    contractType: "CALL" | "PUT";
    amount: number;
    duration: number;
    durationUnit: string;
    limitOrder?: { stopLoss?: number; takeProfit?: number };
  }): Promise<{ contractId: number; buyPrice: number; entrySpot: number } | null> {
    if (!this.authorized) throw new Error("Not authorized");
    console.log(`[Deriv] Opening ${params.contractType} on ${params.symbol} for $${params.amount}`);

    const proposal: Record<string, unknown> = {
      proposal: 1,
      amount: params.amount,
      basis: "stake",
      contract_type: params.contractType,
      currency: "USD",
      duration: params.duration,
      duration_unit: params.durationUnit,
      symbol: params.symbol,
    };

    if (params.limitOrder?.stopLoss) {
      proposal.limit_order = proposal.limit_order || {};
      (proposal.limit_order as Record<string, unknown>).stop_loss = params.limitOrder.stopLoss;
    }
    if (params.limitOrder?.takeProfit) {
      proposal.limit_order = proposal.limit_order || {};
      (proposal.limit_order as Record<string, unknown>).take_profit = params.limitOrder.takeProfit;
    }

    const proposalResp = await this.send(proposal) as ProposalResponse;
    if (proposalResp.error) {
      console.error(`[Deriv] Proposal error:`, proposalResp.error.message);
      return null;
    }

    const buyResp = await this.send({
      buy: proposalResp.proposal.id,
      price: params.amount,
    }) as BuyContractResponse;

    if (buyResp.error) {
      console.error(`[Deriv] Buy error:`, buyResp.error.message);
      return null;
    }

    const entrySpot = proposalResp.proposal.spot;
    this.latestQuotes.set(params.symbol, entrySpot);

    return {
      contractId: buyResp.buy.contract_id,
      buyPrice: buyResp.buy.buy_price,
      entrySpot,
    };
  }

  async sellContract(contractId: number, price?: number): Promise<{ soldFor: number; balanceAfter: number } | null> {
    if (!this.authorized) throw new Error("Not authorized");
    console.log(`[Deriv] Closing contract ${contractId}`);

    const response = await this.send({
      sell: contractId,
      price: price ?? 0,
    }) as SellContractResponse;

    if (response.error) {
      console.error(`[Deriv] Sell error:`, response.error.message);
      return null;
    }

    return {
      soldFor: response.sell.sold_for,
      balanceAfter: response.sell.balance_after,
    };
  }

  async updateStopLoss(contractId: number, stopLoss: number): Promise<boolean> {
    if (!this.authorized) throw new Error("Not authorized");
    const response = await this.send({
      contract_update: 1,
      contract_id: contractId,
      limit_order: { stop_loss: stopLoss },
    }) as Record<string, unknown>;

    if (response.error) {
      const err = response.error as Record<string, unknown>;
      console.error(`[Deriv] Update SL error:`, err.message);
      return false;
    }
    return true;
  }

  async updateTakeProfit(contractId: number, takeProfit: number): Promise<boolean> {
    if (!this.authorized) throw new Error("Not authorized");
    const response = await this.send({
      contract_update: 1,
      contract_id: contractId,
      limit_order: { take_profit: takeProfit },
    }) as Record<string, unknown>;

    if (response.error) {
      const err = response.error as Record<string, unknown>;
      console.error(`[Deriv] Update TP error:`, err.message);
      return false;
    }
    return true;
  }

  getLatestQuote(symbol: string): number | null {
    return this.latestQuotes.get(symbol) ?? null;
  }

  async backfill(
    symbol: string,
    tickCount = 5000,
    onProgress?: (update: BackfillSymbolProgress) => void,
  ): Promise<{ ticks: number; candles: number }> {
    let storedTicks = 0;
    let storedCandles = 0;

    const apiSymbol = getApiSymbol(symbol);
    const YEARS_TO_BACKFILL = 3;
    const CANDLES_PER_PAGE = 5000;
    const now = Math.floor(Date.now() / 1000);
    const targetStart = now - (YEARS_TO_BACKFILL * 365.25 * 24 * 60 * 60);

    const totalExpected1m = Math.ceil((now - targetStart) / 60);
    const totalExpected5m = Math.ceil((now - targetStart) / 300);
    const totalExpectedCandles = totalExpected1m + totalExpected5m;

    const emit = (phase: string, candles: number, oldestDate?: string) => {
      if (!onProgress) return;
      const pct = Math.min(100, Math.round((candles / totalExpectedCandles) * 100));
      onProgress({ symbol, phase, pct, candles, ticks: storedTicks, oldestDate });
    };

    emit("ticks", 0);
    const history = await this.getTickHistory(apiSymbol, tickCount);
    if (history && history.prices && history.times) {
      const values = history.prices.map((price, i) => ({
        symbol,
        epochTs: history.times[i],
        quote: price,
      }));

      for (let i = 0; i < values.length; i += 500) {
        const chunk = values.slice(i, i + 500);
        await db.insert(ticksTable).values(chunk).onConflictDoNothing();
        storedTicks += chunk.length;
      }
      console.log(`[Deriv] Stored ${storedTicks} historical ticks for ${symbol}`);

      let prevPrice: number | null = null;
      const changes: number[] = [];
      let ticksSince = 0;
      for (let i = 0; i < values.length; i++) {
        const { quote: price, epochTs } = values[i];
        if (prevPrice !== null) {
          const change = Math.abs(price - prevPrice);
          changes.push(change);
          ticksSince++;
          if (changes.length >= 50) {
            const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
            const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
            const stdDev = Math.sqrt(variance);
            if (stdDev > 0 && (change - mean) / stdDev > 4.0) {
              const direction = price > prevPrice ? "up" : "down";
              await db.insert(spikeEventsTable).values({
                symbol, eventTs: epochTs, direction,
                spikeSize: change, ticksSincePreviousSpike: ticksSince,
              }).onConflictDoNothing();
              ticksSince = 0;
            }
          }
          if (changes.length > 500) changes.shift();
        }
        prevPrice = price;
      }
    }

    let cumulativeCandles = 0;

    for (const [tf, granularity] of [["1m", 60], ["5m", 300]] as [string, number][]) {
      let endEpoch = now;
      let totalForTf = 0;
      let pages = 0;
      const maxPages = Math.ceil((YEARS_TO_BACKFILL * 365.25 * 24 * 60 * 60) / (granularity * CANDLES_PER_PAGE)) + 5;

      while (endEpoch > targetStart && pages < maxPages) {
        const candles = await this.getCandleHistoryWithEnd(apiSymbol, granularity, CANDLES_PER_PAGE, endEpoch, true);
        if (!candles || candles.length === 0) break;

        const values = candles.map(c => ({
          symbol,
          timeframe: tf,
          openTs: c.epoch,
          closeTs: c.epoch + granularity,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          tickCount: 0,
        }));
        for (let i = 0; i < values.length; i += 500) {
          const chunk = values.slice(i, i + 500);
          await db.insert(candlesTable).values(chunk).onConflictDoNothing();
          totalForTf += chunk.length;
        }

        cumulativeCandles += values.length;
        const oldestEpoch = candles[0].epoch;
        if (oldestEpoch >= endEpoch) break;
        endEpoch = oldestEpoch - 1;
        pages++;

        if (pages % 5 === 0) {
          const oldestDate = new Date(oldestEpoch * 1000).toISOString().slice(0, 10);
          emit(`candles_${tf}`, cumulativeCandles, oldestDate);
        }

        if (pages % 20 === 0) {
          const oldestDate = new Date(oldestEpoch * 1000).toISOString().slice(0, 10);
          console.log(`[Backfill] ${symbol} ${tf}: ${totalForTf} candles so far, oldest=${oldestDate}, page ${pages}`);
        }

        await new Promise(r => setTimeout(r, 100));
      }

      const oldestStored = endEpoch > targetStart ? new Date(endEpoch * 1000).toISOString().slice(0, 10) : new Date(targetStart * 1000).toISOString().slice(0, 10);
      console.log(`[Backfill] ${symbol} ${tf}: ${totalForTf} candles total (oldest≈${oldestStored}, ${pages} pages)`);
      storedCandles += totalForTf;
    }

    emit("done", cumulativeCandles);
    return { ticks: storedTicks, candles: storedCandles };
  }

  async startStreaming(symbols: string[]): Promise<void> {
    this.streaming = true;
    await this.connect();

    let validatedMap: Map<string, { apiSymbol: string; displayName: string; marketType: string }>;
    try {
      validatedMap = await validateActiveSymbols(true);
    } catch (err) {
      console.warn("[Deriv] Symbol validation failed, subscribing to all configured symbols:", err instanceof Error ? err.message : err);
      validatedMap = new Map(symbols.map(s => [s, { apiSymbol: s, displayName: s, marketType: "unknown" }]));
    }

    const validSymbols: string[] = [];
    const invalidSymbols: string[] = [];

    for (const symbol of symbols) {
      if (validatedMap.has(symbol)) {
        validSymbols.push(symbol);
      } else {
        invalidSymbols.push(symbol);
        markSymbolError(symbol, "Not found in Deriv active symbols — excluded from streaming");
        console.warn(`[Deriv] ⚠ SYMBOL INVALID: ${symbol} — not found in active symbols. Skipping subscription.`);
      }
    }

    if (invalidSymbols.length > 0) {
      console.warn(`[Deriv] ━━━ INVALID SYMBOLS ━━━`);
      for (const s of invalidSymbols) {
        console.warn(`[Deriv]   ✗ ${s} — will NOT stream`);
      }
      console.warn(`[Deriv] ━━━━━━━━━━━━━━━━━━━━━━━`);
    }

    this.apiToConfiguredMap.clear();
    const apiSymbolsSeen = new Map<string, string>();

    for (const symbol of validSymbols) {
      try {
        const info = validatedMap.get(symbol);
        const apiSymbol = info?.apiSymbol || symbol;
        if (apiSymbol !== symbol) {
          const existing = apiSymbolsSeen.get(apiSymbol);
          if (existing) {
            markSymbolError(symbol, `API symbol collision: ${apiSymbol} already mapped to ${existing}`);
            console.error(`[Deriv] API symbol collision: ${apiSymbol} mapped to both ${existing} and ${symbol}. Skipping ${symbol}.`);
            continue;
          }
          this.apiToConfiguredMap.set(apiSymbol, symbol);
          console.log(`[Deriv] Symbol mapping: ${symbol} → ${apiSymbol} (will subscribe as ${apiSymbol})`);
        }
        apiSymbolsSeen.set(apiSymbol, symbol);
        await this.subscribeToTicks(apiSymbol);
        this.subscribedSymbols.add(symbol);
        markSymbolSubscribed(symbol);
      } catch (err) {
        markSymbolError(symbol, `Subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`[Deriv] Failed to subscribe to ${symbol}:`, err instanceof Error ? err.message : err);
      }
    }

    const self = this;
    startWatchdog(async (symbol: string) => {
      if (self.authorized && self.ws && self.ws.readyState === WebSocket.OPEN) {
        const apiSymbol = self.configuredToApiSymbol(symbol);
        await self.subscribeToTicks(apiSymbol);
        self.subscribedSymbols.add(symbol);
        markSymbolSubscribed(symbol);
      }
    });

    await db.insert(platformStateTable).values({ key: "streaming", value: "true" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "true", updatedAt: new Date() } });
    await db.insert(platformStateTable).values({ key: "streaming_symbols", value: validSymbols.join(",") })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: validSymbols.join(","), updatedAt: new Date() } });
    await db.insert(platformStateTable).values({ key: "invalid_symbols", value: invalidSymbols.join(",") })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: invalidSymbols.join(","), updatedAt: new Date() } });
    await db.insert(platformStateTable).values({ key: "last_sync_at", value: new Date().toISOString() })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: new Date().toISOString(), updatedAt: new Date() } });
  }

  async stopStreaming(): Promise<void> {
    this.streaming = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedSymbols.clear();
    this.authorized = false;
    await db.insert(platformStateTable).values({ key: "streaming", value: "false" })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value: "false", updatedAt: new Date() } });
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }
}

const ENC_KEY_SOURCE = process.env["DATABASE_URL"] || process.env["ENCRYPTION_SECRET"];
if (!ENC_KEY_SOURCE) {
  throw new Error("DATABASE_URL or ENCRYPTION_SECRET environment variable is required for secret decryption.");
}
const ENC_DERIVED_KEY = scryptSync(ENC_KEY_SOURCE, "deriv-quant-salt", 32);

function decryptStoredSecret(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const iv = Buffer.from(parts[1], "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENC_DERIVED_KEY, iv);
  let decrypted = decipher.update(parts[2], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function getDbApiToken(): Promise<string | null> {
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "deriv_api_token"));
    const raw = rows[0]?.value || null;
    if (!raw) return null;
    return decryptStoredSecret(raw);
  } catch {
    return null;
  }
}

export async function getDbApiTokenForMode(mode: TradingMode): Promise<string | null> {
  const key = mode === "demo" ? "deriv_api_token_demo" : mode === "real" ? "deriv_api_token_real" : null;
  if (!key) return null;
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, key));
    let raw = rows[0]?.value || null;
    if (!raw) {
      const fallbackRows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "deriv_api_token"));
      raw = fallbackRows[0]?.value || null;
    }
    if (!raw) return null;
    return decryptStoredSecret(raw);
  } catch {
    return null;
  }
}

let derivClientDemo: DerivClient | null = null;
let lastTokenDemo: string | null = null;
let derivClientReal: DerivClient | null = null;
let lastTokenReal: string | null = null;
let derivClient: DerivClient | null = null;
let lastToken: string | null = null;

export async function getDerivClientWithDbToken(): Promise<DerivClient> {
  const token = await getDbApiToken();
  if (!token) {
    const demoToken = await getDbApiTokenForMode("demo");
    const realToken = await getDbApiTokenForMode("real");
    const fallbackToken = demoToken || realToken;
    if (!fallbackToken) {
      throw new Error("No Deriv API token configured. Add it in Settings → API Keys.");
    }
    if (!derivClient || lastToken !== fallbackToken) {
      if (derivClient) {
        derivClient.stopStreaming();
      }
      derivClient = new DerivClient(fallbackToken);
      lastToken = fallbackToken;
    }
  } else if (!derivClient || lastToken !== token) {
    if (derivClient) {
      derivClient.stopStreaming();
    }
    derivClient = new DerivClient(token);
    lastToken = token;
  }
  if (!derivClient.authorized) {
    await derivClient.connect();
  }
  return derivClient;
}

export async function getDerivClientForMode(mode: TradingMode): Promise<DerivClient | null> {
  if (mode === "paper") return null;

  const token = await getDbApiTokenForMode(mode);
  if (!token) return null;

  if (mode === "demo") {
    if (!derivClientDemo || lastTokenDemo !== token) {
      if (derivClientDemo) {
        derivClientDemo.stopStreaming();
      }
      derivClientDemo = new DerivClient(token);
      lastTokenDemo = token;
    }
    if (!derivClientDemo.authorized) {
      await derivClientDemo.connect();
    }
    return derivClientDemo;
  } else {
    if (!derivClientReal || lastTokenReal !== token) {
      if (derivClientReal) {
        derivClientReal.stopStreaming();
      }
      derivClientReal = new DerivClient(token);
      lastTokenReal = token;
    }
    if (!derivClientReal.authorized) {
      await derivClientReal.connect();
    }
    return derivClientReal;
  }
}

async function getEnabledSymbols(): Promise<string[]> {
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "enabled_symbols"));
    if (rows.length > 0 && rows[0].value) {
      const symbols = rows[0].value.split(",").filter((s: string) => V1_DEFAULT_SYMBOLS.includes(s));
      if (symbols.length > 0) return symbols;
    }
  } catch {}
  return [...V1_DEFAULT_SYMBOLS];
}

export function getActiveModes(stateMap: Record<string, string>): TradingMode[] {
  const modes: TradingMode[] = [];
  if (stateMap["paper_mode_active"] === "true") modes.push("paper");
  if (stateMap["demo_mode_active"] === "true") modes.push("demo");
  if (stateMap["real_mode_active"] === "true") modes.push("real");
  return modes;
}

export function isAnyModeActive(stateMap: Record<string, string>): boolean {
  return getActiveModes(stateMap).length > 0;
}

export function getModeCapitalKey(mode: TradingMode): string {
  switch (mode) {
    case "paper": return "paper_capital";
    case "demo": return "demo_capital";
    case "real": return "real_capital";
  }
}

export function getModeCapitalDefault(mode: TradingMode): string {
  switch (mode) {
    case "paper": return "10000";
    case "demo": return "600";
    case "real": return "600";
  }
}

export { DerivClient, getEnabledSymbols };
