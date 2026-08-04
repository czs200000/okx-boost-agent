import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { xLayerRwaCampaign } from "./core/campaign.js";
import { evaluateRisk } from "./core/risk.js";
import { assessTradeEconomics } from "./core/economics.js";
import { autonomousPlan, deterministicPlan } from "./core/strategy.js";
import { AgenticWalletExecutor } from "./executors/agentic.js";
import { xLayerRwaTokens } from "./providers/onchain-market.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { readAgenticWalletStatus } from "./providers/agentic-wallet.js";
import { readMarketPrices, readOnchainSnapshot } from "./providers/onchain-market.js";
import { readOfficialBoostStatus } from "./providers/boost-official.js";
import { MemoryStore } from "./store.js";
import { nextStageTarget } from "./core/stage-target.js";
import { liquidityCandidates, liquidityQuoteAcceptable, projectedWorstLossUsd } from "./core/liquidity-sizing.js";
import { chooseAdaptiveTiming, summarizeTradeWindow } from "./core/adaptive-timing.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "public");
const store = new MemoryStore();
const deepseek = new DeepSeekProvider(config.deepseek);
let cycleBusy = false;
let officialSyncBusy = false;
let marketPollBusy = false;
let lastAiAnalysisAt = 0;
let cachedAiPlan = null;
let adaptiveTiming = {
  marketPollMs: Math.max(15000, config.execution.marketPollMs),
  decisionMs: Math.max(30000, config.execution.cycleMs),
  aiAnalysisIntervalMs: Math.max(120000, config.execution.aiAnalysisIntervalMs)
};
let decisionTimer = null;
let marketTimer = null;
let positionMonitorTimer = null;

const publishAdaptiveTiming = (patch = {}) => {
  const previous = store.read().adaptiveTiming || {};
  store.update({
    adaptiveTiming: {
      ...previous,
      enabled: config.execution.adaptiveTimingEnabled,
      evaluationMs: config.execution.adaptiveEvaluationMs,
      ...adaptiveTiming,
      ...patch
    }
  });
};

function evaluateAndAdjustTiming() {
  if (!config.execution.adaptiveTimingEnabled) return;
  const now = Date.now();
  const state = store.read();
  const current = summarizeTradeWindow(state.trades, now - config.execution.adaptiveEvaluationMs, now);
  const previous = summarizeTradeWindow(state.trades, now - 2 * config.execution.adaptiveEvaluationMs, now - config.execution.adaptiveEvaluationMs);
  const result = chooseAdaptiveTiming({
    current,
    previous,
    timing: adaptiveTiming,
    maxHealthyCostBps: config.execution.maxRoundTripLossBps
  });
  adaptiveTiming = result.nextTiming;
  const evaluatedAt = new Date(now).toISOString();
  const evaluation = { evaluatedAt, ...result, current, previous };
  publishAdaptiveTiming({
    lastEvaluatedAt: evaluatedAt,
    nextEvaluationAt: new Date(now + config.execution.adaptiveEvaluationMs).toISOString(),
    lastResult: evaluation
  });
  store.update({ adaptiveEvaluations: [evaluation, ...(state.adaptiveEvaluations || [])].slice(0, 24) });
  store.log(`Hourly timing evaluation: ${result.action}; volume $${current.volumeUsd.toFixed(2)} vs $${previous.volumeUsd.toFixed(2)}, cost ${current.costBps.toFixed(2)} bps`);
}

const scheduleDecisionCycle = () => {
  clearTimeout(decisionTimer);
  decisionTimer = setTimeout(async () => {
    await autonomousCycle("timer");
    scheduleDecisionCycle();
  }, adaptiveTiming.decisionMs);
};

const scheduleMarketPoll = () => {
  clearTimeout(marketTimer);
  marketTimer = setTimeout(async () => {
    await refreshMarketPrices("timer");
    scheduleMarketPoll();
  }, adaptiveTiming.marketPollMs);
};

const schedulePositionMonitor = () => {
  clearTimeout(positionMonitorTimer);
  positionMonitorTimer = setTimeout(async () => {
    const state = store.read();
    if (state.running && state.position) await autonomousCycle("position-monitor");
    schedulePositionMonitor();
  }, Math.max(15000, config.execution.positionMonitorMs));
};

async function syncOfficialBoost(trigger = "timer") {
  if (officialSyncBusy) return;
  officialSyncBusy = true;
  try {
    const wallet = await readAgenticWalletStatus();
    const official = await readOfficialBoostStatus({ activityId: xLayerRwaCampaign.officialActivityId, walletAddress: wallet.evmAddress });
    const patch = {
      officialBoostCheckedAt: official.checkedAt,
      officialBoostSyncError: null,
      officialBoostSyncStatus: official.valueAvailable ? "synced" : "personal_volume_withheld",
      officialMinVolumeToRankUsd: official.minVolumeToRankUsd,
      officialNextTierVolumeUsd: official.nextTierVolumeUsd,
      officialParticipationStatus: official.participationStatus,
      estimatedRewardUsd: official.estimatedRewardUsd
    };
    if (official.valueAvailable) {
      patch.officialBoostVolumeUsd = official.volumeUsd;
      patch.officialBoostUpdatedAt = official.officialUpdatedAt || official.checkedAt;
    }
    if (official.rank != null && official.rank > 0) patch.rank = official.rank;
    const current = store.read();
    const advancedTarget = nextStageTarget({
      localVolumeUsd: current.boostVolumeUsd,
      currentTargetUsd: current.targetVolumeUsd,
      nextTierUsd: official.nextTierVolumeUsd
    });
    if (advancedTarget > Number(current.targetVolumeUsd)) {
      patch.targetVolumeUsd = advancedTarget;
      store.log(`Stage reference advanced to the next official reward tier: $${advancedTarget.toFixed(2)}`);
    }
    store.update(patch);
    store.log(official.valueAvailable
      ? `Official Boost volume synced (${trigger})`
      : `Official Boost checked (${trigger}); OKX withheld personal volume from the unauthenticated response`);
  } catch (error) {
    store.update({
      officialBoostCheckedAt: new Date().toISOString(),
      officialBoostSyncStatus: "error",
      officialBoostSyncError: error.message
    });
    store.log(`Official Boost sync failed: ${error.message}`, "warn");
  } finally {
    officialSyncBusy = false;
  }
}

const recordPrices = snapshot => {
  const state = store.read();
  const priceHistory = structuredClone(state.priceHistory || {});
  for (const [token, price] of Object.entries(snapshot.prices || {})) {
    priceHistory[token] = [...(priceHistory[token] || []), { at: new Date().toISOString(), price: Number(price) }].slice(-288);
  }
  store.update({ priceHistory });
};

const marketFromSnapshot = (snapshot, state) => ({
  tokens: Object.fromEntries(Object.entries(snapshot.prices || {}).map(([token, price]) => {
    const history = (state.priceHistory[token] || []).slice(-config.execution.priceWindowSamples);
    const average = history.length ? history.reduce((sum, item) => sum + Number(item.price), 0) / history.length : Number(price);
    return [token, {
      price: Number(price),
      rollingMean: average,
      deviationBps: average ? ((Number(price) / average) - 1) * 10000 : 0,
      samples: history.length
    }];
  }))
});

async function refreshMarketPrices(trigger = "timer") {
  if (marketPollBusy) return;
  marketPollBusy = true;
  try {
    const market = await readMarketPrices(true);
    if (!Object.keys(market.prices || {}).length) throw new Error("No market prices returned");
    recordPrices(market);
    store.update({ marketPricesUpdatedAt: market.fetchedAt });
  } catch (error) {
    store.log(`Market monitor ${trigger} failed: ${error.message}`, "warn");
  } finally {
    marketPollBusy = false;
  }
}

async function selectLiquidityAdjustedTrade(plan, snapshot, executor) {
  if (plan.action !== "BUY") {
    const quote = await executor.quote(plan, snapshot);
    const actualPlan = plan.action === "SELL" ? { ...plan, amountUsd: Number(quote.toAmount) } : plan;
    return { plan: actualPlan, quote, liquidity: null };
  }
  const candidates = liquidityCandidates({
    requestedUsd: plan.amountUsd,
    tokenCapUsd: config.execution.tokenTradeCapsUsd[plan.token] ?? config.risk.maxTradeUsd,
    minimumUsd: config.execution.minDynamicTradeUsd
  });
  let last = null;
  for (const amountUsd of candidates) {
    const sizedPlan = { ...plan, amountUsd };
    const liquidity = await executor.quoteRoundTrip(sizedPlan, snapshot);
    const projectedLossUsd = projectedWorstLossUsd(amountUsd, liquidity.roundTripLossBps, config.execution.stopLossBps);
    liquidity.projectedWorstLossUsd = projectedLossUsd;
    last = { plan: sizedPlan, quote: liquidity.outbound, liquidity };
    const edgeCoversRoundTrip = Number(plan.expectedEdgeBps || 0) >= Number(liquidity.roundTripLossBps) + config.execution.minNetEntryBps;
    const dollarRiskAcceptable = projectedLossUsd <= config.execution.maxProjectedLossPerTradeUsd;
    if (liquidityQuoteAcceptable(liquidity, config.execution.maxRoundTripLossBps) && edgeCoversRoundTrip && dollarRiskAcceptable) return last;
  }
  const loss = Number(last?.liquidity?.roundTripLossBps);
  throw new Error(`No positive-edge size available; best tested round-trip loss ${Number.isFinite(loss) ? loss.toFixed(2) : "unknown"} bps`);
}

async function autonomousCycle(trigger = "timer") {
  if (cycleBusy || !store.read().running) return;
  cycleBusy = true;
  try {
    const [wallet, snapshot] = await Promise.all([readAgenticWalletStatus(), readOnchainSnapshot(true)]);
    if (!wallet.connected || !wallet.evmAddress) throw new Error("Agentic Wallet is disconnected");
    let state = store.read();
    const oneHourAgo = Date.now() - 3600000;
    const tradesLastHour = (state.trades || []).filter(item => new Date(item.at).getTime() >= oneHourAgo).length;
    const rwaValueUsd = snapshot.wallet.assets
      .filter(asset => Object.values(xLayerRwaTokens).includes(asset.tokenAddress?.toLowerCase()))
      .reduce((sum, asset) => sum + Number(asset.usdValue || 0), 0);
    const largestRwaValueUsd = snapshot.wallet.assets
      .filter(asset => Object.values(xLayerRwaTokens).includes(asset.tokenAddress?.toLowerCase()))
      .reduce((largest, asset) => Math.max(largest, Number(asset.usdValue || 0)), 0);
    store.update({
      tradesLastHour,
      rwaExposurePct: snapshot.wallet.totalValueUsd > 0 ? (rwaValueUsd / snapshot.wallet.totalValueUsd) * 100 : 0,
      tokenPositionPct: snapshot.wallet.totalValueUsd > 0 ? (largestRwaValueUsd / snapshot.wallet.totalValueUsd) * 100 : 0
    });
    state = store.read();
    if (state.position) {
      const positionAddress = xLayerRwaTokens[state.position.token];
      const heldAsset = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === positionAddress);
      const walletAmount = Number(heldAsset?.balance || 0);
      const matchingEntry = (state.trades || []).find(trade => trade.action === "BUY" && trade.token === state.position.token && trade.at === state.position.openedAt);
      const reconciled = {
        ...state.position,
        ...(walletAmount > 0 ? { amount: walletAmount } : {}),
        ...(!state.position.entryCostUsd && matchingEntry ? {
          entryCostUsd: Number(matchingEntry.quote?.fromAmount || matchingEntry.amountUsd),
          entryRoundTripLossBps: Number(matchingEntry.liquidity?.roundTripLossBps || 0)
        } : {})
      };
      if (JSON.stringify(reconciled) !== JSON.stringify(state.position)) {
        store.update({ position: reconciled });
        state = store.read();
        store.log(`Reconciled ${state.position.token} position from wallet and entry record`);
      }
    }
    if (!state.position) {
      const existing = snapshot.wallet.assets
        .filter(asset => Object.values(xLayerRwaTokens).includes(asset.tokenAddress?.toLowerCase()) && Number(asset.usdValue) >= 1)
        .sort((a, b) => b.usdValue - a.usdValue)[0];
      if (existing) {
        const token = Object.entries(xLayerRwaTokens).find(([, address]) => address === existing.tokenAddress.toLowerCase())?.[0];
        if (token) store.update({ position: { token, amount: Number(existing.balance), entryPrice: Number(snapshot.prices[token]), openedAt: new Date().toISOString(), bootstrapped: true } });
      }
      state = store.read();
    }
    const market = marketFromSnapshot(snapshot, state);
    let aiPlan = null;
    if (deepseek.configured) {
      if (!cachedAiPlan || Date.now() - lastAiAnalysisAt >= adaptiveTiming.aiAnalysisIntervalMs) {
        try {
          cachedAiPlan = await deepseek.analyze({
            campaign: xLayerRwaCampaign,
            market,
            position: state.position,
            progress: { volumeUsd: state.boostVolumeUsd, targetVolumeUsd: state.targetVolumeUsd },
            attributionVerified: state.attributionVerified,
            limits: config.risk,
            instruction: "Analyze genuine low-cost mean-reversion opportunities. Do not recommend circular or artificial volume trades."
          });
          lastAiAnalysisAt = Date.now();
        } catch (error) {
          store.log(`DeepSeek cycle fallback: ${error.message}`, "warn");
        }
      }
      aiPlan = cachedAiPlan;
    }
    const plan = autonomousPlan(snapshot, state, {
      ...config.execution,
      tradeUsd: config.risk.maxTradeUsd,
      maxSlippageBps: config.risk.maxSlippageBps
    }, aiPlan);
    const risk = evaluateRisk(plan, state, config.risk);
    const decision = { at: new Date().toISOString(), source: aiPlan ? "deepseek+deterministic" : "deterministic-fallback", aiPlan, plan, risk, trigger };
    store.update({ lastDecision: decision });
    if (!risk.approved) {
      store.log(`Cycle ${trigger}: ${plan.action} — ${risk.reasons.join(", ") || plan.reason}`);
      if (risk.reasons.includes("daily_loss_limit")) store.update({ running: false });
      return;
    }
    const executor = new AgenticWalletExecutor({ enabled: true, walletAddress: wallet.evmAddress, tokens: xLayerRwaTokens, maxSlippageBps: config.risk.maxSlippageBps });
    const sized = await selectLiquidityAdjustedTrade(plan, snapshot, executor);
    const executionPlan = sized.plan;
    const quote = sized.quote;
    const economics = assessTradeEconomics(executionPlan, quote, state, config.execution);
    if (executionPlan.action === "SELL" && state.position?.entryCostUsd > 0) {
      const exitProceedsUsd = Number(quote.toAmount || 0);
      const cashPnlUsd = exitProceedsUsd - Number(state.position.entryCostUsd);
      const netExitBps = cashPnlUsd / Number(state.position.entryCostUsd) * 10000;
      economics.exitProceedsUsd = exitProceedsUsd;
      economics.cashPnlUsd = cashPnlUsd;
      economics.netExitBps = netExitBps;
      const forcedExit = /stop loss|max hold/i.test(executionPlan.reason || "");
      if (!forcedExit && netExitBps < config.execution.minNetExitBps) {
        economics.approved = false;
        economics.reason = `net exit ${netExitBps.toFixed(2)} bps below ${config.execution.minNetExitBps.toFixed(2)} bps target`;
      }
    }
    store.update({ lastDecision: { ...decision, plan: executionPlan, economics, liquidity: sized.liquidity } });
    store.log(`Quote ${quote.fromAmount} ${quote.fromSymbol} → ${quote.toAmount} ${quote.toSymbol}; cost ${economics.costBps.toFixed(2)} bps`);
    if (!economics.approved) {
      store.log(`Trade skipped: ${economics.reason}; edge ${economics.expectedEdgeBps.toFixed(2)} bps, subsidy ${economics.rewardSubsidyBps.toFixed(2)} bps`, "warn");
      return;
    }
    const execution = await executor.execute(executionPlan, snapshot, quote);
    if (execution.status === "CONFIRMING") {
      store.update({ running: false, pendingConfirmation: { at: new Date().toISOString(), plan: executionPlan, quote, message: execution.message, next: execution.next } });
      store.log(`Wallet confirmation required: ${execution.message}`, "warn");
      return;
    }
    const cashPnlUsd = executionPlan.action === "SELL" && state.position?.entryCostUsd > 0
      ? Number(quote.toAmount || 0) - Number(state.position.entryCostUsd)
      : null;
    const trade = { at: new Date().toISOString(), ...executionPlan, ...execution, quote, economics, liquidity: sized.liquidity, aiPlan, cashPnlUsd, actualLossUsd: cashPnlUsd == null ? null : Math.max(0, -cashPnlUsd) };
    const trades = [trade, ...(state.trades || [])].slice(0, 500);
    const volume = state.boostVolumeUsd + Number(executionPlan.amountUsd);
    const cost = Number(economics.expectedCostUsd || 0);
    let realizedPnlUsd = state.realizedPnlUsd;
    if (cashPnlUsd != null) realizedPnlUsd += cashPnlUsd;
    const nextPosition = executionPlan.action === "BUY"
      ? { token: executionPlan.token, amount: Number(quote.toAmount), entryPrice: Number(snapshot.prices[executionPlan.token]), entryCostUsd: Number(quote.fromAmount), entryRoundTripLossBps: Number(sized.liquidity?.roundTripLossBps), openedAt: trade.at }
      : null;
    store.update({
      trades,
      boostVolumeUsd: volume,
      lastVolumeUpdatedAt: trade.at,
      lastBroadcastAt: trade.at,
      position: nextPosition,
      pendingConfirmation: null,
      tradingCostsUsd: state.tradingCostsUsd + (cashPnlUsd == null ? 0 : Math.max(0, -cashPnlUsd)),
      realizedPnlUsd,
      dailyPnlUsd: realizedPnlUsd,
      tradesLastHour: tradesLastHour + 1
    });
    store.log(`Broadcast ${executionPlan.action} ${executionPlan.token} $${Number(executionPlan.amountUsd).toFixed(2)} — ${execution.txHash || "transaction submitted"}`);
  } catch (error) {
    store.log(`Autonomous cycle failed: ${error.message}`, "error");
    if (/BLOCK|disconnected|confirmation/i.test(error.message)) store.update({ running: false });
  } finally {
    cycleBusy = false;
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const readJson = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
};

async function decide(payload) {
  const state = store.read();
  let market = payload.market;
  if (!market) {
    const snapshot = await readOnchainSnapshot();
    market = marketFromSnapshot(snapshot, state);
  }
  const fallback = deterministicPlan(market || {}, config.risk);
  let plan = fallback;
  let source = "deterministic";

  if (payload.useDeepSeek && deepseek.configured) {
    try {
      plan = await deepseek.analyze({ campaign: xLayerRwaCampaign, market, state, limits: config.risk });
      source = "deepseek";
    } catch (error) {
      store.log(`DeepSeek fallback: ${error.message}`, "warn");
    }
  }

  const risk = evaluateRisk(plan, state, config.risk);
  const decision = { at: new Date().toISOString(), source, plan, risk };
  store.update({ lastDecision: decision });
  store.log(`${source} decision: ${plan.action}${plan.token ? ` ${plan.token}` : ""}; ${risk.approved ? "approved" : `blocked (${risk.reasons.join(", ") || "hold"})`}`);
  return decision;
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/status") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot()
      ]);
      if (wallet.connected !== store.read().walletConnected) {
        store.update({
          walletConnected: wallet.connected,
          walletAddress: wallet.evmAddress
        });
        if (wallet.connected) store.log("Agentic Wallet connected");
      }
      return json(response, 200, {
        state: store.read(),
        wallet,
        onchain,
        campaign: xLayerRwaCampaign,
        capabilities: {
          deepseekConfigured: deepseek.configured,
          autonomousConfigured: config.execution.autonomousEnabled,
          agenticExecutionReady: config.execution.autonomousEnabled && store.read().attributionVerified && wallet.connected
        },
        risk: config.risk
      });
    }
    if (request.method === "POST" && url.pathname === "/api/wallet/sync") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot(true)
      ]);
      store.update({
        walletConnected: wallet.connected,
        walletAddress: wallet.evmAddress,
        walletAssetsUpdatedAt: onchain.fetchedAt || new Date().toISOString()
      });
      store.log("X Layer wallet assets synced");
      return json(response, 200, { wallet, onchain, state: store.read() });
    }
    if (request.method === "GET" && url.pathname === "/api/live") {
      const state = store.read();
      return json(response, 200, {
        state: {
          running: state.running,
          boostVolumeUsd: state.boostVolumeUsd,
          officialBoostVolumeUsd: state.officialBoostVolumeUsd,
          officialBoostUpdatedAt: state.officialBoostUpdatedAt,
          officialBoostCheckedAt: state.officialBoostCheckedAt,
          officialBoostSyncStatus: state.officialBoostSyncStatus,
          officialBoostSyncError: state.officialBoostSyncError,
          officialMinVolumeToRankUsd: state.officialMinVolumeToRankUsd,
          officialNextTierVolumeUsd: state.officialNextTierVolumeUsd,
          officialParticipationStatus: state.officialParticipationStatus,
          rank: state.rank,
          estimatedRewardUsd: state.estimatedRewardUsd,
          walletAssetsUpdatedAt: state.walletAssetsUpdatedAt,
          targetVolumeUsd: state.targetVolumeUsd,
          tradingCostsUsd: state.tradingCostsUsd,
          lastVolumeUpdatedAt: state.lastVolumeUpdatedAt,
          tradeCount: (state.trades || []).length
        },
        serverTime: new Date().toISOString()
      });
    }
    if (request.method === "POST" && url.pathname === "/api/boost/sync") {
      await syncOfficialBoost("manual");
      return json(response, 200, { state: store.read() });
    }
    if (request.method === "POST" && url.pathname === "/api/decision") {
      return json(response, 200, await decide(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/control") {
      const body = await readJson(request);
      if (!['start', 'pause', 'stop'].includes(body.action)) return json(response, 400, { error: "Invalid action" });
      if (body.action === "start" && !store.read().attributionVerified) {
        store.log("Start blocked: Boost attribution is not verified", "warn");
        return json(response, 409, { error: "Boost attribution must be verified before autonomous execution" });
      }
      store.update({ running: body.action === "start" });
      store.log(`Workflow ${body.action} requested`);
      if (body.action === "start") setImmediate(() => autonomousCycle("manual-start"));
      return json(response, 200, { state: store.read() });
    }
    if (request.method === "POST" && url.pathname === "/api/cycle") {
      setImmediate(() => autonomousCycle("manual-cycle"));
      return json(response, 202, { accepted: true });
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = pathname.replace(/\.\./g, "");
    const body = await readFile(join(root, safePath));
    response.writeHead(200, { "content-type": mime[extname(safePath)] || "application/octet-stream" });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(response, 404, { error: "Not found" });
    console.error(error);
    json(response, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`OKX Boost workflow dashboard: http://127.0.0.1:${config.port}`);
  if (config.execution.autonomousEnabled && store.read().attributionVerified) {
    store.update({ running: true, mode: "agentic" });
    store.log("Autonomous Agentic Wallet execution enabled");
    setImmediate(async () => {
      await refreshMarketPrices("startup");
      await autonomousCycle("startup");
    });
  } else {
    setImmediate(() => refreshMarketPrices("startup"));
  }
  setImmediate(() => syncOfficialBoost("startup"));
  publishAdaptiveTiming({ nextEvaluationAt: new Date(Date.now() + config.execution.adaptiveEvaluationMs).toISOString() });
  scheduleDecisionCycle();
  scheduleMarketPoll();
  schedulePositionMonitor();
});

// OKX publishes leaderboard batches roughly every 10 minutes. Polling once a
// minute catches the next published batch without pretending we can force it.
setInterval(() => syncOfficialBoost("timer"), 60 * 1000);
setInterval(() => evaluateAndAdjustTiming(), Math.max(60000, config.execution.adaptiveEvaluationMs));
