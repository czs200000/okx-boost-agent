import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { xLayerRwaCampaign, aeonCampaign } from "./core/campaign.js";
import { evaluateRisk, evaluateAeonRisk } from "./core/risk.js";
import { assessTradeEconomics } from "./core/economics.js";
import { autonomousPlan, deterministicPlan, aeonPlan } from "./core/strategy.js";
import { AgenticWalletExecutor } from "./executors/agentic.js";
import { xLayerRwaTokens, aeonTokens } from "./providers/onchain-market.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { readAgenticWalletStatus } from "./providers/agentic-wallet.js";
import { readMarketPrices, readOnchainSnapshot } from "./providers/onchain-market.js";
import { readOfficialBoostStatus, readCompetitionRanking } from "./providers/boost-official.js";
import { MemoryStore } from "./store.js";
import { nextStageTarget } from "./core/stage-target.js";
import { liquidityCandidates, liquidityQuoteAcceptable, projectedWorstLossUsd } from "./core/liquidity-sizing.js";
import { usEquitySession } from "./core/us-equity-session.js";
import { chooseAdaptiveTiming, summarizeTradeWindow } from "./core/adaptive-timing.js";
import { reconcileTradeAccounting } from "./core/trade-accounting.js";
import { makerDecision, shouldCancelMakerOrder } from "./core/maker.js";
import { analyzeStabilization, analyzeDowntrend } from "./core/kline-analysis.js";
import { buildGrid, allocateLevelUsd, attributeBuys, attributeSells, nextOrders, gridTotals } from "./core/grid.js";
import { startFeishuGateway } from "./feishu-gateway.js";

const execFileAsync = promisify(execFile);
const onchainosCli = process.env.ONCHAINOS_CLI || "onchainos";
const runOnchainos = args => new Promise(resolve => {
  execFile(onchainosCli, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    let payload;
    try { payload = JSON.parse(stdout || stderr); } catch { payload = { ok: false, error: stderr || error?.message || "CLI error" }; }
    resolve({ exitCode: error?.code && Number.isInteger(error.code) ? error.code : 0, payload });
  });
});
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

const tokyoDayKey = date => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date);

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
    if (state.running && Object.keys(state.positions || {}).length) await autonomousCycle("position-monitor");
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
      const current = store.read();
      const deltaUsd = Math.max(0, Number(current.boostVolumeUsd || 0) - Number(official.volumeUsd || 0));
      patch.officialVolumeDeltaUsd = deltaUsd;
      patch.officialVolumeDeltaHistory = [
        { at: official.checkedAt, localVolumeUsd: Number(current.boostVolumeUsd || 0), officialVolumeUsd: Number(official.volumeUsd || 0), deltaUsd },
        ...(current.officialVolumeDeltaHistory || [])
      ].slice(0, 48);
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

const aggregatePositions = positionLots => Object.fromEntries(Object.entries(positionLots || {})
  .map(([token, lots]) => {
    const activeLots = (lots || []).filter(lot => Number(lot.amount) > 0);
    if (!activeLots.length) return null;
    const amount = activeLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
    const entryCostUsd = activeLots.reduce((sum, lot) => sum + Number(lot.entryCostUsd || 0), 0);
    const openedAt = activeLots.map(lot => lot.openedAt).filter(Boolean).sort()[0] || new Date().toISOString();
    return [token, {
      token, amount, entryCostUsd, openedAt,
      entryPrice: amount > 0 ? entryCostUsd / amount : 0,
      lots: activeLots.length
    }];
  })
  .filter(Boolean));

const activePositionLots = state => Object.values(state.positionLots || {}).flat().filter(lot => Number(lot.amount) > 0);

const lotId = token => `${token}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

async function refreshExecutableQuoteHistory(snapshot, executor) {
  const state = store.read();
  const lots = state.positionLots || {};
  const history = structuredClone(state.executableQuoteHistory || {});
  const totalOpenLots = activePositionLots(state).length;
  const probes = Object.entries(config.execution.tokenTradeCapsUsd)
    .map(([token, amountUsd]) => ({ token, amountUsd }))
    .filter(item => item.amountUsd > 0
      && (lots[item.token] || []).length < config.execution.maxGridLotsPerToken
      && totalOpenLots < config.execution.maxOpenGridLots);
  for (const probe of probes) {
    try {
      const quote = await executor.quoteRoundTrip({ action: "BUY", quoteToken: "USDT", maxSlippageBps: config.risk.maxSlippageBps, ...probe }, snapshot);
      const askUnitUsd = Number(quote.outbound.fromAmount) / Number(quote.outbound.toAmount);
      const bidUnitUsd = Number(quote.returnQuote.toAmount) / Number(quote.returnQuote.fromAmount);
      if (!(askUnitUsd > 0) || !(bidUnitUsd > 0)) throw new Error("invalid executable unit price");
      const sample = {
        at: new Date().toISOString(), amountUsd: probe.amountUsd, askUnitUsd, bidUnitUsd,
        roundTripLossUsd: Number(quote.roundTripLossUsd), roundTripLossBps: Number(quote.roundTripLossBps),
        action: quote.outbound.action, returnAction: quote.returnQuote.action
      };
      history[probe.token] = [...(history[probe.token] || []), sample].slice(-48);
    } catch (error) {
      store.log(`Executable quote probe ${probe.token} failed: ${error.message}`, "warn");
    }
  }
  store.update({ executableQuoteHistory: history, executableQuotesUpdatedAt: new Date().toISOString() });
}

async function refreshExecutableExitQuotes(snapshot, executor) {
  const state = store.read();
  const executableExitQuotes = {};
  for (const position of activePositionLots(state)) {
    if (Number(position.entryCostUsd || 0) < 1) continue;
    try {
      const quote = await executor.quote({
        action: "SELL", token: position.token, quoteToken: "USDT",
        amountUsd: Number(position.entryCostUsd || 1), amountToken: Number(position.amount || 0),
        lotId: position.id, maxSlippageBps: config.risk.maxSlippageBps
      }, snapshot);
      const entryCostUsd = Number(position.entryCostUsd || 0);
      const exitProceedsUsd = Number(quote.toAmount || 0);
      executableExitQuotes[position.id] = {
        at: new Date().toISOString(), exitProceedsUsd,
        cashPnlUsd: entryCostUsd > 0 ? exitProceedsUsd - entryCostUsd : null,
        netExitBps: entryCostUsd > 0 ? (exitProceedsUsd - entryCostUsd) / entryCostUsd * 10000 : null,
        action: quote.action,
        token: position.token,
        lotId: position.id
      };
    } catch (error) {
      store.log(`Executable exit probe ${position.token} lot ${position.id} failed: ${error.message}`, "warn");
    }
  }
  store.update({ executableExitQuotes, executableExitQuotesUpdatedAt: new Date().toISOString() });
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
    const projectedLossUsd = projectedWorstLossUsd(amountUsd, liquidity.roundTripLossBps, config.execution.hardStopLossBps);
    liquidity.projectedWorstLossUsd = projectedLossUsd;
    last = { plan: sizedPlan, quote: liquidity.outbound, liquidity };
    const netEntryBufferBps = amountUsd >= 150
      ? config.execution.minNetEntryBps
      : amountUsd >= 100
        ? config.execution.mediumSizeNetEntryBps
        : config.execution.smallSizeNetEntryBps;
    liquidity.requiredNetEntryBps = netEntryBufferBps;
    const edgeCoversRoundTrip = Number(plan.expectedEdgeBps || 0) >= Number(liquidity.roundTripLossBps) + netEntryBufferBps;
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
    const dayKey = tokyoDayKey(new Date());
    const daySnapshot = store.read().dayWalletSnapshot;
    if (!daySnapshot || daySnapshot.date !== dayKey) {
      store.update({
        dayWalletSnapshot: {
          date: dayKey,
          value: Number(snapshot.wallet.totalValueUsd || 0)
        }
      });
      store.log(`Daily wallet snapshot ${dayKey}: $${Number(snapshot.wallet.totalValueUsd || 0).toFixed(2)}`);
    }
    const executor = new AgenticWalletExecutor({ enabled: true, walletAddress: wallet.evmAddress, tokens: xLayerRwaTokens, maxSlippageBps: config.risk.maxSlippageBps });
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
    const positionLots = structuredClone(state.positionLots || {});
    for (const [token, lots] of Object.entries(positionLots)) {
      const heldAsset = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === xLayerRwaTokens[token]);
      const walletAmount = Number(heldAsset?.balance || 0);
      if (!(walletAmount > 0)) {
        delete positionLots[token];
        continue;
      }
      const tokenPrice = Number(snapshot.prices[token] || 0);
      // Drop sub-$1 dust positions: they can never be exited profitably and a
      // dust lot can wedge the whole cycle on an unexecutable micro-quote.
      if (!(Number(walletAmount) * tokenPrice >= 1)) {
        if (positionLots[token]?.length) store.log(`Dropped dust ${token} position ($${(Number(walletAmount) * tokenPrice).toFixed(4)})`, "warn");
        delete positionLots[token];
        continue;
      }
      const materialLots = (lots || []).filter(lot => Number(lot.amount || 0) * tokenPrice >= 1);
      const knownAmount = materialLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
      const knownCostUsd = materialLots.reduce((sum, lot) => sum + Number(lot.entryCostUsd || 0), 0);
      const walletValueUsd = Number(heldAsset?.usdValue || 0);
      const costBasisMismatchPct = walletValueUsd > 0 ? Math.abs(knownCostUsd - walletValueUsd) / walletValueUsd : 0;
      if (costBasisMismatchPct > 0.15) {
        positionLots[token] = [{
          id: lotId(token), token, amount: walletAmount,
          entryPrice: tokenPrice, entryAskUnitUsd: tokenPrice,
          entryCostUsd: walletValueUsd, openedAt: new Date().toISOString(),
          bootstrapped: true, reconciledFromWallet: true, costBasisReset: true
        }];
        store.log(`Rebased corrupted ${token} position cost to live wallet value`, "warn");
        continue;
      }
      const scale = knownAmount > walletAmount && knownAmount > 0 ? walletAmount / knownAmount : 1;
      positionLots[token] = materialLots.map(position => {
        const matchingEntry = (state.trades || []).find(trade => trade.action === "BUY" && trade.token === token && trade.at === position.openedAt);
        const scaledAmount = Number(position.amount || 0) * scale;
        const originalCostUsd = Number(position.entryCostUsd || matchingEntry?.quote?.fromAmount || matchingEntry?.amountUsd || 0);
        return {
          ...position,
          amount: scaledAmount,
          entryCostUsd: originalCostUsd * scale,
          ...(!position.entryCostUsd && matchingEntry ? {
            entryRoundTripLossBps: Number(matchingEntry.liquidity?.roundTripLossBps || 0)
          } : {})
        };
      }).filter(lot => Number(lot.amount) > 0);
      const reconciledAmount = positionLots[token].reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
      const untrackedAmount = Math.max(0, walletAmount - reconciledAmount);
      const untrackedValueUsd = walletAmount > 0
        ? Number(heldAsset?.usdValue || 0) * (untrackedAmount / walletAmount)
        : 0;
      if (untrackedValueUsd >= 1) {
        positionLots[token].push({
          id: lotId(token), token, amount: untrackedAmount,
          entryPrice: tokenPrice, entryAskUnitUsd: tokenPrice,
          entryCostUsd: untrackedValueUsd, openedAt: new Date().toISOString(),
          bootstrapped: true, reconciledFromWallet: true
        });
      }
      if (!positionLots[token].length) delete positionLots[token];
    }
    for (const asset of snapshot.wallet.assets.filter(asset => Object.values(xLayerRwaTokens).includes(asset.tokenAddress?.toLowerCase()) && Number(asset.usdValue) >= 1)) {
      const token = Object.entries(xLayerRwaTokens).find(([, address]) => address === asset.tokenAddress.toLowerCase())?.[0];
      if (token && !(positionLots[token] || []).length) positionLots[token] = [{
        id: lotId(token), token, amount: Number(asset.balance), entryPrice: Number(snapshot.prices[token]),
        entryCostUsd: Number(asset.usdValue), openedAt: new Date().toISOString(), bootstrapped: true
      }];
    }
    const positions = aggregatePositions(positionLots);
    store.update({ positionLots, positions, position: Object.values(positions)[0] || null });
    state = store.read();
    if (activePositionLots(state).length) {
      await refreshExecutableExitQuotes(snapshot, executor);
      state = store.read();
    }
    if (trigger !== "position-monitor" || !activePositionLots(state).length) {
      await refreshExecutableQuoteHistory(snapshot, executor);
      state = store.read();
    }
    const market = marketFromSnapshot(snapshot, state);
    const equitySession = usEquitySession();
    let aiPlan = null;
    if (deepseek.configured) {
      if (!cachedAiPlan || Date.now() - lastAiAnalysisAt >= adaptiveTiming.aiAnalysisIntervalMs) {
        try {
          cachedAiPlan = await deepseek.analyze({
            campaign: xLayerRwaCampaign,
            market,
            positions: state.positions,
            positionLots: state.positionLots,
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
      usEquitySession: equitySession,
      tradeUsd: config.risk.maxTradeUsd,
      maxSlippageBps: config.risk.maxSlippageBps
    }, aiPlan);
    const risk = evaluateRisk(plan, state, config.risk);
    const decision = { at: new Date().toISOString(), source: aiPlan ? "deepseek+deterministic" : "deterministic-fallback", aiPlan, plan, risk, trigger, usEquitySession: equitySession };
    store.update({ lastDecision: decision });
    if (!risk.approved) {
      store.log(`Cycle ${trigger}: ${plan.action} — ${risk.reasons.join(", ") || plan.reason}`);
      if (risk.reasons.includes("daily_loss_limit")) store.update({ running: false });
      return;
    }
    const sized = await selectLiquidityAdjustedTrade(plan, snapshot, executor);
    const executionPlan = sized.plan;
    const quote = sized.quote;
    const economics = assessTradeEconomics(executionPlan, quote, state, config.execution);
    const tradePosition = executionPlan.action === "SELL"
      ? activePositionLots(state).find(lot => lot.id === executionPlan.lotId) || state.positions?.[executionPlan.token]
      : null;
    if (executionPlan.action === "SELL" && tradePosition?.entryCostUsd > 0) {
      const exitProceedsUsd = Number(quote.toAmount || 0);
      const cashPnlUsd = exitProceedsUsd - Number(tradePosition.entryCostUsd);
      const netExitBps = cashPnlUsd / Number(tradePosition.entryCostUsd) * 10000;
      economics.exitProceedsUsd = exitProceedsUsd;
      economics.cashPnlUsd = cashPnlUsd;
      economics.netExitBps = netExitBps;
      if (netExitBps >= config.execution.minNetExitBps) {
        economics.approved = true;
        economics.reason = "executable net target reached";
      } else {
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
    const cashPnlUsd = executionPlan.action === "SELL" && tradePosition?.entryCostUsd > 0
      ? Number(quote.toAmount || 0) - Number(tradePosition.entryCostUsd)
      : null;
    const trade = { at: new Date().toISOString(), ...executionPlan, ...execution, quote, economics, liquidity: sized.liquidity, aiPlan, cashPnlUsd, actualLossUsd: cashPnlUsd == null ? null : Math.max(0, -cashPnlUsd) };
    const trades = [trade, ...(state.trades || [])].slice(0, 500);
    const volume = state.boostVolumeUsd + Number(executionPlan.amountUsd);
    const cost = Number(economics.expectedCostUsd || 0);
    let realizedPnlUsd = state.realizedPnlUsd;
    if (cashPnlUsd != null) realizedPnlUsd += cashPnlUsd;
    const nextPositionLots = structuredClone(state.positionLots || {});
    if (executionPlan.action === "BUY") {
      nextPositionLots[executionPlan.token] = [
        ...(nextPositionLots[executionPlan.token] || []),
        {
          id: lotId(executionPlan.token),
          token: executionPlan.token, amount: Number(quote.toAmount), entryPrice: Number(snapshot.prices[executionPlan.token]),
          entryCostUsd: Number(quote.fromAmount),
          entryAskUnitUsd: Number(quote.fromAmount) / Number(quote.toAmount),
          entryRoundTripLossBps: Number(sized.liquidity?.roundTripLossBps), openedAt: trade.at
        }
      ];
    } else if (executionPlan.lotId) {
      nextPositionLots[executionPlan.token] = (nextPositionLots[executionPlan.token] || []).filter(lot => lot.id !== executionPlan.lotId);
      if (!nextPositionLots[executionPlan.token].length) delete nextPositionLots[executionPlan.token];
    } else {
      delete nextPositionLots[executionPlan.token];
    }
    const nextPositions = aggregatePositions(nextPositionLots);
    store.update({
      trades,
      boostVolumeUsd: volume,
      lastVolumeUpdatedAt: trade.at,
      lastBroadcastAt: trade.at,
      positionLots: nextPositionLots,
      positions: nextPositions,
      position: Object.values(nextPositions)[0] || null,
      pendingConfirmation: null,
      tradingCostsUsd: Math.max(0, -realizedPnlUsd),
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

// ---------------------------------------------------------------------------
// AEON (BNB Chain) trading competition module — independent from X Layer RWA.
// ---------------------------------------------------------------------------
const aeonStore = new MemoryStore(new URL("../data/state-aeon.json", import.meta.url), "AEON_");
const aeonDeepseek = new DeepSeekProvider(config.deepseek, {
  action: ["BUY", "SELL", "HOLD"],
  token: ["AEON", null],
  quoteToken: ["USDT"]
});
let aeonCycleBusy = false;
let aeonOfficialSyncBusy = false;
let aeonMarketPollBusy = false;
let aeonDecisionTimer = null;
let aeonMarketTimer = null;
let aeonPositionMonitorTimer = null;

const aeonSettings = Object.freeze({ ...config.aeon });
const aeonEconSettings = Object.freeze({
  maxExecutionCostBps: config.aeon.maxExecutionCostBps,
  maxEffectiveCostBps: config.aeon.maxExecutionCostBps,
  maxRewardSubsidyBps: 0,
  minNetEdgeBps: 5
});
const aeonTokenAddress = aeonCampaign.competitionTokens[0].address;
const aeonUsdtAddress = "0x55d398326f99059ff775485246999027b3197955";
const BSC_RPC_ENDPOINTS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.binance.org"
];

async function readBscGasPriceGwei() {
  for (const endpoint of BSC_RPC_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload?.result) return Number(BigInt(payload.result)) / 1e9;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

async function syncAeonOfficialBoost(trigger = "timer") {
  if (aeonOfficialSyncBusy) return;
  aeonOfficialSyncBusy = true;
  try {
    const wallet = await readAgenticWalletStatus();
    if (!wallet.evmAddress) throw new Error("Wallet address is unavailable");
    const [official, ranking] = await Promise.all([
      readOfficialBoostStatus({ activityId: aeonCampaign.officialActivityId, walletAddress: wallet.evmAddress }),
      readCompetitionRanking({ activityId: aeonCampaign.officialActivityId, walletAddress: wallet.evmAddress, limit: config.aeon.leaderboardRows })
    ]);
    const market = await readMarketPrices(false, "bsc");
    const aeonPriceUsd = Number(market.prices?.AEON || 0);
    const rewardPerTokenUsd = aeonPriceUsd > 0 ? aeonPriceUsd : 0.06;
    const patch = {
      officialBoostCheckedAt: official.checkedAt,
      officialBoostSyncError: null,
      officialBoostSyncStatus: official.valueAvailable ? "synced" : "personal_volume_withheld",
      officialMinVolumeToRankUsd: official.minVolumeToRankUsd,
      officialNextTierVolumeUsd: official.nextTierVolumeUsd,
      officialParticipationStatus: official.participationStatus,
      estimatedRewardUsd: Number(official.expectedRewardTokens || 0) * rewardPerTokenUsd,
      estimatedRewardTokens: official.expectedRewardTokens,
      leaderboard: ranking.leaderboard,
      leaderboardMyRank: ranking.myRankInfo,
      leaderboardUpdatedAt: ranking.updatedAt || official.checkedAt
    };
    if (official.valueAvailable) {
      patch.officialBoostVolumeUsd = official.volumeUsd;
      patch.officialBoostUpdatedAt = official.officialUpdatedAt || official.checkedAt;
      if (official.rank != null && official.rank > 0) patch.rank = official.rank;
      const current = store.read();
      const deltaUsd = Math.max(0, Number(current.boostVolumeUsd || 0) - Number(official.volumeUsd || 0));
      patch.officialVolumeDeltaUsd = deltaUsd;
      patch.officialVolumeDeltaHistory = [
        { at: official.checkedAt, localVolumeUsd: Number(current.boostVolumeUsd || 0), officialVolumeUsd: Number(official.volumeUsd || 0), deltaUsd },
        ...(current.officialVolumeDeltaHistory || [])
      ].slice(0, 48);
    }
    const before = aeonStore.read();
    if (official.participationStatus === 2 && !before.attributionVerified) {
      patch.attributionVerified = true;
      aeonStore.log("AEON competition participation confirmed — autonomous execution unlocked");
    }
    aeonStore.update(patch);
    aeonStore.log(official.valueAvailable
      ? `AEON official volume synced (${trigger}): $${Number(official.volumeUsd).toFixed(2)}`
      : `AEON official checked (${trigger}); OKX withheld personal volume from the unauthenticated response`);
  } catch (error) {
    aeonStore.update({
      officialBoostCheckedAt: new Date().toISOString(),
      officialBoostSyncStatus: "error",
      officialBoostSyncError: error.message
    });
    aeonStore.log(`AEON official sync failed: ${error.message}`, "warn");
  } finally {
    aeonOfficialSyncBusy = false;
  }
}

async function refreshAeonMarketPrices(trigger = "timer") {
  if (aeonMarketPollBusy) return;
  aeonMarketPollBusy = true;
  try {
    const market = await readMarketPrices(true, "bsc");
    if (!Object.keys(market.prices || {}).length) throw new Error("No BSC market prices returned");
    const state = aeonStore.read();
    const priceHistory = structuredClone(state.priceHistory || {});
    for (const [token, price] of Object.entries(market.prices || {})) {
      priceHistory[token] = [...(priceHistory[token] || []), { at: new Date().toISOString(), price: Number(price) }].slice(-288);
    }
    aeonStore.update({ priceHistory, marketPricesUpdatedAt: market.fetchedAt });
  } catch (error) {
    aeonStore.log(`AEON market monitor ${trigger} failed: ${error.message}`, "warn");
  } finally {
    aeonMarketPollBusy = false;
  }
}

async function refreshAeonExitQuotes(snapshot, executor) {
  const state = aeonStore.read();
  const executableExitQuotes = {};
  for (const lot of state.positionLots?.AEON || []) {
    if (!(Number(lot.amount) > 0)) continue;
    try {
      const quote = await executor.quote({
        action: "SELL", token: "AEON", quoteToken: "USDT",
        amountUsd: Number(lot.entryCostUsd || 1), amountToken: Number(lot.amount || 0),
        lotId: lot.id, maxSlippageBps: config.aeon.maxSlippageBps
      }, snapshot);
      const entryCostUsd = Number(lot.entryCostUsd || 0);
      const exitProceedsUsd = Number(quote.toAmount || 0);
      executableExitQuotes[lot.id] = {
        at: new Date().toISOString(), exitProceedsUsd,
        cashPnlUsd: entryCostUsd > 0 ? exitProceedsUsd - entryCostUsd : null,
        netExitBps: entryCostUsd > 0 ? (exitProceedsUsd - entryCostUsd) / entryCostUsd * 10000 : null,
        action: quote.action, token: "AEON", lotId: lot.id
      };
    } catch (error) {
      aeonStore.log(`AEON exit probe lot ${lot.id} failed: ${error.message}`, "warn");
    }
  }
  aeonStore.update({ executableExitQuotes, executableExitQuotesUpdatedAt: new Date().toISOString() });
}

async function refreshAeonExecutableQuotes(snapshot, executor, gasPriceGwei, bnbPriceUsd) {
  const state = aeonStore.read();
  const heldUsdt = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === aeonUsdtAddress);
  const availableUsd = Math.max(0, Number(heldUsdt?.usdValue || heldUsdt?.balance || 0));
  // Keep probing executable quotes even when USDT is fully invested: the
  // unit bid/ask prices are what the exit logic needs to stay fresh.
  const amountUsd = Math.max(50, Math.min(config.aeon.maxTradeUsd, availableUsd));
  const history = structuredClone(state.executableQuoteHistory || {});
  try {
    const quote = await executor.quoteRoundTrip({ action: "BUY", quoteToken: "USDT", maxSlippageBps: config.aeon.maxSlippageBps, token: "AEON", amountUsd }, snapshot);
    const askUnitUsd = Number(quote.outbound.fromAmount) / Number(quote.outbound.toAmount);
    const bidUnitUsd = Number(quote.returnQuote.toAmount) / Number(quote.returnQuote.fromAmount);
    const gasUsdPerSwap = gasPriceGwei != null && bnbPriceUsd > 0
      ? Number(quote.outbound.gasLimit || 0) * gasPriceGwei * 1e-9 * bnbPriceUsd
      : null;
    if (!(askUnitUsd > 0) || !(bidUnitUsd > 0)) throw new Error("invalid executable unit price");
    const sample = {
      at: new Date().toISOString(), amountUsd, askUnitUsd, bidUnitUsd,
      roundTripLossUsd: Number(quote.roundTripLossUsd), roundTripLossBps: Number(quote.roundTripLossBps),
      gasLimit: Number(quote.outbound.gasLimit || 0), gasUsdPerSwap,
      action: quote.outbound.action, returnAction: quote.returnQuote.action
    };
    history.AEON = [...(history.AEON || []), sample].slice(-48);
    aeonStore.update({
      executableQuoteHistory: history,
      executableQuotesUpdatedAt: new Date().toISOString(),
      bscGasPriceGwei: gasPriceGwei,
      bscGasUsdPerSwap: gasUsdPerSwap,
      bscBnbPriceUsd: bnbPriceUsd
    });
  } catch (error) {
    aeonStore.log(`AEON executable quote probe failed: ${error.message}`, "warn");
  }
}

async function aeonCycle(trigger = "timer") {
  if (aeonCycleBusy || !aeonStore.read().running) return;
  aeonCycleBusy = true;
  try {
    const [wallet, snapshot, gasPriceGwei] = await Promise.all([
      readAgenticWalletStatus(),
      readOnchainSnapshot(true, "bsc"),
      readBscGasPriceGwei()
    ]);
    if (!wallet.connected || !wallet.evmAddress) throw new Error("Agentic Wallet is disconnected");
    const dayKey = tokyoDayKey(new Date());
    const daySnapshot = aeonStore.read().dayWalletSnapshot;
    if (!daySnapshot || daySnapshot.date !== dayKey) {
      aeonStore.update({
        dayWalletSnapshot: {
          date: dayKey,
          value: Number(snapshot.wallet.totalValueUsd || 0)
        }
      });
      aeonStore.log(`AEON daily wallet snapshot ${dayKey}: $${Number(snapshot.wallet.totalValueUsd || 0).toFixed(2)}`);
    }
    const executor = new AgenticWalletExecutor({
      enabled: true, walletAddress: wallet.evmAddress, tokens: aeonTokens,
      maxSlippageBps: config.aeon.maxSlippageBps, chain: "bsc"
    });
    const bnbPriceUsd = Number(snapshot.prices.BNB || 0);
    aeonStore.update({ bscGasPriceGwei: gasPriceGwei, bscBnbPriceUsd: bnbPriceUsd });

    // Reconcile the AEON inventory with the live wallet balance.
    const heldAeon = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === aeonTokenAddress);
    const walletAeonAmount = Number(heldAeon?.balance || 0);
    const tokenPrice = Number(snapshot.prices.AEON || 0);
    let aeonLots = structuredClone(aeonStore.read().positionLots?.AEON || []);
    if (!(walletAeonAmount > 0)) {
      aeonLots = [];
    } else {
      const materialLots = aeonLots.filter(lot => Number(lot.amount || 0) * tokenPrice >= 0.5);
      const knownAmount = materialLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
      if (knownAmount > 0 && Math.abs(walletAeonAmount - knownAmount) / Math.max(walletAeonAmount, 1) > 0.02) {
        const scale = walletAeonAmount / knownAmount;
        aeonLots = materialLots.map(lot => ({
          ...lot,
          amount: Number(lot.amount || 0) * scale,
          entryCostUsd: Number(lot.entryCostUsd || 0) * scale
        }));
      }
      const reconciledAmount = aeonLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
      const untrackedAmount = Math.max(0, walletAeonAmount - reconciledAmount);
      if (untrackedAmount * tokenPrice >= 0.5) {
        aeonLots.push({
          id: lotId("AEON"), token: "AEON", amount: untrackedAmount,
          entryPrice: tokenPrice, entryAskUnitUsd: tokenPrice,
          entryCostUsd: Number(heldAeon?.usdValue || 0) * (untrackedAmount / Math.max(walletAeonAmount, 1)),
          openedAt: new Date().toISOString(), bootstrapped: true, reconciledFromWallet: true
        });
      }
    }
    const aeonPositions = aeonLots.length ? {
      AEON: {
        token: "AEON",
        amount: aeonLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0),
        entryCostUsd: aeonLots.reduce((sum, lot) => sum + Number(lot.entryCostUsd || 0), 0),
        lots: aeonLots.length
      }
    } : {};
    aeonStore.update({
      positionLots: { AEON: aeonLots },
      positions: aeonPositions,
      position: aeonPositions.AEON || null
    });

    if (aeonLots.length) await refreshAeonExitQuotes(snapshot, executor);
    await refreshAeonExecutableQuotes(snapshot, executor, gasPriceGwei, bnbPriceUsd);
    let state = aeonStore.read();

    let aiPlan = null;
    if (aeonDeepseek.configured) {
      try {
        aiPlan = await aeonDeepseek.analyze({
          campaign: aeonCampaign,
          market: { tokens: { AEON: { price: Number(snapshot.prices.AEON || 0) } } },
          positions: state.positions,
          positionLots: state.positionLots,
          progress: { volumeUsd: state.boostVolumeUsd, targetVolumeUsd: state.targetVolumeUsd },
          attributionVerified: state.attributionVerified,
          limits: config.aeon,
          instruction: "Analyze AEON/USDT mean-reversion opportunities on BNB Chain. Prefer BUY on dips below the rolling mean and SELL when the executable bid recovers. Do not recommend wash trades."
        });
      } catch (error) {
        aeonStore.log(`AEON DeepSeek fallback: ${error.message}`, "warn");
      }
    }

    const plan = aeonPlan(snapshot, state, aeonSettings, aiPlan);
    if (plan.action === "BUY") {
      const heldUsdt = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === aeonUsdtAddress);
      const availableUsd = Math.max(0, Number(heldUsdt?.usdValue || heldUsdt?.balance || 0));
      plan.amountUsd = Math.min(Number(plan.amountUsd || 0), availableUsd);
      if (plan.amountUsd < 1) {
        aeonStore.update({ lastDecision: { at: new Date().toISOString(), source: aiPlan ? "deepseek+deterministic" : "deterministic-fallback", aiPlan, plan: { ...plan, action: "HOLD" }, risk: { approved: false, reasons: ["insufficient_usdt_balance"] }, trigger } });
        aeonStore.log("AEON BUY blocked: insufficient USDT balance on BNB Chain", "warn");
        return;
      }
      const latest = state.executableQuoteHistory?.AEON?.at(-1);
      const gasUsdPerSwap = Number(latest?.gasUsdPerSwap);
      if (!Number.isFinite(gasUsdPerSwap) || gasUsdPerSwap > config.aeon.maxGasCostUsdPerSwap) {
        aeonStore.update({ lastDecision: { at: new Date().toISOString(), source: aiPlan ? "deepseek+deterministic" : "deterministic-fallback", aiPlan, plan: { ...plan, action: "HOLD" }, risk: { approved: false, reasons: ["bsc_gas_gate_closed"] }, trigger } });
        aeonStore.log(`AEON BUY blocked: BSC gas ${Number.isFinite(gasUsdPerSwap) ? `$${gasUsdPerSwap.toFixed(2)}/swap above $${config.aeon.maxGasCostUsdPerSwap} gate` : "cost unknown — fail-safe hold"}`, "warn");
        return;
      }
    }
    const risk = evaluateAeonRisk(plan, state, aeonSettings);
    const decision = { at: new Date().toISOString(), source: aiPlan ? "deepseek+deterministic" : "deterministic-fallback", aiPlan, plan, risk, trigger };
    aeonStore.update({ lastDecision: decision });
    if (!risk.approved) {
      aeonStore.log(`AEON cycle ${trigger}: ${plan.action} — ${risk.reasons.join(", ") || plan.reason}`);
      if (risk.reasons.includes("max_loss_hit")) aeonStore.update({ running: false });
      return;
    }

    const quote = await executor.quote(plan, snapshot);
    const economics = assessTradeEconomics(plan, quote, state, aeonEconSettings);
    let tradePosition = null;
    if (plan.action === "SELL") {
      tradePosition = state.positionLots?.AEON?.find(lot => lot.id === plan.lotId);
      const exitProceedsUsd = Number(quote.toAmount || 0);
      const entryCostUsd = Number(tradePosition?.entryCostUsd || 0);
      if (entryCostUsd > 0) {
        const cashPnlUsd = exitProceedsUsd - entryCostUsd;
        const netExitBps = cashPnlUsd / entryCostUsd * 10000;
        economics.exitProceedsUsd = exitProceedsUsd;
        economics.cashPnlUsd = cashPnlUsd;
        economics.netExitBps = netExitBps;
        const isStopLoss = /stop loss/i.test(plan.reason || "");
        if (isStopLoss) {
          economics.approved = true;
          economics.reason = `AEON stop-loss exit ${netExitBps.toFixed(2)} bps`;
        } else {
          economics.approved = netExitBps >= Number(config.aeon.minSellNetExitBps ?? 20);
          economics.reason = economics.approved
            ? `AEON executable net exit ${netExitBps.toFixed(2)} bps`
            : `AEON net exit ${netExitBps.toFixed(2)} bps below ${config.aeon.minSellNetExitBps} bps target`;
        }
      }
    }
    aeonStore.update({ lastDecision: { ...decision, plan, economics } });
    aeonStore.log(`AEON quote ${quote.fromAmount} ${quote.fromSymbol} → ${quote.toAmount} ${quote.toSymbol}; cost ${economics.costBps.toFixed(2)} bps`);
    if (!economics.approved) {
      aeonStore.log(`AEON trade skipped: ${economics.reason}`, "warn");
      return;
    }

    const execution = await executor.execute(plan, snapshot, quote);
    if (execution.status === "CONFIRMING") {
      aeonStore.update({ running: false, pendingConfirmation: { at: new Date().toISOString(), plan, quote, message: execution.message, next: execution.next } });
      aeonStore.log(`AEON wallet confirmation required: ${execution.message}`, "warn");
      return;
    }

    const cashPnlUsd = plan.action === "SELL" && tradePosition?.entryCostUsd > 0
      ? Number(quote.toAmount || 0) - Number(tradePosition.entryCostUsd)
      : null;
    const trade = { at: new Date().toISOString(), ...plan, ...execution, quote, economics, aiPlan, cashPnlUsd, actualLossUsd: cashPnlUsd == null ? null : Math.max(0, -cashPnlUsd) };
    const trades = [trade, ...(state.trades || [])].slice(0, 500);
    const tradeVolumeUsd = plan.action === "BUY" ? Number(quote.fromAmount || 0) : Number(quote.toAmount || 0);
    const volume = state.boostVolumeUsd + Math.max(0, tradeVolumeUsd);
    let realizedPnlUsd = state.realizedPnlUsd;
    if (cashPnlUsd != null) realizedPnlUsd += cashPnlUsd;
    const nextAeonLots = structuredClone(state.positionLots?.AEON || []);
    if (plan.action === "BUY") {
      nextAeonLots.push({
        id: lotId("AEON"), token: "AEON", amount: Number(quote.toAmount),
        entryPrice: Number(snapshot.prices.AEON), entryCostUsd: Number(quote.fromAmount),
        entryAskUnitUsd: Number(quote.fromAmount) / Number(quote.toAmount),
        entryRoundTripLossBps: Number(state.executableQuoteHistory?.AEON?.at(-1)?.roundTripLossBps || 0),
        openedAt: trade.at
      });
    } else if (plan.lotId) {
      const soldIndex = nextAeonLots.findIndex(lot => lot.id === plan.lotId);
      if (soldIndex >= 0) nextAeonLots.splice(soldIndex, 1);
    }
    const nextPositions = nextAeonLots.length ? {
      AEON: {
        token: "AEON",
        amount: nextAeonLots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0),
        entryCostUsd: nextAeonLots.reduce((sum, lot) => sum + Number(lot.entryCostUsd || 0), 0),
        lots: nextAeonLots.length
      }
    } : {};
    const oneHourAgo = Date.now() - 3600000;
    const tradesLastHour = (state.trades || []).filter(item => new Date(item.at).getTime() >= oneHourAgo).length + 1;
    aeonStore.update({
      trades,
      boostVolumeUsd: volume,
      lastVolumeUpdatedAt: trade.at,
      lastBroadcastAt: trade.at,
      positionLots: { AEON: nextAeonLots },
      positions: nextPositions,
      position: nextPositions.AEON || null,
      pendingConfirmation: null,
      tradingCostsUsd: Math.max(0, -realizedPnlUsd),
      realizedPnlUsd,
      dailyPnlUsd: realizedPnlUsd,
      tradesLastHour
    });
    aeonStore.log(`AEON broadcast ${plan.action} $${Number(tradeVolumeUsd).toFixed(2)} — ${execution.txHash || "transaction submitted"}`);
  } catch (error) {
    aeonStore.log(`AEON autonomous cycle failed: ${error.message}`, "error");
    if (/BLOCK|disconnected|confirmation/i.test(error.message)) aeonStore.update({ running: false });
  } finally {
    aeonCycleBusy = false;
  }
}

const scheduleAeonDecisionCycle = () => {
  clearTimeout(aeonDecisionTimer);
  aeonDecisionTimer = setTimeout(async () => {
    await aeonCycle("timer");
    scheduleAeonDecisionCycle();
  }, Math.max(15000, config.aeon.cycleMs));
};

const scheduleAeonMarketPoll = () => {
  clearTimeout(aeonMarketTimer);
  aeonMarketTimer = setTimeout(async () => {
    await refreshAeonMarketPrices("timer");
    scheduleAeonMarketPoll();
  }, Math.max(10000, config.aeon.marketPollMs));
};

const scheduleAeonPositionMonitor = () => {
  clearTimeout(aeonPositionMonitorTimer);
  aeonPositionMonitorTimer = setTimeout(async () => {
    const state = aeonStore.read();
    if (state.running && (state.positionLots?.AEON || []).length) await aeonCycle("position-monitor");
    scheduleAeonPositionMonitor();
  }, Math.max(15000, config.aeon.positionMonitorMs));
};

// ---------------------------------------------------------------------------
// Maker rotation module — X Layer RWA, one token, strict buy/sell alternation.
// Modeled on the top-200 leaderboard pattern: short-life limit triggers around
// mid, inventory neutral, small spread capture per round trip.
// ---------------------------------------------------------------------------
const makerStore = new MemoryStore(new URL("../data/state-maker.json", import.meta.url), "MAKER_");
let makerCycleBusy = false;
let makerTimer = null;

const makerTokenAddress = config.maker.tokenAddress;
const makerQuoteAddress = config.maker.quoteAddress;
const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

async function analyzeMakerKlineTrend() {
  const { payload } = await runOnchainos([
    "market", "kline", "--address", config.maker.tokenAddress,
    "--chain", "xlayer", "--bar", "15m", "--limit", "48"
  ]);
  const candles = (payload?.data || [])
    .filter(c => Number(c.confirm) === 1)
    .slice(0, 48)
    .reverse() // API returns newest-first; indicators need oldest -> newest
    .map(c => ({ o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), t: Number(c.ts) }));
  const analysis = analyzeStabilization(candles);
  if (!analysis.ok) return { ok: false, reason: analysis.reason };
  return {
    ok: true,
    stable: analysis.stable,
    favorable: analysis.stable,
    score: analysis.score,
    total: analysis.total,
    reasons: analysis.reasons,
    metrics: analysis.metrics,
    trendBps: Number(analysis.metrics.ema8SlopeBps || 0),
    rangeBps: Number(analysis.metrics.bollingerWidthBps || 0)
  };
}

async function analyzeMakerMarket(tokenAddress = config.maker.tokenAddress) {
  const { payload } = await runOnchainos([
    "market", "kline", "--address", tokenAddress,
    "--chain", "xlayer", "--bar", "15m", "--limit", "48"
  ]);
  const candles = (payload?.data || [])
    .filter(c => Number(c.confirm) === 1)
    .slice(0, 48)
    .reverse()
    .map(c => ({ o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), t: Number(c.ts) }));
  const stable = analyzeStabilization(candles);
  const downtrend = analyzeDowntrend(candles);
  if (!stable.ok || !downtrend.ok) {
    return { ok: false, reason: stable.ok ? downtrend.reason : stable.reason };
  }
  return {
    ok: true,
    stable: stable.stable,
    stableScore: stable.score,
    downtrend: downtrend.confirmed,
    downtrendScore: downtrend.score,
    total: 5,
    reasons: [...downtrend.reasons, ...stable.reasons].slice(0, 6),
    metrics: { ...downtrend.metrics, bollingerWidthBps: stable.metrics.bollingerWidthBps }
  };
}

async function fetchTokenPrice(tokenAddress) {
  const { payload } = await runOnchainos(["market", "price", "--address", tokenAddress, "--chain", "xlayer"]);
  if (!payload?.ok) throw new Error(payload?.error || "price fetch failed");
  const data = payload?.data;
  if (Array.isArray(data)) {
    const item = data[0];
    if (item && typeof item === "object") return Number(item.price || item.lastPrice || 0);
    return 0;
  }
  if (data && typeof data === "object") return Number(data.price || data.lastPrice || 0);
  return 0;
}

// The wallet-balance endpoint can over-report the native OKB balance (it has
// disagreed with the real on-chain balance). For grid inventory we query the
// authoritative token-balances endpoint (196: = native token) instead.
async function fetchNativeTokenBalance(address) {
  const { payload } = await runOnchainos([
    "portfolio", "token-balances", "--chain", "xlayer",
    "--address", address, "--tokens", "196:"
  ]);
  const assets = payload?.data?.[0]?.tokenAssets || [];
  const native = assets.find(a => !a.tokenContractAddress && String(a.symbol || "").toUpperCase() === "OKB") || assets[0];
  return Number(native?.balance || 0);
}

// The grid books sells at the theoretical +profit price, but the actual fill
// can differ (OKB price feed occasionally reads higher than the DEX price,
// triggering early executions). For the OKB grid we book the most recent real
// on-chain sell price from this wallet instead.
async function fetchLastSellPrice(tokenAddress, walletAddress) {
  const { payload } = await runOnchainos([
    "token", "trades", "--address", tokenAddress, "--chain", "xlayer",
    "--wallet-filter", walletAddress, "--limit", "5"
  ]);
  const trades = payload?.data || [];
  const sell = trades.find(t => String(t.type || "").toLowerCase() === "sell");
  return sell ? Number(sell.price || 0) : 0;
}

async function makerCancelActiveOrder() {
  const state = makerStore.read();
  const ids = [];
  if (state.activeOrderId) ids.push(state.activeOrderId);
  for (const ao of (state.grid?.activeOrders || [])) ids.push(ao.orderId);
  for (const id of [...new Set(ids)]) {
    try { await makerCancelOrder(id); } catch (error) {
      makerStore.log(`撤单失败：${error.message}`, "warn");
    }
  }
  makerStore.update({
    activeOrderId: null, placedAt: null, triggerPrice: null,
    grid: state.grid ? { ...state.grid, activeOrders: [] } : state.grid
  });
}

async function makerCloseAllPositions(wallet, snapshot, reason, inventoryUnits) {
  const state = makerStore.read();
  inventoryUnits = Number(inventoryUnits ?? state.inventoryUnits ?? 0);
  if (inventoryUnits <= 0) {
    makerStore.update({ grid: state.grid ? { ...state.grid, positions: [] } : state.grid });
    makerStore.log(`行情下跌：无持仓可平（${reason}）`, "warn");
    return false;
  }
  const price = Number(state.lastDecision?.price || snapshot?.prices?.[config.maker.token] || 0);
  const exitExecutor = new AgenticWalletExecutor({
    enabled: true, walletAddress: wallet.evmAddress,
    tokens: { [config.maker.token]: config.maker.tokenAddress },
    maxSlippageBps: config.maker.exitMaxSlippageBps,
    chain: "xlayer"
  });
  const plan = {
    action: "SELL", token: config.maker.token, quoteToken: "USDT",
    amountToken: inventoryUnits, amountUsd: inventoryUnits * price,
    maxSlippageBps: config.maker.exitMaxSlippageBps
  };
  const quote = await exitExecutor.quote(plan, snapshot);
  const exec = await exitExecutor.execute(plan, snapshot, quote);
  if (exec.status === "BROADCAST") {
    makerStore.update({
      inventoryUnits: 0,
      costBasisUsd: 0,
      grid: state.grid ? { ...state.grid, positions: [] } : state.grid
    });
    makerStore.log(`行情下跌平仓：卖出 ${inventoryUnits.toFixed(6)} ${config.maker.token} — ${exec.txHash}（${reason}）`, "warn");
    return true;
  }
  if (exec.status === "CONFIRMING") {
    makerStore.update({
      running: false, stopReason: "market_downtrend",
      pendingConfirmation: { at: new Date().toISOString(), plan, quote, message: exec.message, next: exec.next }
    });
    makerStore.log(`平仓需钱包确认：${exec.message}`, "warn");
    return true;
  }
  makerStore.log(`平仓失败（${exec.status || "unknown"}）：${exec.message || exec.error || "无明细"}`, "error");
  return false;
}

async function tuneGridSpacing(tokenAddress = config.maker.tokenAddress) {
  let atrBps = 0;
  let bbBps = 0;
  try {
    const market = await analyzeMakerMarket(tokenAddress);
    if (market.ok) {
      atrBps = Number(market.metrics.atrBps || 0);
      bbBps = Number(market.metrics.bollingerWidthBps || 0);
    }
  } catch { /* keep defaults */ }
  let spacingBps = Number(config.maker.gridSpacingBps);
  let source = "rule";
  if (config.maker.gridAiTuning && config.deepseek.apiKey) {
    try {
      const response = await fetch(`${config.deepseek.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.deepseek.apiKey}` },
        body: JSON.stringify({
          model: config.deepseek.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "你是网格交易参数调优器。根据市场波动指标输出 JSON：{\"spacingBps\":30-60,\"action\":\"widen\"|\"narrow\"|\"hold\"}。高波动时加宽间距（约+20bps），低波动时缩小。只输出 JSON。"
            },
            { role: "user", content: JSON.stringify({ atrBps, bollingerWidthBps: bbBps, currentSpacingBps: config.maker.gridSpacingBps }) }
          ]
        })
      });
      if (response.ok) {
        const payload = await response.json();
        const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
        const value = Number(parsed.spacingBps);
        if (Number.isFinite(value)) {
          spacingBps = Math.max(30, Math.min(60, Math.round(value)));
          source = "ai";
        }
      }
    } catch { /* fall back to rule */ }
  }
  if (source === "rule" && atrBps > 0) {
    const adjustment = Math.round((atrBps - 150) / 20) * 10;
    spacingBps = Math.max(30, Math.min(60, spacingBps + adjustment));
  }
  return { spacingBps, atrBps, bbBps, source };
}

async function makerGridCycle({
  wallet, snapshot, price, usdtBalanceUsd, inventoryUnits, buysPaused,
  token = config.maker.token,
  tokenAddress = config.maker.tokenAddress,
  gridKey = "grid",
  deployPct = config.maker.gridDeployPct,
  count = config.maker.gridLevels,
  spacingBps = config.maker.gridSpacingBps,
  profitBps = config.maker.gridProfitBps,
  aiTuning = true,
  feeRate = gridKey === "grid" ? config.maker.gridFeeRate : config.maker.extraGridFeeRate,
  gasUsd = gridKey === "grid" ? config.maker.gridGasUsd : config.maker.extraGridGasUsd
}) {
  const realizedKey = gridKey === "grid" ? "realizedPnlUsd" : "realizedPnlBtcUsd";
  const lossStreakKey = gridKey === "grid" ? "lossStreak" : "lossStreakBtc";
  let grid = makerStore.read()[gridKey];
  let state = makerStore.read();
  // 0. Per-token price-jump guard: skip order placement on a suspicious tick.
  const lastGridPrice = Number(grid?.lastPrice || price);
  const priceJumpBps = lastGridPrice > 0 ? Math.abs(price / lastGridPrice - 1) * 10000 : 0;
  const gridJumpPaused = priceJumpBps > config.maker.priceJumpGuardBps;
  if (gridJumpPaused) buysPaused = true;

  // 1. Initialize the grid on first run / after recovery.
  if (!grid?.levels?.length) {
    const built = allocateLevelUsd(buildGrid({
      mid: price,
      spacingBps,
      profitBps,
      count
    }), usdtBalanceUsd * deployPct / 100, config.maker.gridLadderMax);
    grid = { ...built, positions: [], activeOrders: [], initializedAt: Date.now(), lastAiTuneAt: 0, lastPrice: price };
    makerStore.update({ [gridKey]: grid });
    makerStore.log(`${token} 网格初始化：${count} 格 × ${spacingBps}bps 间距 / +${profitBps}bps 止盈，部署 $${built.levels.reduce((s, l) => s + l.buyUsd, 0).toFixed(0)}`, "info");
  }
  grid = makerStore.read()[gridKey];
  if (!grid?.levels?.length) {
    makerStore.log(`${token} 网格初始化失败：无有效价格`, "error");
    return;
  }

  let positions = grid.positions || [];
  let realizedPnlUsd = Number(state[realizedKey] || 0);
  let lossStreak = Number(state[lossStreakKey] || 0);

  // 2. Fill detection via wallet balance delta.
  const expectedUnits = gridTotals(positions).units;
  const delta = inventoryUnits - expectedUnits;
  if (Math.abs(delta) > 1e-9) {
    if (delta > 0) {
      const { fills } = attributeBuys(grid.levels, positions, delta);
      for (const fill of fills) {
        const level = grid.levels.find(l => l.level === fill.level);
        if (!level) continue;
        positions.push({
          level: fill.level, units: fill.units, price: fill.price,
          sellPrice: level.sellPrice, costUsd: fill.units * fill.price * (1 + feeRate),
          filledAt: new Date().toISOString()
        });
        makerStore.log(`${token} 网格买入 第${fill.level}格 ${fill.units.toFixed(6)} @ $${fill.price.toFixed(4)}`, "info");
      }
      makerStore.update({
        [gridKey]: { ...grid, positions, lastPrice: price },
        trades: [
          ...fills.map(f => ({ at: new Date().toISOString(), kind: "BUY", units: f.units, price: f.price, pnlUsd: null, token })),
          ...(makerStore.read().trades || [])
        ].slice(0, 500)
      });
    } else {
      const { sells } = attributeSells(positions, -delta);
      const pricedSells = [];
      for (const sale of sells) {
        let sellPrice = sale.price;
        if (gridKey === "gridBtc") {
          try {
            const real = await fetchLastSellPrice(tokenAddress, wallet.evmAddress);
            if (real > 0) sellPrice = real;
          } catch { /* keep grid price */ }
        }
        pricedSells.push({ ...sale, price: sellPrice });
      }
      let remaining = -delta;
      for (const sale of pricedSells) {
        const proceeds = sale.units * sale.price * (1 - feeRate);
        const pnl = proceeds - sale.costUsd - gasUsd;
        realizedPnlUsd += pnl;
        lossStreak = pnl < 0 ? lossStreak + 1 : 0;
        makerStore.log(`${token} 网格卖出 第${sale.level}格 ${sale.units.toFixed(6)} @ $${sale.price.toFixed(4)}，pnl $${pnl.toFixed(4)}`, "info");
      }
      positions = [...positions]
        .sort((a, b) => a.sellPrice - b.sellPrice)
        .map(p => {
          if (remaining <= 0) return p;
          const take = Math.min(remaining, p.units);
          const unitCost = p.units > 0 ? p.costUsd / p.units : 0;
          remaining -= take;
          return { ...p, units: p.units - take, costUsd: p.costUsd - take * unitCost };
        })
        .filter(p => p.units > 1e-9);
      makerStore.update({
        [realizedKey]: realizedPnlUsd,
        [lossStreakKey]: lossStreak,
        [gridKey]: { ...grid, positions, lastPrice: price },
        trades: [
          ...pricedSells.map(s => ({ at: new Date().toISOString(), kind: "SELL", units: s.units, price: s.price, pnlUsd: s.units * s.price * (1 - feeRate) - s.costUsd - gasUsd, token })),
          ...(makerStore.read().trades || [])
        ].slice(0, 500)
      });
    }
    grid = makerStore.read()[gridKey];
    positions = grid.positions;
  }

  // Dust cleanup: positions too small to place a strategy sell order (below the
  // exchange minimum) are sold at market via a direct swap; the next cycle's
  // balance-delta detection books the realized PnL and removes the position.
  const minOrderNotionalUsd = 1.0;
  const dustNow = Date.now();
  for (const pos of positions) {
    if (pos.units * pos.sellPrice >= minOrderNotionalUsd) continue;
    if (dustNow - Number(pos.dustSellAt || 0) < 60000) continue;
    try {
      const dustExecutor = new AgenticWalletExecutor({
        enabled: true, walletAddress: wallet.evmAddress,
        tokens: { [token]: tokenAddress },
        maxSlippageBps: config.maker.exitMaxSlippageBps,
        chain: "xlayer"
      });
      const plan = {
        action: "SELL", token, quoteToken: "USDT",
        amountToken: pos.units, amountUsd: pos.units * pos.sellPrice,
        maxSlippageBps: config.maker.exitMaxSlippageBps
      };
      const quote = await dustExecutor.quote(plan, snapshot);
      const exec = await dustExecutor.execute(plan, snapshot, quote);
      if (exec.status === "BROADCAST") {
        makerStore.log(`${token} 清灰卖出 第${pos.level}格 残留 ${pos.units.toFixed(6)} — ${exec.txHash}`, "warn");
      } else if (exec.status === "CONFIRMING") {
        makerStore.log(`清灰需钱包确认：${exec.message}`, "warn");
      } else {
        makerStore.log(`清灰失败（${exec.status || "unknown"}）：${exec.message || exec.error || "无明细"}`, "warn");
      }
      positions = positions.map(p => p.level === pos.level ? { ...p, dustSellAt: dustNow } : p);
    } catch (error) {
      makerStore.log(`清灰异常：${error.message}`, "warn");
      positions = positions.map(p => p.level === pos.level ? { ...p, dustSellAt: dustNow } : p);
    }
  }
  if (positions.some(p => p.dustSellAt)) {
    makerStore.update({ [gridKey]: { ...grid, positions, lastPrice: price } });
    grid = makerStore.read()[gridKey];
    positions = grid.positions;
  }

  // Re-anchor the grid to the current price when flat (no inventory), so the
  // buy levels track the market instead of being stuck at a stale anchor.
  // Old resting buy orders are cancelled; the order-sync step re-places them
  // at the new levels.
  const flat = positions.length === 0;
  if (flat && Math.abs(price / grid.mid - 1) > config.maker.gridReanchorBps / 10000) {
    const oldMid = grid.mid;
    for (const ao of (grid.activeOrders || []).filter(o => o.side === "buy")) {
      try { await makerCancelOrder(ao.orderId); } catch { /* ignore */ }
    }
    const deployedUsd = grid.levels.reduce((sum, l) => sum + l.buyUsd, 0);
    const rebuilt = allocateLevelUsd(buildGrid({
      mid: price,
      spacingBps: grid.spacingBps,
      profitBps,
      count
    }), deployedUsd, config.maker.gridLadderMax);
    grid = {
      ...grid,
      mid: price,
      levels: rebuilt.levels,
      activeOrders: (grid.activeOrders || []).filter(o => o.side === "sell")
    };
    makerStore.update({ [gridKey]: grid });
    makerStore.log(`${token} 网格锚点跟随：mid $${price.toFixed(2)}（原 $${oldMid.toFixed(2)}）`, "info");
  }

  // 3. Hourly AI / volatility spacing tuning; rebuild unfilled buy levels.
  if (aiTuning && config.maker.gridAiTuning && Date.now() - Number(grid.lastAiTuneAt || 0) >= config.maker.gridAiIntervalMs) {
    const tune = await tuneGridSpacing(tokenAddress);
    if (tune.spacingBps !== grid.spacingBps) {
      const deployedUsd = grid.levels.reduce((sum, l) => sum + l.buyUsd, 0);
      const rebuilt = allocateLevelUsd(buildGrid({
        mid: grid.mid,
        spacingBps: tune.spacingBps,
        profitBps,
        count
      }), deployedUsd);
      const sellOrders = (grid.activeOrders || []).filter(ao => ao.side === "sell");
      for (const ao of (grid.activeOrders || []).filter(ao => ao.side === "buy")) {
        try { await makerCancelOrder(ao.orderId); } catch { /* ignore */ }
      }
      grid = { ...grid, spacingBps: tune.spacingBps, levels: rebuilt.levels, activeOrders: sellOrders, lastAiTuneAt: Date.now() };
      makerStore.update({ [gridKey]: grid });
      makerStore.log(`${token} 网格间距调整：${tune.spacingBps}bps（ATR ${tune.atrBps}bps / 布林 ${tune.bbBps}bps，来源 ${tune.source}）`, "info");
    } else {
      makerStore.update({ [gridKey]: { ...grid, lastAiTuneAt: Date.now() } });
    }
    grid = makerStore.read()[gridKey];
  }

  // 4. Order management: sync resting limit orders with the grid.
  let openOrders = [];
  try { openOrders = await makerListOrders(); } catch (error) {
    makerStore.log(`${token} 网格订单列表失败：${error.message}`, "warn");
  }
  // Scope order management to this grid's token only, so multiple grids
  // (NVDAx + BTC) never cancel each other's resting orders.
  const tokenLow = String(tokenAddress).toLowerCase();
  const tokenOrders = openOrders.filter(o => {
    const from = String(o?.fromToken?.tokenContractAddress || o?.fromToken?.address || "").toLowerCase();
    const to = String(o?.toToken?.tokenContractAddress || o?.toToken?.address || "").toLowerCase();
    return from === tokenLow || to === tokenLow;
  });
  // Manual orders placed by the user on this grid's token must never be
  // cancelled or expired by the bot; they are excluded from orphan cleanup,
  // TTL rotation and order sync (but still counted as resting exposure).
  const manualOrderIds = new Set((config.maker.extraGridManualOrderIds || []).map(String));
  const botTokenOrders = tokenOrders.filter(o => !manualOrderIds.has(String(o.orderId)));
  const placedIds = new Set((makerStore.read().placedOrderIds || []).map(String));
  let activeOrders = (grid.activeOrders || []).filter(ao => botTokenOrders.some(o => String(o.orderId) === String(ao.orderId)));
  // Clean up orphan orders for this token that are not tracked by the grid
  // (they can accumulate after network drops / failed state writes and would
  // double-fill if the price crosses their levels). Only bot-created orders
  // are eligible; anything the user placed manually is left untouched.
  const trackedIds = new Set(activeOrders.map(ao => String(ao.orderId)));
  for (const open of botTokenOrders) {
    if (!trackedIds.has(String(open.orderId)) && placedIds.has(String(open.orderId))) {
      try { await makerCancelOrder(open.orderId); } catch { /* ignore */ }
      makerStore.log(`${token} 清理孤儿挂单 ${String(open.orderId).slice(-8)}`, "warn");
    }
  }
  for (const ao of [...activeOrders]) {
    if (Date.now() - Number(ao.placedAt || 0) > config.maker.gridOrderTtlMs) {
      try { await makerCancelOrder(ao.orderId); } catch { /* ignore */ }
      activeOrders = activeOrders.filter(x => x.orderId !== ao.orderId);
      makerStore.log(`${token} 网格订单过期撤单 第${ao.level}格（${ao.side}）`, "warn");
    }
  }
  const wanted = nextOrders({ levels: grid.levels, positions, activeOrders, buysPaused });
  for (const order of wanted) {
    try {
      // Sells: always derive a take-profit order (trigger > current), never a
      // stop. The OKB/NVDAx price feed occasionally reads above the DEX price;
      // if current >= trigger the backend can treat the sell as an
      // already-triggered stop and market-sell below the target. Clamping the
      // passed current-price below the trigger keeps the order resting as a
      // take-profit so it fills only when the price actually reaches it.
      const orderCurrentPrice = order.side === "sell"
        ? Math.min(price, order.price * 0.995)
        : price;
      if (order.side === "sell" && price >= order.price) {
        makerStore.log(`${token} 卖出止盈单（价格源 $${price.toFixed(4)} ≥ 止盈 $${order.price.toFixed(4)}，按止盈单挂出）`, "info");
      }
      const orderId = await makerCreateOrder({
        direction: order.side,
        fromToken: order.side === "buy" ? makerQuoteAddress : tokenAddress,
        toToken: order.side === "buy" ? tokenAddress : makerQuoteAddress,
        amount: order.side === "buy"
          ? Math.round(order.amountUsd * 1e6) / 1e6
          : Number(order.amountToken.toFixed(10)),
        triggerPrice: order.price,
        currentPrice: orderCurrentPrice
      });
      activeOrders.push({ orderId, side: order.side, level: order.level, placedAt: Date.now(), price: order.price });
      makerStore.log(`${token} 网格${order.side === "buy" ? "买入" : "卖出"}挂单 第${order.level}格 @ $${order.price.toFixed(4)}`, "info");
    } catch (error) {
      makerStore.log(`${token} 网格挂单失败：${error.message}`, "warn");
    }
  }
  makerStore.update({ [gridKey]: { ...grid, positions, activeOrders, lastPrice: price } });

  // 5. Circuit breakers.
  if (lossStreak >= config.maker.lossStreakLimit) {
    if (Date.now() >= Number(state.cooldownUntil || 0)) {
      makerStore.update({
        cooldownUntil: Date.now() + config.maker.cooldownMinutes * 60000,
        cooldownActive: true,
        klineCheckAt: Date.now() + config.maker.klineCheckMs
      });
      makerStore.log(`${token} 网格连亏 ${config.maker.lossStreakLimit} 轮 — 暂停 ${config.maker.cooldownMinutes} 分钟（K线企稳监测中）`, "warn");
    }
    lossStreak = 0;
    makerStore.update({ [lossStreakKey]: lossStreak });
  }
  const totalRealizedUsd = Number(state.realizedPnlUsd || 0) + Number(state.realizedPnlBtcUsd || 0);
  if (totalRealizedUsd <= -config.maker.maxLossUsd) {
    makerStore.update({
      running: false,
      stopReason: "breaker_max_loss",
      breakerNextCheckAt: Date.now() + config.maker.breakerCheckMs
    });
    makerStore.log(`网格硬止损：累计亏损 $${totalRealizedUsd.toFixed(2)}（${token}）触发 -$${config.maker.maxLossUsd} — 停机等待K线企稳`, "error");
    await maybeAutoResumeMaker("breaker");
  }
}

async function maybeAutoResumeMaker(trigger) {
  const state = makerStore.read();
  if (state.running || !["breaker_max_loss", "market_downtrend"].includes(state.stopReason)) return;
  if (!config.maker.breakerAutoResume) return;
  if (Date.now() < Number(state.breakerNextCheckAt || 0)) return;
  let market;
  try {
    market = await analyzeMakerMarket();
  } catch (error) {
    makerStore.log(`恢复检查失败：${error.message} — 稍后重试`, "warn");
    makerStore.update({ breakerNextCheckAt: Date.now() + config.maker.breakerCheckMs });
    return;
  }
  if (market.ok && market.stable && !market.downtrend) {
    makerStore.update({
      running: true,
      realizedPnlUsd: 0,
      realizedPnlBtcUsd: 0,
      lossStreak: 0,
      lossStreakBtc: 0,
      cooldownUntil: 0,
      stopReason: null,
      breakerNextCheckAt: 0
    });
    makerStore.log(`行情符合策略（企稳 ${market.stableScore}/${market.total}、无下跌确认）— 恢复交易（${trigger}）`, "info");
  } else {
    makerStore.update({ breakerNextCheckAt: Date.now() + config.maker.breakerCheckMs });
    makerStore.log(`仍不满足恢复条件（${market.ok ? `企稳 ${market.stableScore}/${market.total}、下跌确认 ${market.downtrendScore}/${market.total}` : market.reason}）— ${Math.round(config.maker.breakerCheckMs / 60000)} 分钟后复查`, "warn");
  }
}

async function makerListOrders() {
  const { payload } = await runOnchainos(["strategy", "list", "--chain", "xlayer"]);
  if (!payload?.ok) throw new Error(payload?.error || "strategy list failed");
  return payload.data?.list || [];
}

async function makerCreateOrder({ direction, amount, triggerPrice, currentPrice, fromToken, toToken }) {
  const { payload } = await runOnchainos([
    "strategy", "create-limit", "--chain-id", "xlayer",
    "--from-token", fromToken, "--to-token", toToken,
    "--amount", String(amount), "--trigger-price", String(triggerPrice),
    "--direction", direction, "--current-price", String(currentPrice)
  ]);
  if (!payload?.ok) throw new Error(payload?.error || JSON.stringify(payload?.data || "create-limit failed"));
  if (payload.data?.belowMinimum) throw new Error(`order below minimum (min ${payload.data.minFromAmount})`);
  const orderId = String(payload.data.orderId);
  // Ledger of orders created by the bot itself. Orphan cleanup only cancels
  // orders that appear here, so manual user orders on the same token are
  // never auto-cancelled.
  const placed = makerStore.read().placedOrderIds || [];
  makerStore.update({ placedOrderIds: [...placed, orderId].slice(-300) });
  return orderId;
}

async function makerCancelOrder(orderId) {
  const { payload } = await runOnchainos(["strategy", "cancel", "--chain", "xlayer", "--order-id", String(orderId)]);
  if (!payload?.ok) throw new Error(payload?.error || "strategy cancel failed");
  return payload.data;
}

async function makerCycle(trigger = "timer") {
  if (makerCycleBusy) return;
  if (!makerStore.read().running) {
    await maybeAutoResumeMaker(trigger);
    if (!makerStore.read().running) return;
  }
  makerCycleBusy = true;
  try {
    const [wallet, snapshot] = await Promise.all([
      readAgenticWalletStatus(),
      readOnchainSnapshot(true, "xlayer")
    ]);
    if (!wallet.connected || !wallet.evmAddress) throw new Error("Agentic Wallet is disconnected");
    const state = makerStore.read();
    const price = Number(snapshot.prices[config.maker.token] || 0);
    const usdtAsset = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === makerQuoteAddress);
    const tokenAsset = snapshot.wallet.assets.find(asset => asset.tokenAddress?.toLowerCase() === makerTokenAddress);
    const usdtBalanceUsd = Number(usdtAsset?.usdValue || usdtAsset?.balance || 0);
    const inventoryUnits = Number(tokenAsset?.balance || 0);
    const inventoryUsd = inventoryUnits * price;

    // Price-feed sanity guard: a single-cycle jump larger than the configured
    // threshold (with a recent anchor) usually means a stale/bad quote tick.
    // When flagged, the cycle refuses to place new orders.
    const lastPrice = Number(state.lastPrice || 0);
    const lastPriceAt = Number(state.lastPriceAt || 0);
    const priceJumpBps = lastPrice > 0 ? Math.abs(price / lastPrice - 1) * 10000 : 0;
    const priceJumpSuspicious = priceJumpBps > config.maker.priceJumpGuardBps
      && lastPriceAt > 0 && Date.now() - lastPriceAt < 30 * 60 * 1000;
    if (priceJumpSuspicious) {
      makerStore.log(`Price jump guard: ${lastPrice.toFixed(4)} -> ${price.toFixed(4)} (${priceJumpBps.toFixed(1)} bps)`, "warn");
    }

    // Downtrend guard: anchor to the price at the start of a rolling window;
    // if the price drops more than trendPauseBps below that anchor, block new
    // buys until the window re-anchors (or price recovers). Exits stay open.
    const trendWindowMs = Math.max(10000, config.maker.trendWindowMs);
    let trendAnchorPrice = Number(state.trendAnchorPrice || price);
    let trendAnchorAt = Number(state.trendAnchorAt || Date.now());
    if (Date.now() - trendAnchorAt >= trendWindowMs) {
      trendAnchorPrice = price;
      trendAnchorAt = Date.now();
    }
    const trendDropBps = trendAnchorPrice > 0 ? (trendAnchorPrice / price - 1) * 10000 : 0;
    const downtrendPaused = trendDropBps > config.maker.trendPauseBps;
    if (downtrendPaused && !state.downtrendPaused) {
      makerStore.log(`Downtrend guard: ${trendDropBps.toFixed(1)} bps below anchor ${trendAnchorPrice.toFixed(4)} — buy paused`, "warn");
    }

    // Regime gate: only open NEW positions when the token is range-bound
    // (low trend, moderate oscillation). Profitable leaderboard wallets trade
    // in short bursts only while such a window is open, then stop.
    const regimeHistory = [...(state.makerPriceHistory || []), { at: Date.now(), price }]
      .slice(-Math.max(60, Math.ceil(config.maker.regimeWindowMs / 10000)));
    const regimeWindowStart = Date.now() - config.maker.regimeWindowMs;
    const regimeWindow = regimeHistory.filter(p => Number(p.at) >= regimeWindowStart);
    let regimePaused = false;
    let regimeInfo = null;
    const regimePrices = regimeWindow.map(p => Number(p.price)).filter(p => p > 0);
    if (regimePrices.length >= config.maker.regimeMinSamples) {
      const first = regimePrices[0];
      const last = regimePrices[regimePrices.length - 1];
      const lo = Math.min(...regimePrices);
      const hi = Math.max(...regimePrices);
      const trendBps = first > 0 ? (last / first - 1) * 10000 : 0;
      const rangeBps = lo > 0 ? (hi / lo - 1) * 10000 : 0;
      const trendThreshold = config.maker.mode === "grid"
        ? config.maker.gridRegimeTrendBps
        : config.maker.regimeTrendBps;
      const rangeThreshold = config.maker.mode === "grid"
        ? config.maker.gridRegimeRangeMaxBps
        : config.maker.regimeRangeMaxBps;
      regimePaused = trendBps < -trendThreshold || rangeBps > rangeThreshold;
      regimeInfo = { samples: regimePrices.length, trendBps, rangeBps };
      if (regimePaused && !state.regimePaused) {
        makerStore.log(`Regime gate: trend ${trendBps.toFixed(1)}bps / range ${rangeBps.toFixed(1)}bps — buy paused`, "warn");
      }
    }

    const hourUtc = new Date().getUTCHours();
    const pauseWindow = config.maker.pauseStartUtc < config.maker.pauseEndUtc
      && hourUtc >= config.maker.pauseStartUtc && hourUtc < config.maker.pauseEndUtc;

    // Active order management: find it, then cancel on TTL or price drift.
    let activeOrder = null;
    if (state.activeOrderId) {
      try {
        const orders = await makerListOrders();
        activeOrder = orders.find(order => String(order.orderId) === String(state.activeOrderId)) || null;
      } catch (error) {
        makerStore.log(`Maker order list failed: ${error.message}`, "warn");
      }
    }
    if (activeOrder) {
      const verdict = shouldCancelMakerOrder({
        placedAt: state.placedAt,
        now: Date.now(),
        orderTtlMs: config.maker.orderTtlMs,
        price,
        triggerPrice: state.triggerPrice,
        priceDriftGuardBps: config.maker.priceDriftGuardBps
      });
      if (verdict.cancel) {
        try { await makerCancelOrder(activeOrder.orderId); } catch (error) {
          makerStore.log(`Maker cancel failed: ${error.message}`, "warn");
        }
        makerStore.update({ activeOrderId: null, placedAt: null, triggerPrice: null });
        makerStore.log(`Maker order ${activeOrder.orderId} cancelled (${verdict.stale ? "ttl" : "price drift"})`, "warn");
        activeOrder = null;
      }
    }

    // Fill detection through wallet balance deltas + cost-basis accounting.
    const prevInventoryUnits = Number(state.inventoryUnits || 0);
    const prevCostUsd = Number(state.costBasisUsd || 0);
    let costBasisUsd = prevCostUsd;
    let inventoryUnitsTracked = prevInventoryUnits;
    let nextInventorySince = Number(state.inventorySince || 0);
    let nextFastExitPending = Boolean(state.fastExitPending);
    let fill = null;
    let realizedPnlUsd = Number(state.realizedPnlUsd || 0);
    // Actual USDT balance at the previous cycle, used to derive real fill
    // prices instead of assuming the order trigger price was the fill price.
    const prevUsdtBalanceUsd = Number(state.lastUsdtBalanceUsd ?? usdtBalanceUsd);
    if (inventoryUnits > prevInventoryUnits + 1e-9) {
      const filled = inventoryUnits - prevInventoryUnits;
      const spentUsd = Math.max(0, prevUsdtBalanceUsd - usdtBalanceUsd);
      const fillPrice = spentUsd > 0.01 ? spentUsd / filled : price;
      costBasisUsd = prevCostUsd + filled * fillPrice;
      inventoryUnitsTracked = inventoryUnits;
      fill = { kind: "BUY", units: filled, price: fillPrice, costUsd: filled * fillPrice };
      if (prevInventoryUnits <= 1e-9 || !nextInventorySince) nextInventorySince = Date.now();
    } else if (inventoryUnits < prevInventoryUnits - 1e-9) {
      const sold = prevInventoryUnits - inventoryUnits;
      const unitCost = prevInventoryUnits > 0 ? prevCostUsd / prevInventoryUnits : 0;
      const receivedUsd = Math.max(0, usdtBalanceUsd - prevUsdtBalanceUsd);
      const sellPrice = receivedUsd > 0.01 ? receivedUsd / sold : price;
      const proceedsUsd = receivedUsd > 0.01 ? receivedUsd : sold * sellPrice;
      const pnlUsd = proceedsUsd - sold * unitCost;
      realizedPnlUsd += pnlUsd;
      costBasisUsd = Math.max(0, prevCostUsd - sold * unitCost);
      inventoryUnitsTracked = inventoryUnits;
      fill = { kind: "SELL", units: sold, price: sellPrice, proceedsUsd, pnlUsd };
      nextFastExitPending = false;
    } else {
      inventoryUnitsTracked = prevInventoryUnits;
      costBasisUsd = prevCostUsd;
    }
    // Bootstrap the hold timer after a restart: reuse the latest BUY fill time,
    // otherwise start the clock now.
    if (inventoryUnitsTracked > 1e-9 && !nextInventorySince) {
      const lastBuy = (makerStore.read().trades || []).find(trade => trade.kind === "BUY");
      nextInventorySince = lastBuy ? new Date(lastBuy.at).getTime() : Date.now();
    }

    // Circuit breakers.
    let lossStreak = Number(state.lossStreak || 0);
    if (fill?.kind === "SELL") lossStreak = fill.pnlUsd < 0 ? lossStreak + 1 : 0;
    if (lossStreak >= config.maker.lossStreakLimit) {
      // Only start the cool-down once; afterwards the local streak resets so the
      // later store update cannot re-arm it on every cycle.
      if (Number(state.cooldownUntil || 0) <= Date.now()) {
        makerStore.update({
          cooldownUntil: Date.now() + config.maker.cooldownMinutes * 60000,
          cooldownActive: true,
          klineCheckAt: Date.now() + config.maker.klineCheckMs
        });
        makerStore.log(`Maker paused ${config.maker.cooldownMinutes} min after ${config.maker.lossStreakLimit} losing round trips — monitoring K-line stabilization`, "warn");
      }
      lossStreak = 0;
    }
    const inCooldown = Number(state.cooldownUntil || 0) > Date.now();
    // During/after the cooldown, analyze the K-line every klineCheckMs and
    // resume as soon as short-term indicators show the market has stabilized.
    let cooldownBlock = inCooldown || state.cooldownActive === true;
    if (cooldownBlock) {
      if (Date.now() >= Number(state.klineCheckAt || 0)) {
        makerStore.update({ klineCheckAt: Date.now() + config.maker.klineCheckMs });
        let st;
        try { st = await analyzeMakerKlineTrend(); } catch (error) { st = { ok: false, reason: error.message }; }
        if (st.ok && st.stable) {
          makerStore.update({ cooldownUntil: 0, cooldownActive: false });
          makerStore.log(`K线企稳（${st.score}/${st.total}）— 提前恢复交易：${st.reasons.join("；")}`, "info");
          cooldownBlock = false;
        } else if (Date.now() >= Number(state.cooldownUntil || 0)) {
          makerStore.update({ cooldownUntil: Date.now() + config.maker.cooldownRecheckMs, cooldownActive: true });
          makerStore.log(`冷却期已到但K线未企稳（${st.ok ? `${st.score}/${st.total}` : st.reason}）— 继续等待 ${Math.round(config.maker.cooldownRecheckMs / 60000)} 分钟`, "warn");
        }
      }
    }
    if (realizedPnlUsd <= -config.maker.maxLossUsd) {
      makerStore.update({
        running: false,
        stopReason: "breaker_max_loss",
        breakerNextCheckAt: Date.now() + config.maker.breakerCheckMs
      });
      makerStore.log(`Maker stopped: realized loss $${realizedPnlUsd.toFixed(2)} breached $${config.maker.maxLossUsd} — K-line trend check scheduled`, "error");
      await maybeAutoResumeMaker("breaker");
      return;
    }

    // Market-level downtrend halt: on a confirmed short-term downtrend, stop
    // trading and liquidate inventory immediately. Recovery is handled by
    // maybeAutoResumeMaker once the K-line stabilizes and the trend clears.
    if (config.maker.marketHaltEnabled && !state.stopReason && Date.now() >= Number(state.marketCheckAt || 0)) {
      makerStore.update({ marketCheckAt: Date.now() + config.maker.klineCheckMs });
      const market = await analyzeMakerMarket();
      if (market.ok && market.downtrend) {
        makerStore.log(`行情下跌确认（${market.downtrendScore}/${market.total}）— 停止交易并平仓：${market.reasons.join("；")}`, "error");
        await makerCancelActiveOrder();
        await makerCloseAllPositions(wallet, snapshot, "market_downtrend", inventoryUnits);
        makerStore.update({
          running: false,
          stopReason: "market_downtrend",
          breakerNextCheckAt: Date.now() + config.maker.breakerCheckMs,
          cooldownUntil: 0,
          cooldownActive: false
        });
        return;
      }
    }

    // Grid mode: multi-level narrow grid market making (12 levels per side)
    // with the same protective layers (regime gate, market halt, cooldown,
    // hard stop + K-line stabilization recovery).
    if (config.maker.mode === "grid") {
      await makerGridCycle({
        wallet,
        snapshot,
        price,
        usdtBalanceUsd,
        inventoryUnits,
        buysPaused: cooldownBlock || regimePaused || downtrendPaused || priceJumpSuspicious
      });
      // Optional second grid (e.g. BTC) runs alongside the primary token.
      if (config.maker.extraGridToken && config.maker.extraGridAddress && config.maker.extraGridEnabled) {
        try {
          const extraPrice = await fetchTokenPrice(config.maker.extraGridAddress);
          const extraAddr = String(config.maker.extraGridAddress || "").toLowerCase();
          const extraAsset = (snapshot.wallet.assets || [])
            .find(a => String(a.tokenAddress || "").toLowerCase() === extraAddr)
            || (extraAddr === NATIVE_TOKEN_ADDRESS.toLowerCase()
              ? (snapshot.wallet.assets || []).find(a => !a.tokenAddress
                  && String(a.symbol || "").toUpperCase() === String(config.maker.extraGridToken).toUpperCase())
              : undefined);
          let extraUnits = Number(extraAsset?.balance || 0);
          // Native OKB doubles as the gas token: never treat the whole balance
          // as sellable inventory, and use the authoritative balance source.
          if (extraAddr === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
            try {
              extraUnits = Math.max(0, await fetchNativeTokenBalance(wallet.evmAddress) - config.maker.extraGridGasReserve);
            } catch (error) {
              extraUnits = Math.max(0, extraUnits - config.maker.extraGridGasReserve);
              makerStore.log(`OKB 余额接口失败，按钱包余额扣除 gas 储备：${error.message}`, "warn");
            }
          }
          if (extraPrice > 0) {
            await makerGridCycle({
              wallet,
              snapshot,
              price: extraPrice,
              usdtBalanceUsd,
              inventoryUnits: extraUnits,
              buysPaused: cooldownBlock || regimePaused || downtrendPaused,
              token: config.maker.extraGridToken,
              tokenAddress: config.maker.extraGridAddress,
              gridKey: "gridBtc",
              deployPct: config.maker.extraGridDeployPct,
              count: config.maker.extraGridLevels,
              spacingBps: config.maker.extraGridSpacingBps,
              profitBps: config.maker.extraGridProfitBps,
              aiTuning: false
            });
          }
        } catch (error) {
          makerStore.log(`BTC 网格异常：${error.message}`, "warn");
        }
      }
      return;
    }

    const decision = priceJumpSuspicious
      ? { action: "HOLD", reason: `price feed jump guard (${priceJumpBps.toFixed(1)} bps)` }
      : makerDecision({
          price,
          inventoryUnits,
          inventoryUsd,
          usdtBalanceUsd,
          activeOrder: Boolean(activeOrder) || cooldownBlock,
          pauseWindow,
          maxInventoryUsd: config.maker.maxInventoryUsd,
          legUsd: config.maker.legUsd,
          buyTriggerBps: config.maker.buyTriggerBps,
          sellTriggerBps: config.maker.sellTriggerBps,
          fastExitTriggerBps: config.maker.fastExitTriggerBps,
          stopLossBps: config.maker.stopLossBps,
          targetGainBps: config.maker.targetGainBps,
          inventorySince: nextInventorySince,
          now: Date.now(),
          maxHoldMs: config.maker.maxHoldMs,
          entryPrice: inventoryUnits > 0 ? costBasisUsd / inventoryUnits : 0,
          downtrendPaused,
          regimePaused
        });
    let orderInfo = null;
    if (decision.action === "BUY" && !activeOrder) {
      const orderId = await makerCreateOrder({
        direction: "buy", fromToken: makerQuoteAddress, toToken: makerTokenAddress,
        amount: decision.amountUsd, triggerPrice: decision.triggerPrice, currentPrice: price
      });
      makerStore.update({ activeOrderId: orderId, placedAt: Date.now(), triggerPrice: decision.triggerPrice, phase: "BUY" });
      orderInfo = { orderId, triggerPrice: decision.triggerPrice };
      makerStore.log(`Maker BUY ${orderId} @ $${decision.triggerPrice.toFixed(4)}`);
    } else if (decision.action === "SELL" && !activeOrder && decision.fastExit) {
      // Fast-exit / stop-loss legs use a direct market swap: a re-anchored
      // limit trigger keeps chasing the mid in a trending market and never
      // fills. A market exit guarantees inventory rotation.
      if (!nextFastExitPending) {
        const exitExecutor = new AgenticWalletExecutor({
          enabled: true, walletAddress: wallet.evmAddress,
          tokens: { [config.maker.token]: config.maker.tokenAddress },
          maxSlippageBps: config.maker.exitMaxSlippageBps,
          chain: "xlayer"
        });
        const exitPlan = {
          action: "SELL", token: config.maker.token, quoteToken: "USDT",
          amountToken: decision.amountToken, amountUsd: decision.amountUsd ?? inventoryUsd,
          maxSlippageBps: config.maker.exitMaxSlippageBps
        };
        const exitQuote = await exitExecutor.quote(exitPlan, snapshot);
        const exitExecution = await exitExecutor.execute(exitPlan, snapshot, exitQuote);
        if (exitExecution.status === "BROADCAST") {
          nextFastExitPending = true;
          orderInfo = { market: true, txHash: exitExecution.txHash, triggerPrice: null };
          makerStore.log(`Maker fast-exit market sell ${decision.amountToken.toFixed(6)} ${config.maker.token} — ${exitExecution.txHash}`);
        } else if (exitExecution.status === "CONFIRMING") {
          makerStore.update({ running: false, pendingConfirmation: { at: new Date().toISOString(), plan: exitPlan, quote: exitQuote, message: exitExecution.message, next: exitExecution.next } });
          makerStore.log(`Maker wallet confirmation required: ${exitExecution.message}`, "warn");
        } else {
          makerStore.log(`Maker fast-exit failed (${exitExecution.status || "unknown"}): ${exitExecution.message || exitExecution.error || "no error detail"}`, "error");
        }
      }
    } else if (decision.action === "SELL" && !activeOrder) {
      const orderId = await makerCreateOrder({
        direction: "sell", fromToken: makerTokenAddress, toToken: makerQuoteAddress,
        amount: decision.amountToken, triggerPrice: decision.triggerPrice, currentPrice: price
      });
      makerStore.update({ activeOrderId: orderId, placedAt: Date.now(), triggerPrice: decision.triggerPrice, phase: "SELL" });
      orderInfo = { orderId, triggerPrice: decision.triggerPrice };
      makerStore.log(`Maker SELL ${orderId} @ $${decision.triggerPrice.toFixed(4)}`);
    }

    const current = makerStore.read();
    makerStore.update({
      inventoryUnits: inventoryUnitsTracked,
      costBasisUsd,
      inventorySince: nextInventorySince,
      fastExitPending: nextFastExitPending,
      realizedPnlUsd,
      lossStreak,
      lastUsdtBalanceUsd: usdtBalanceUsd,
      lastPrice: price,
      lastPriceAt: Date.now(),
      trendAnchorPrice,
      trendAnchorAt,
      downtrendPaused,
      makerPriceHistory: regimeHistory,
      regimePaused,
      regimeInfo,
      lastDecision: {
        at: new Date().toISOString(),
        price,
        inventoryUnits,
        inventoryUsd,
        usdtBalanceUsd,
        pauseWindow,
        inCooldown,
        decision,
        orderInfo,
        activeOrderId: current.activeOrderId,
        trigger
      }
    });
    if (fill) {
      makerStore.update({
        trades: [
          { at: new Date().toISOString(), kind: fill.kind, units: fill.units, price: fill.price, pnlUsd: fill.pnlUsd ?? null, token: config.maker.token },
          ...(makerStore.read().trades || [])
        ].slice(0, 500)
      });
      makerStore.log(`Maker ${fill.kind} fill ${fill.units.toFixed(6)} @ $${fill.price.toFixed(4)}${fill.pnlUsd != null ? `, pnl $${fill.pnlUsd.toFixed(4)}` : ""}`);
    }
  } catch (error) {
    makerStore.log(`Maker cycle failed: ${error.message}`, "error");
    // BLOCK / confirmation are hard stops; "disconnected" is usually a
    // transient wallet-session refresh and should just retry next cycle.
    if (/BLOCK|confirmation/i.test(error.message)) makerStore.update({ running: false });
  } finally {
    makerCycleBusy = false;
  }
}

const scheduleMakerCycle = () => {
  clearTimeout(makerTimer);
  makerTimer = setTimeout(async () => {
    await makerCycle("timer");
    scheduleMakerCycle();
  }, Math.max(8000, config.maker.cycleMs));
};

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
          officialVolumeDeltaUsd: state.officialVolumeDeltaUsd,
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
    if (request.method === "GET" && url.pathname === "/api/aeon/status") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot(false, "bsc")
      ]);
      if (wallet.connected !== aeonStore.read().walletConnected) {
        aeonStore.update({
          walletConnected: wallet.connected,
          walletAddress: wallet.evmAddress
        });
        if (wallet.connected) aeonStore.log("AEON module: Agentic Wallet connected");
      }
      const state = aeonStore.read();
      return json(response, 200, {
        state,
        wallet,
        onchain,
        campaign: aeonCampaign,
        capabilities: {
          deepseekConfigured: aeonDeepseek.configured,
          autonomousConfigured: config.aeon.autonomousEnabled,
          agenticExecutionReady: config.aeon.autonomousEnabled
            && (state.attributionVerified || state.officialParticipationStatus === 2)
            && wallet.connected
        },
        risk: {
          maxTradeUsd: config.aeon.maxTradeUsd,
          maxExposureUsd: config.aeon.maxExposureUsd,
          entryDipBps: config.aeon.entryDipBps,
          exitGainBps: config.aeon.exitGainBps,
          stopLossBps: config.aeon.stopLossBps,
          maxGridLots: config.aeon.maxGridLots,
          maxOpenLots: config.aeon.maxOpenLots,
          minEntryNetEdgeBps: config.aeon.minEntryNetEdgeBps,
          minBidTrendBps: config.aeon.minBidTrendBps,
          minSellNetExitBps: config.aeon.minSellNetExitBps,
          maxRoundTripLossBps: config.aeon.maxRoundTripLossBps,
          maxSlippageBps: config.aeon.maxSlippageBps,
          maxGasPriceGwei: config.aeon.maxGasPriceGwei,
          maxGasCostUsdPerSwap: config.aeon.maxGasCostUsdPerSwap,
          minBroadcastIntervalMs: config.aeon.minBroadcastIntervalMs,
          maxLossUsd: config.aeon.maxLossUsd,
          maxCampaignCostsUsd: config.aeon.maxCampaignCostsUsd,
          targetVolumeUsd: config.aeon.targetVolumeUsd,
          baseCapitalUsd: config.risk.baseCapitalUsd
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/aeon/wallet/sync") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot(true, "bsc")
      ]);
      aeonStore.update({
        walletConnected: wallet.connected,
        walletAddress: wallet.evmAddress,
        walletAssetsUpdatedAt: onchain.fetchedAt || new Date().toISOString()
      });
      aeonStore.log("BNB Chain wallet assets synced");
      return json(response, 200, { wallet, onchain, state: aeonStore.read() });
    }
    if (request.method === "GET" && url.pathname === "/api/aeon/live") {
      const state = aeonStore.read();
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
          officialParticipationStatus: state.officialParticipationStatus,
          rank: state.rank,
          estimatedRewardUsd: state.estimatedRewardUsd,
          estimatedRewardTokens: state.estimatedRewardTokens,
          walletAssetsUpdatedAt: state.walletAssetsUpdatedAt,
          targetVolumeUsd: state.targetVolumeUsd,
          tradingCostsUsd: state.tradingCostsUsd,
          realizedPnlUsd: state.realizedPnlUsd,
          lastVolumeUpdatedAt: state.lastVolumeUpdatedAt,
          tradeCount: (state.trades || []).length,
          bscGasPriceGwei: state.bscGasPriceGwei,
          bscGasUsdPerSwap: state.bscGasUsdPerSwap,
          gasGateOpen: state.bscGasUsdPerSwap == null || Number(state.bscGasUsdPerSwap) <= config.aeon.maxGasCostUsdPerSwap
        },
        serverTime: new Date().toISOString()
      });
    }
    if (request.method === "POST" && url.pathname === "/api/aeon/boost/sync") {
      await syncAeonOfficialBoost("manual");
      return json(response, 200, { state: aeonStore.read() });
    }
    if (request.method === "GET" && url.pathname === "/api/aeon/leaderboard") {
      const state = aeonStore.read();
      const market = await readMarketPrices(false, "bsc");
      return json(response, 200, {
        leaderboard: state.leaderboard || [],
        myRankInfo: state.leaderboardMyRank || null,
        updatedAt: state.leaderboardUpdatedAt,
        aeonPriceUsd: Number(market.prices?.AEON || 0) || null
      });
    }
    if (request.method === "POST" && url.pathname === "/api/aeon/control") {
      const body = await readJson(request);
      if (!['start', 'pause', 'stop'].includes(body.action)) return json(response, 400, { error: "Invalid action" });
      const state = aeonStore.read();
      if (body.action === "start" && !state.attributionVerified && state.officialParticipationStatus !== 2) {
        aeonStore.log("AEON start blocked: competition registration is not confirmed", "warn");
        return json(response, 409, { error: "AEON 交易赛尚未确认报名，请先在 Boost 页面点击「立即参与」" });
      }
      aeonStore.update({ running: body.action === "start" });
      aeonStore.log(`AEON workflow ${body.action} requested`);
      if (body.action === "start") setImmediate(() => aeonCycle("manual-start"));
      return json(response, 200, { state: aeonStore.read() });
    }
    if (request.method === "POST" && url.pathname === "/api/aeon/cycle") {
      setImmediate(() => aeonCycle("manual-cycle"));
      return json(response, 202, { accepted: true });
    }
    if (request.method === "POST" && url.pathname === "/api/aeon/decision") {
      const state = aeonStore.read();
      const snapshot = await readOnchainSnapshot(false, "bsc");
      let aiPlan = null;
      if (aeonDeepseek.configured) {
        try {
          aiPlan = await aeonDeepseek.analyze({
            campaign: aeonCampaign,
            market: { tokens: { AEON: { price: Number(snapshot.prices.AEON || 0) } } },
            positions: state.positions,
            positionLots: state.positionLots,
            progress: { volumeUsd: state.boostVolumeUsd, targetVolumeUsd: state.targetVolumeUsd },
            attributionVerified: state.attributionVerified,
            limits: config.aeon
          });
        } catch (error) {
          aeonStore.log(`AEON DeepSeek fallback: ${error.message}`, "warn");
        }
      }
      const plan = aeonPlan(snapshot, state, aeonSettings, aiPlan);
      const risk = evaluateAeonRisk(plan, state, aeonSettings);
      const decision = { at: new Date().toISOString(), source: aiPlan ? "deepseek" : "deterministic", aiPlan, plan, risk };
      aeonStore.update({ lastDecision: decision });
      return json(response, 200, decision);
    }
    if (request.method === "GET" && url.pathname === "/api/maker/status") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot(false, "xlayer")
      ]);
      const state = makerStore.read();
      const grid = state.grid || {};
      const gridBtc = state.gridBtc || {};
      const allTrades = state.trades || [];
      const buildTokenPnl = (symbol, gridState, realizedKey) => {
        const positions = gridState?.positions || [];
        const lastPrice = Number(gridState?.lastPrice || 0);
        const unrealizedUsd = positions.reduce(
          (sum, p) => sum + Number(p.units || 0) * lastPrice - Number(p.costUsd || 0),
          0
        );
        const tokenTrades = allTrades.filter(t => t.token === symbol);
        const sells = tokenTrades.filter(t => t.kind === "SELL" && t.pnlUsd != null);
        const volumeUsd = tokenTrades.reduce((sum, t) => sum + Number(t.units || 0) * Number(t.price || 0) * 2, 0);
        const winRate = sells.length
          ? Math.round(sells.filter(t => t.pnlUsd > 0).length / sells.length * 1000) / 10
          : null;
        const realizedUsd = Number(state[realizedKey] || 0);
        return {
          symbol,
          realizedPnlUsd: Math.round(realizedUsd * 100) / 100,
          unrealizedUsd: Math.round(unrealizedUsd * 100) / 100,
          netUsd: Math.round((realizedUsd + unrealizedUsd) * 100) / 100,
          positions: positions.length,
          activeOrders: (gridState?.activeOrders || []).length,
          tradeCount: tokenTrades.length,
          volumeUsd: Math.round(volumeUsd),
          winRate
        };
      };
      const usRealized = Number(state.realizedPnlUsd || 0);
      const btcRealized = Number(state.realizedPnlBtcUsd || 0);
      const pnlByToken = {
        [config.maker.token]: buildTokenPnl(config.maker.token, grid, "realizedPnlUsd"),
        ...(config.maker.extraGridToken
          ? { [config.maker.extraGridToken]: buildTokenPnl(config.maker.extraGridToken, gridBtc, "realizedPnlBtcUsd") }
          : {}),
        total: {
          realizedPnlUsd: Math.round((usRealized + btcRealized) * 100) / 100,
          unrealizedUsd: Math.round(
            (buildTokenPnl(config.maker.token, grid, "realizedPnlUsd").unrealizedUsd
              + (config.maker.extraGridToken ? buildTokenPnl(config.maker.extraGridToken, gridBtc, "realizedPnlBtcUsd").unrealizedUsd : 0)) * 100
          ) / 100,
          netUsd: Math.round((usRealized + btcRealized
            + buildTokenPnl(config.maker.token, grid, "realizedPnlUsd").unrealizedUsd
            + (config.maker.extraGridToken ? buildTokenPnl(config.maker.extraGridToken, gridBtc, "realizedPnlBtcUsd").unrealizedUsd : 0)) * 100) / 100
        }
      };
      return json(response, 200, {
        state,
        wallet,
        onchain,
        pnlByToken,
        maker: {
          token: config.maker.token,
          tokenAddress: config.maker.tokenAddress,
          quoteAddress: config.maker.quoteAddress,
          legUsd: config.maker.legUsd,
          buyTriggerBps: config.maker.buyTriggerBps,
          sellTriggerBps: config.maker.sellTriggerBps,
          fastExitTriggerBps: config.maker.fastExitTriggerBps,
          stopLossBps: config.maker.stopLossBps,
          maxHoldMs: config.maker.maxHoldMs,
          exitMaxSlippageBps: config.maker.exitMaxSlippageBps,
          orderTtlMs: config.maker.orderTtlMs,
          maxInventoryUsd: config.maker.maxInventoryUsd,
          priceDriftGuardBps: config.maker.priceDriftGuardBps,
          pauseStartUtc: config.maker.pauseStartUtc,
          pauseEndUtc: config.maker.pauseEndUtc,
          maxLossUsd: config.maker.maxLossUsd,
          lossStreakLimit: config.maker.lossStreakLimit,
          cooldownMinutes: config.maker.cooldownMinutes
        },
        capabilities: {
          autonomousConfigured: config.maker.autonomousEnabled,
          agenticExecutionReady: config.maker.autonomousEnabled
            && (state.attributionVerified || store.read().attributionVerified)
            && wallet.connected
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/maker/live") {
      const state = makerStore.read();
      return json(response, 200, {
        state: {
          running: state.running,
          phase: state.phase,
          activeOrderId: state.activeOrderId,
          inventoryUnits: state.inventoryUnits,
          costBasisUsd: state.costBasisUsd,
          realizedPnlUsd: state.realizedPnlUsd,
          realizedPnlBtcUsd: state.realizedPnlBtcUsd,
          tradeCount: (state.trades || []).length,
          roundTrips: (state.trades || []).filter(trade => trade.kind === "SELL").length,
          lossStreak: state.lossStreak,
          lossStreakBtc: state.lossStreakBtc,
          cooldownUntil: state.cooldownUntil,
          lastDecisionAt: state.lastDecision?.at || null
        },
        serverTime: new Date().toISOString()
      });
    }
    if (request.method === "POST" && url.pathname === "/api/maker/control") {
      const body = await readJson(request);
      if (!['start', 'pause', 'stop'].includes(body.action)) return json(response, 400, { error: "Invalid action" });
      makerStore.update(body.action === "start"
        ? { running: true, cooldownUntil: 0, lossStreak: 0, cooldownActive: false, stopReason: null }
        : { running: false });
      makerStore.log(`Maker workflow ${body.action} requested`);
      if (body.action === "start") setImmediate(() => makerCycle("manual-start"));
      return json(response, 200, { state: makerStore.read() });
    }
    if (request.method === "POST" && url.pathname === "/api/maker/cycle") {
      setImmediate(() => makerCycle("manual-cycle"));
      return json(response, 202, { accepted: true });
    }

    if (request.method === "GET" && url.pathname === "/api/finance/summary") {
      const [wallet, onchain] = await Promise.all([
        readAgenticWalletStatus(),
        readOnchainSnapshot(false, "xlayer")
      ]);
      const maker = makerStore.read();
      const rwa = store.read();
      const aeon = aeonStore.read();

      const makerTokens = new Set([config.maker.token, config.maker.extraGridToken].filter(Boolean));
      const makerTrades = (maker.trades || []).filter(t => makerTokens.has(t.token));
      const makerSells = makerTrades.filter(t => t.kind === "SELL" && t.pnlUsd != null);
      const makerVolume = makerTrades.reduce((sum, t) => sum + Number(t.units || 0) * Number(t.price || 0), 0);
      const makerWins = makerSells.filter(t => t.pnlUsd > 0).length;
      const makerStarted = makerTrades.length ? makerTrades[makerTrades.length - 1].at : null;
      const makerPrice = Number(maker.lastDecision?.price || onchain?.prices?.[config.maker.token] || 0);
      const makerRealized = Number(maker.realizedPnlUsd || 0) + Number(maker.realizedPnlBtcUsd || 0);

      const rwaTrades = rwa.trades || [];
      const rwaSells = rwaTrades.filter(t => t.action === "SELL" && t.cashPnlUsd != null);
      const rwaWins = rwaSells.filter(t => t.cashPnlUsd > 0).length;

      const aeonTrades = aeon.trades || [];

      const projects = [
        {
          id: "maker",
          name: `Maker 做市（${config.maker.token}）`,
          chain: "X Layer",
          status: maker.running ? "运行中" : "已停止",
          startedAt: makerStarted,
          realizedPnlUsd: Number(makerRealized.toFixed(2)),
          moduleCounterUsd: Number(makerRealized.toFixed(2)),
          volumeUsd: Math.round(makerVolume),
          tradeCount: makerTrades.length,
          winRate: makerSells.length ? Math.round(makerWins / makerSells.length * 1000) / 10 : null,
          inventoryUsd: Math.round(Number(maker.inventoryUnits || 0) * makerPrice * 100) / 100,
          strategy: "双边限价轮转 + 区间闸门 + K线熔断自动恢复",
          note: maker.regimeInfo
            ? `区间闸门: 趋势 ${Number(maker.regimeInfo.trendBps || 0).toFixed(1)}bps / 波动 ${Number(maker.regimeInfo.rangeBps || 0).toFixed(1)}bps`
            : "区间闸门样本采集中"
        },
        {
          id: "rwa",
          name: "X Layer RWA 交易赛（旧策略）",
          chain: "X Layer",
          status: "已停止（官方同步中）",
          startedAt: null,
          realizedPnlUsd: Number(rwa.realizedPnlUsd || 0),
          volumeUsd: Math.round(Number(rwa.boostVolumeUsd || 0)),
          officialVolumeUsd: Math.round(Number(rwa.officialBoostVolumeUsd || 0)),
          tradeCount: rwaTrades.length,
          winRate: rwaSells.length ? Math.round(rwaWins / rwaSells.length * 1000) / 10 : null,
          rank: rwa.rank,
          estimatedRewardUsd: Number(rwa.estimatedRewardUsd || 0),
          strategy: "低位网格 / 均值回归（已停用）"
        },
        {
          id: "aeon",
          name: "AEON 交易赛",
          chain: "BNB Chain",
          status: "已停止",
          startedAt: null,
          realizedPnlUsd: Number(aeon.realizedPnlUsd || 0),
          volumeUsd: Math.round(Number(aeon.boostVolumeUsd || 0)),
          tradeCount: aeonTrades.length,
          strategy: "AEON 低价买入 / 反弹卖出（BSC）"
        },
        {
          id: "hackathon",
          name: "Build X AI Season 黑客松",
          chain: "X Layer 测试网",
          status: "已提交",
          realizedPnlUsd: 0,
          costUsd: 0,
          volumeUsd: 0,
          strategy: "OKXBoostAgent 参赛：测试网账本 + 演示页 + X 运营",
          note: "奖池最高 300K USDT；Liquidity Grant（AI-RWA 赛道）50K 目标；截止 8/21 23:59 UTC",
          links: {
            demo: "https://czs200000.github.io/okx-boost-agent/",
            github: "https://github.com/czs200000/okx-boost-agent",
            contract: "https://www.okx.com/web3/explorer/xlayer-test/address/0x53A35F8f5B1fcb5Dd7154216BC0ad892FbaB8B6e"
          }
        }
      ];

      const walletTotalUsd = Number(onchain?.wallet?.totalValueUsd || 0);
      const baseCapitalUsd = Number(config.risk.baseCapitalUsd || 0);
      return json(response, 200, {
        summary: {
          walletTotalUsd: Math.round(walletTotalUsd * 100) / 100,
          baseCapitalUsd: Math.round(baseCapitalUsd * 100) / 100,
          netPnlUsd: Math.round((walletTotalUsd - baseCapitalUsd) * 100) / 100,
          realizedProjectsUsd: Math.round(projects.reduce((s, p) => s + Number(p.realizedPnlUsd || 0), 0) * 100) / 100,
          activeProjects: projects.filter(p => p.status === "运行中").length,
          generatedAt: new Date().toISOString()
        },
        projects,
        wallet: {
          assets: (onchain?.wallet?.assets || []).map(a => ({ symbol: a.symbol, balance: a.balance, usdValue: Number(a.usdValue || 0) })),
          updatedAt: onchain?.fetchedAt || null
        }
      });
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = pathname.replace(/\.\./g, "");
    const body = await readFile(join(root, safePath));
    response.writeHead(200, {
      "content-type": mime[extname(safePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(response, 404, { error: "Not found" });
    console.error(error);
    json(response, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`OKX Boost workflow dashboard: http://127.0.0.1:${config.port}`);
  const accounting = reconcileTradeAccounting(store.read().trades);
  store.update({
    realizedPnlUsd: accounting.realizedPnlUsd,
    dailyPnlUsd: accounting.realizedPnlUsd,
    tradingCostsUsd: Math.max(0, -accounting.realizedPnlUsd)
  });
  store.log(`Trade accounting reconciled from ${accounting.matchedCloses} matched exits`);
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
  if (config.aeon.enabled) {
    setImmediate(() => refreshAeonMarketPrices("startup"));
    setImmediate(() => syncAeonOfficialBoost("startup"));
    if (config.aeon.autonomousEnabled) {
      const aeonState = aeonStore.read();
      if (aeonState.attributionVerified || aeonState.officialParticipationStatus === 2) {
        aeonStore.update({ running: true, mode: "agentic" });
        aeonStore.log("AEON autonomous execution enabled — participation confirmed");
        setImmediate(() => aeonCycle("startup"));
      } else {
        aeonStore.log("AEON module ready — waiting for competition registration confirmation before trading");
      }
    }
    scheduleAeonDecisionCycle();
    scheduleAeonMarketPoll();
    scheduleAeonPositionMonitor();
    setInterval(() => syncAeonOfficialBoost("timer"), 60 * 1000);
  }
  if (config.maker.enabled) {
    const makerState = makerStore.read();
    if (config.maker.autonomousEnabled && (makerState.attributionVerified || store.read().attributionVerified)) {
      makerStore.update({ running: true });
      makerStore.log(`Maker rotation enabled — ${config.maker.token} limit-order market making`);
      setImmediate(() => makerCycle("startup"));
    } else {
      makerStore.log("Maker module ready — waiting for attribution verification before placing orders");
    }
    scheduleMakerCycle();
  }
  startFeishuGateway(makerStore.log.bind(makerStore));
});

// OKX publishes leaderboard batches roughly every 10 minutes. Polling once a
// minute catches the next published batch without pretending we can force it.
setInterval(() => syncOfficialBoost("timer"), 60 * 1000);
setInterval(() => evaluateAndAdjustTiming(), Math.max(60000, config.execution.adaptiveEvaluationMs));
