const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
const pnlClass = value => Number(value) < 0 ? "pnl-neg" : "pnl-pos";
const el = id => document.getElementById(id);
const tokenAmount = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(Number(value || 0));
const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "(native)";
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function startOfTodayTokyoUtc() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - 9 * 3600 * 1000;
}

function tokyoDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function computePnl(state, prices) {
  const dayStart = startOfTodayTokyoUtc();
  const sells = (state.trades || [])
    .filter(trade => trade.action === "SELL" && Number.isFinite(Number(trade.cashPnlUsd)));
  const realizedToday = sells
    .filter(trade => new Date(trade.at).getTime() >= dayStart)
    .reduce((sum, trade) => sum + Number(trade.cashPnlUsd), 0);
  const realizedTotal = sells.length
    ? sells.reduce((sum, trade) => sum + Number(trade.cashPnlUsd), 0)
    : Number(state.realizedPnlUsd || 0);
  let unrealized = 0;
  for (const [token, lots] of Object.entries(state.positionLots || {})) {
    for (const lot of lots) {
      const entryCostUsd = Number(lot.entryCostUsd || 0);
      const exit = state.executableExitQuotes?.[lot.id];
      const valueUsd = Number.isFinite(Number(exit?.exitProceedsUsd))
        ? Number(exit.exitProceedsUsd)
        : Number(lot.amount || 0) * Number(prices?.[token] || 0);
      unrealized += valueUsd - entryCostUsd;
    }
  }
  return {
    realizedTotal,
    realizedToday,
    unrealized,
    total: realizedTotal + unrealized
  };
}

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function renderDecision(decision) {
  if (!decision) return;
  el("decision").classList.remove("empty");
  el("decision").innerHTML = `
    <h4>${decision.plan.action}${decision.plan.token ? ` · ${decision.plan.token}` : ""}</h4>
    <div class="decision-grid">
      <span>来源<b>${decision.source}</b></span>
      <span>金额<b>${money(decision.plan.amountUsd)}</b></span>
      <span>置信度<b>${Math.round(decision.plan.confidence * 100)}%</b></span>
      <span>最大滑点<b>${decision.plan.maxSlippageBps} bps</b></span>
      <span>风控<b>${decision.risk.approved ? "通过" : "拦截"}</b></span>
      <span>DeepSeek<b>${decision.aiPlan ? `${decision.aiPlan.action} ${decision.aiPlan.token || ""}` : decision.source === "deepseek" ? "已调用" : "降级"}</b></span>
      <span>预计成本<b>${decision.economics ? `${decision.economics.costBps.toFixed(2)} bps` : "报价后计算"}</b></span>
      <span>流动性调整后金额<b>${money(decision.plan.amountUsd)}</b></span>
      <span>预计往返损耗<b>${decision.liquidity ? `${decision.liquidity.roundTripLossBps.toFixed(2)} bps · ${money(decision.liquidity.roundTripLossUsd)}` : "卖出/尚未测试"}</b></span>
      <span>奖励后成本<b>${decision.economics ? `${decision.economics.effectiveCostBps.toFixed(2)} bps` : "—"}</b></span>
      <span>奖励补贴<b>${decision.economics ? `${decision.economics.rewardSubsidyBps.toFixed(2)} bps` : "—"}</b></span>
      <span>原因<b>${decision.risk.reasons.join(", ") || decision.plan.reason}</b></span>
    </div>`;
}

function renderVolume(state) {
  const volume = Number(state.boostVolumeUsd || 0);
  const target = Number(state.targetVolumeUsd || 0);
  const progress = target > 0 ? Math.min(100, volume / target * 100) : 0;
  el("boostVolume").textContent = money(volume);
  el("officialVolume").textContent = money(state.officialBoostVolumeUsd);
  el("officialRankThreshold").textContent = state.officialMinVolumeToRankUsd == null
    ? "—"
    : money(state.officialMinVolumeToRankUsd);
  const pendingOfficial = Math.max(0, volume - Number(state.officialBoostVolumeUsd || 0));
  el("pendingOfficialVolume").textContent = `待官方确认 ${money(pendingOfficial)}`;
  const deltaUsd = Number(state.officialVolumeDeltaUsd);
  el("officialSyncStatus").textContent = state.officialBoostUpdatedAt
    ? `官方更新 ${new Date(state.officialBoostUpdatedAt).toLocaleString()}${Number.isFinite(deltaUsd) ? ` · 与本地差 ${money(deltaUsd)}` : ""}`
    : state.officialBoostSyncStatus === "personal_volume_withheld"
      ? `官方已检查 ${state.officialBoostCheckedAt ? new Date(state.officialBoostCheckedAt).toLocaleTimeString() : ""} · 个人数值需网页钱包会话`
      : state.officialBoostSyncStatus === "error"
        ? `同步失败 · ${state.officialBoostSyncError || "稍后重试"}`
        : "等待首次官方检查";
  el("tradeCount").textContent = String(state.tradeCount ?? (state.trades || []).length);
  el("tradingCosts").textContent = money(state.tradingCostsUsd);
  el("volumeProgressLabel").textContent = `${money(volume)} / ${money(target)}`;
  el("volumeProgressBar").style.width = `${progress}%`;
  el("volumeUpdatedAt").textContent = state.lastVolumeUpdatedAt
    ? `最近交易 ${new Date(state.lastVolumeUpdatedAt).toLocaleTimeString()}`
    : "每笔广播立即统计";
}

function render(payload) {
  const { state, campaign, capabilities, risk, wallet, onchain } = payload;
  el("rewardPool").textContent = money(campaign.rewardPoolUsd);
  renderVolume(state);
  el("boostVolume").title = `目标 ${money(state.targetVolumeUsd)} · 本地按广播金额估算`;
  el("rank").textContent = state.rank || "—";
  el("rankStatus").textContent = state.rank
    ? `官方排名第 ${state.rank}`
    : state.officialParticipationStatus === 2
      ? "已参赛 · 尚未进入奖励排名"
      : "等待官方排名数据";
  el("estimatedReward").textContent = money(state.estimatedRewardUsd);
  const pnl = computePnl(state, onchain?.prices);
  const walletValueUsd = Number(onchain?.wallet?.totalValueUsd || 0);
  const baseCapitalUsd = Number(risk?.baseCapitalUsd || 0);
  const walletNetPnl = walletValueUsd - baseCapitalUsd;
  const realizedFull = walletNetPnl - pnl.unrealized;
  const daySnapshot = state.dayWalletSnapshot;
  const dayNetPnl = daySnapshot && daySnapshot.date === tokyoDateKey()
    ? walletValueUsd - Number(daySnapshot.value || 0)
    : null;
  el("totalPnl").textContent = money(walletNetPnl);
  el("totalPnlDetail").innerHTML = `今日净值变动 <b class="${dayNetPnl == null ? "" : pnlClass(dayNetPnl)}">${dayNetPnl == null ? "—" : money(dayNetPnl)}</b> · 今日已实现 <b class="${pnlClass(pnl.realizedToday)}">${money(pnl.realizedToday)}</b> · 浮动 <b class="${pnlClass(pnl.unrealized)}">${money(pnl.unrealized)}</b>`;
  el("pnlMetric").className = `metric panel ${walletNetPnl < 0 ? "tone-red" : "tone-green"}`;
  el("marketStrip").innerHTML = `
    <div class="market-cell"><span>钱包资产</span><strong>${money(onchain?.wallet?.totalValueUsd)}</strong></div>
    ${["NVDAx", "SNDKx", "SPCXx"].map(symbol => `<div class="market-cell"><span>${symbol}</span><strong>${money(onchain?.prices?.[symbol])}</strong></div>`).join("")}`;
  renderWalletAssets(wallet, onchain?.wallet, state);
  el("systemStatus").innerHTML = `<i></i>${state.running ? " Autonomous" : " Paper mode"}`;
  el("systemStatus").className = `status ${state.running ? "" : "paused"}`;
  updateControls(state.running);
  if (capabilities.deepseekConfigured) {
    el("deepseekStep").classList.add("done");
    el("deepseekText").textContent = "API 已配置";
  }
  if (state.walletConnected) {
    el("walletStep").classList.add("done");
    el("walletStep").querySelector("span").textContent = wallet?.evmAddress
      ? `${wallet.evmAddress.slice(0, 8)}…${wallet.evmAddress.slice(-6)}`
      : "已连接";
  }
  if (state.attributionVerified) {
    el("attributionStep").classList.add("done");
    el("attributionStep").querySelector("span").textContent = "已由使用者验证";
  }
  el("executionBadge").textContent = capabilities.agenticExecutionReady ? "READY" : "LOCKED";
  if (state.pendingConfirmation) el("executionBadge").textContent = "PAUSED · WALLET";
  el("riskList").innerHTML = [
    ["总资金上限", money(risk.totalCapitalUsd)],
    ["单笔上限", money(risk.maxTradeUsd)],
    ["RWA 总敞口", `${risk.maxTotalRwaExposurePct}%`],
    ["单币仓位", `${risk.maxTokenPositionPct}%`],
    ["最大滑点", `${risk.maxSlippageBps} bps`],
    ["每日止损", risk.dailyLossLimitPct > 0 ? `${risk.dailyLossLimitPct}%` : "已关闭"],
    ["每小时交易", risk.maxTradesPerHour > 0 ? `${risk.maxTradesPerHour} 笔` : "不限"],
    ["最短广播间隔", `${Math.round((risk.minBroadcastIntervalMs || 0) / 1000)} 秒`],
    ["自适应节奏", state.adaptiveTiming
      ? `行情 ${Math.round(state.adaptiveTiming.marketPollMs / 1000)} 秒 · 决策 ${Math.round(state.adaptiveTiming.decisionMs / 1000)} 秒 · AI ${Math.round(state.adaptiveTiming.aiAnalysisIntervalMs / 1000)} 秒`
      : "初始化中"],
    ["归因失败", "自动熔断"]
  ].map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("");
  el("logs").innerHTML = state.logs.map(item => `<div class="log"><time>${new Date(item.at).toLocaleTimeString()}</time><span class="${item.level}">${item.level}</span><div>${item.message}</div></div>`).join("");
  renderDecision(state.lastDecision);
}

function renderWalletAssets(wallet, walletData, state) {
  const assets = [...(walletData?.assets || [])].sort((a, b) => Number(b.usdValue) - Number(a.usdValue));
  const total = Number(walletData?.totalValueUsd || 0);
  el("walletTotalValue").textContent = money(total);
  el("walletAssetAddress").textContent = wallet?.evmAddress
    ? `X Layer · ${shortAddress(wallet.evmAddress)} · 0 Gas${state.walletAssetsUpdatedAt ? ` · 更新 ${new Date(state.walletAssetsUpdatedAt).toLocaleTimeString()}` : ""}`
    : "钱包未连接";
  el("walletAssets").innerHTML = assets.length ? assets.map(asset => {
    const share = total > 0 ? Number(asset.usdValue || 0) / total * 100 : 0;
    const symbol = escapeHtml(asset.symbol || "未知资产");
    const contract = escapeHtml(asset.tokenAddress || "native");
    const abbreviated = escapeHtml(shortAddress(asset.tokenAddress));
    return `<tr>
      <td><b>${symbol}</b></td>
      <td>${tokenAmount(asset.balance)}</td>
      <td class="asset-value">${money(asset.usdValue)}</td>
      <td><span class="asset-share"><i style="width:${Math.min(100, share)}%"></i></span>${share.toFixed(2)}%</td>
      <td title="${contract}">${abbreviated}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" class="asset-empty">暂无 X Layer 资产</td></tr>`;
}


function renderMakerDecision(decision) {
  if (!decision) return;
  const box = el("makerDecision");
  box.classList.remove("empty");
  const d = decision.decision || {};
  box.innerHTML = `
    <h4>${d.action || "—"}${d.triggerPrice ? ` @ $${Number(d.triggerPrice).toFixed(4)}` : ""}</h4>
    <div class="decision-grid">
      <span>价格<b>$${Number(decision.price || 0).toFixed(4)}</b></span>
      <span>库存<b>${tokenAmount(decision.inventoryUnits)}</b></span>
      <span>库存USD<b>${money(decision.inventoryUsd)}</b></span>
      <span>USDT余额<b>${money(decision.usdtBalanceUsd)}</b></span>
      <span>维护窗口<b>${decision.pauseWindow ? "暂停中" : "放行"}</b></span>
      <span>熔断冷却<b>${decision.inCooldown ? "冷却中" : "正常"}</b></span>
      <span>原因<b>${d.reason || "—"}</b></span>
      <span>触发<b>${decision.orderInfo ? `订单 ${decision.orderInfo.orderId}` : decision.activeOrderId ? `挂单 ${decision.activeOrderId}` : "无挂单"}</b></span>
    </div>`;
}

const HACKATHON_DEADLINE_UTC = Date.UTC(2026, 7, 21, 23, 59, 0); // 2026-08-21 23:59 UTC
function renderHackathon() {
  const node = el("hackathonCountdown");
  if (!node) return;
  const diff = HACKATHON_DEADLINE_UTC - Date.now();
  if (diff <= 0) {
    node.textContent = "提交已截止";
    node.className = "pill warn";
    return;
  }
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  node.textContent = `提交截止 ${days} 天 ${hours} 时 ${mins} 分`;
  node.className = days <= 1 ? "pill warn" : "pill";
}

const MAKER_POOL = ["NVDAx", "OKB", "CRCLx", "SPCXx", "OKB·新组"];
const MAKER_POOL_ALLOC_KEY = { NVDAx: "main", OKB: "extra", CRCLx: "crclx", SPCXx: "pool4", "OKB·新组": null };
const MAKER_POOL_GAS = { NVDAx: "0 Gas", OKB: "0.08% 服务费 + Gas", CRCLx: "0 Gas", SPCXx: "0 Gas", "OKB·新组": "0.08% 服务费 + Gas" };
let makerDailyStopUsd = 50;

function makerGridFor(state, token) {
  if (token === "OKB") return state.gridBtc;
  if (token === "OKB·新组") return state.gridOkb2;
  if (token === "CRCLx") return state.gridCrclx;
  if (token === "SPCXx") return state.gridPool4;
  return state.grid;
}

function makerWalletPrice(onchain, token) {
  const asset = (onchain?.wallet?.assets || []).find(a => a.symbol === token);
  if (asset && Number(asset.balance) > 0) return Number(asset.usdValue) / Number(asset.balance);
  return null;
}

function renderMaker(payload) {
  const { state, onchain, maker, pnlByToken } = payload;
  makerDailyStopUsd = maker.dailyMaxLossUsd;
  const cfg = maker.grids || {};
  const maxLevels = Math.max(...MAKER_POOL.map(t => cfg[t]?.levels || 8));
  el("makerTokenTitle").textContent = "动态网格池 · 4 币";
  el("makerStrategyDesc").textContent = `${MAKER_POOL.join(" · ")}：基础 2 档起，吃格后自动加至 ${maxLevels} 档；30bps 间距，止盈 +75/+100bps，资金按 24h 链上量自动分配。`;
  el("makerDailyStop").textContent = money(makerDailyStopUsd);
  el("makerPauseLabel").textContent = `维护窗口 ${maker.pauseStartUtc}–${maker.pauseEndUtc} UTC · 动态加档 2→${maxLevels}`;
  el("makerGridParams").textContent = Object.entries(cfg).map(([tok, g]) => {
    const s = g.enabled ? "运行" : "停";
    return `${tok}: ${g.levels}格/${g.spacingBps}bps/+${g.profitBps}bps/${g.deployPct}%(${s})`;
  }).join(" · ") || "网格参数 —";
  renderMakerMetrics(payload);
  renderMakerPool(payload);
  el("makerSystemStatus").innerHTML = `<i></i>${state.running ? " 运行中" : " 已停止"}`;
  el("makerSystemStatus").className = `status ${state.running ? "" : "paused"}`;
  updateMakerControls(state.running);
  el("makerLogs").innerHTML = state.logs.map(item => `<div class="log"><time>${new Date(item.at).toLocaleTimeString()}</time><span class="${item.level}">${item.level}</span><div>${item.message}</div></div>`).join("");
  renderMakerDecision(state.lastDecision);
}

function renderMakerMetrics(payload) {
  const { state, onchain, maker, pnlByToken } = payload;
  const inCooldown = state.cooldownUntil && Date.now() < new Date(state.cooldownUntil).getTime();
  el("makerCircuit").textContent = inCooldown ? "冷却中" : state.running ? "运行中" : "已停止";
  const circuitBits = [`每日止损 ${money(maker.dailyMaxLossUsd)}`];
  if (inCooldown) circuitBits.push(`冷却至 ${new Date(state.cooldownUntil).toLocaleTimeString()}`);
  if (state.downtrendPaused) circuitBits.push("下跌暂停");
  if (state.stopReason) circuitBits.push(String(state.stopReason));
  el("makerCooldown").textContent = circuitBits.join(" · ");
  el("makerTodayPnl").textContent = money(state.makerDailyPnlUsd);
  el("makerTodayPnl").className = pnlClass(state.makerDailyPnlUsd);
  el("makerDayLabel").textContent = `交易日 ${state.makerDayKey || "—"} (UTC)`;
  const total = pnlByToken?.total || {};
  el("makerNetPnl").textContent = money(total.netUsd);
  el("makerNetPnl").className = pnlClass(total.netUsd);
  el("makerPnlDetail").textContent = `实际已实现 ${money(total.realizedPnlUsd)} · 浮盈亏 ${money(total.unrealizedUsd)}`;
  const usdtAsset = (onchain?.wallet?.assets || []).find(a => a.tokenAddress?.toLowerCase() === maker.quoteAddress?.toLowerCase());
  el("makerUsdtBalance").textContent = money(usdtAsset?.usdValue || usdtAsset?.balance || 0);
  let buys = 0, sells = 0, posCount = 0, posCost = 0;
  MAKER_POOL.forEach(token => {
    const grid = makerGridFor(state, token);
    (grid?.activeOrders || []).forEach(o => String(o.side).toLowerCase() === "buy" ? buys++ : sells++);
    (grid?.positions || []).forEach(p => { posCount++; posCost += Number(p.costUsd || 0); });
  });
  el("makerOrders").textContent = String(buys + sells);
  el("makerOrdersDetail").textContent = `买单 ${buys} · 卖单 ${sells}`;
  el("makerPositions").textContent = posCount ? `${posCount} 仓` : "0";
  el("makerPositionsDetail").textContent = posCost > 0 ? `占用 ${money(posCost)}` : "当前无持仓";
  const alloc = state.deployOverride || {};
  el("makerFlowAlloc").textContent = MAKER_POOL.map(t => `${t} ${Number(alloc[MAKER_POOL_ALLOC_KEY[t]] ?? maker.grids?.[t]?.deployPct ?? 0).toFixed(0)}%`).join(" · ");
  el("makerFlowDetail").textContent = state.flowAllocAt ? `按 24h 链上量 · 更新 ${new Date(state.flowAllocAt).toLocaleTimeString()}` : "按 24h 链上量自动调仓";
  const reg = state.regimeInfo;
  el("makerRegime").textContent = reg ? `${reg.trendBps >= 0 ? "上行" : "下行"} ${Math.abs(reg.trendBps).toFixed(1)}bps · 波动 ${Number(reg.rangeBps).toFixed(0)}bps` : "—";
  el("makerRegimeDetail").textContent = state.downtrendPaused ? "下跌确认：暂停新买单" : (inCooldown ? "冷却中" : "正常交易");
}

function renderMakerPool(payload) {
  const { state, onchain, maker, pnlByToken } = payload;
  const cfg = maker.grids || {};
  const maxLevels = Math.max(...MAKER_POOL.map(t => cfg[t]?.levels || 8));
  const cards = MAKER_POOL.map(token => {
    const isOkb2 = token === "OKB·新组";
    const grid = makerGridFor(state, token);
    const c = cfg[token] || {};
    const pnl = isOkb2 ? {} : (pnlByToken?.[token] || {});
    const price = grid?.mid || onchain?.prices?.[token] || makerWalletPrice(onchain, token);
    const positions = grid?.positions || [];
    const orders = grid?.activeOrders || [];
    const buys = orders.filter(o => String(o.side).toLowerCase() === "buy");
    const sells = orders.filter(o => String(o.side).toLowerCase() === "sell");
    const posUnits = positions.reduce((sum, p) => sum + Number(p.units || 0), 0);
    const posCost = positions.reduce((sum, p) => sum + Number(p.costUsd || 0), 0);
    const allocPct = Number(state.deployOverride?.[MAKER_POOL_ALLOC_KEY[token]] ?? c.deployPct ?? 0);
    const orderDetail = [
      ...buys.map(o => `买${o.level || "?"}@$${Number(o.price).toFixed(4)}`),
      ...sells.map(o => `卖${o.level || "?"}@$${Number(o.price).toFixed(4)}`)
    ].join(" · ");
    return `<div class="pnl-token pool-card">
      <div class="pool-head">
        <h4>${token}</h4>
        <span class="pill ${c.enabled ? "" : "warn"}">${c.enabled ? "运行" : "停"}</span>
      </div>
      <div class="pool-gas ${token === "OKB" || isOkb2 ? "has-fee" : ""}">${MAKER_POOL_GAS[token]} · ${c.levels || 8}格/${c.spacingBps || 30}bps/+${c.profitBps || 100}bps · 部署 ${allocPct.toFixed(0)}%</div>
      <div class="pool-price"><strong>${price ? `$${Number(price).toFixed(4)}` : "—"}</strong><small>2→${c.levels || 8} 档动态</small></div>
      <div class="pool-meta">持仓 ${positions.length} 仓 · ${tokenAmount(posUnits)} 枚 · ${money(posCost)}</div>
      <div class="pool-rows">
        <div class="pnl-row"><span>挂单</span><b title="${escapeHtml(orderDetail)}">买 ${buys.length} · 卖 ${sells.length}</b></div>
        <div class="pnl-row"><span>实际已实现</span><b>${isOkb2 ? "并入 OKB" : `<span class="${pnlClass(pnl.realizedPnlUsd)}">${money(pnl.realizedPnlUsd)}</span>`}</b></div>
        <div class="pnl-row"><span>持仓浮盈亏</span><b>${isOkb2 ? "—" : `<span class="${pnlClass(pnl.unrealizedUsd)}">${money(pnl.unrealizedUsd)}</span>`}</b></div>
        <div class="pnl-row"><span>合计净值</span><b>${isOkb2 ? "并入 OKB" : `<span class="${pnlClass(pnl.netUsd)}">${money(pnl.netUsd)}</span>`}</b></div>
        <div class="pnl-row"><span>交易量 · 胜率</span><b>${isOkb2 ? "并入 OKB" : `${money(pnl.volumeUsd)} · ${pnl.winRate == null ? "—" : `${pnl.winRate}%`}`}</b></div>
      </div>
    </div>`;
  });
  const total = pnlByToken?.total || {};
  const allGrids = MAKER_POOL.map(t => makerGridFor(state, t));
  const posCount = allGrids.reduce((sum, g) => sum + (g?.positions?.length || 0), 0);
  const orderCount = allGrids.reduce((sum, g) => sum + (g?.activeOrders?.length || 0), 0);
  const fills = Object.values(pnlByToken || {}).reduce((sum, r) => sum + Number(r.tradeCount || 0), 0);
  const est = Object.values(pnlByToken || {}).reduce((sum, r) => sum + Number(r.estimatedRealizedPnlUsd || 0), 0);
  cards.push(`<div class="pnl-token pool-card pool-total">
    <div class="pool-head"><h4>汇总</h4><span class="pill">POOL</span></div>
    <div class="pool-gas">4 币 + OKB 新组 · ${maxLevels} 档 · 30bps · 0 Gas（OKB 除外）</div>
    <div class="pool-price"><strong class="${pnlClass(total.netUsd)}">${money(total.netUsd)}</strong><small>实际成交净值</small></div>
    <div class="pool-meta">实际已实现 ${money(total.realizedPnlUsd)} · 浮盈亏 ${money(total.unrealizedUsd)}</div>
    <div class="pool-rows">
      <div class="pnl-row"><span>持仓</span><b>${posCount} 仓</b></div>
      <div class="pnl-row"><span>挂单</span><b>${orderCount} 单</b></div>
      <div class="pnl-row"><span>已成交</span><b>${fills} 笔</b></div>
      <div class="pnl-row"><span>估算已实现</span><b>${money(est)}</b></div>
    </div>
  </div>`);
  el("makerPoolGrid").innerHTML = cards.join("");
}

function updateMakerControls(running) {
  const start = el("makerStartButton");
  const stop = el("makerStopButton");
  start.disabled = running;
  start.textContent = running ? "Maker 运行中" : "启动 Maker 做市";
  start.className = `button start-control ${running ? "running" : ""}`;
  stop.disabled = !running;
  stop.textContent = running ? "停止 Maker" : "Maker 已停止";
  stop.className = `button stop-control ${running ? "armed" : "stopped"}`;
}

async function refreshMaker() {
  try { renderMaker(await api("/api/maker/status")); }
  catch (error) { console.error(error); }
}

async function refreshMakerLive() {
  try {
    const payload = await api("/api/maker/live");
    const state = payload.state;
    const inCooldown = state.cooldownUntil && Date.now() < new Date(state.cooldownUntil).getTime();
    el("makerCircuit").textContent = inCooldown ? "冷却中" : state.running ? "运行中" : "已停止";
    const circuitBits = [`每日止损 ${money(makerDailyStopUsd)}`];
    if (inCooldown) circuitBits.push(`冷却至 ${new Date(state.cooldownUntil).toLocaleTimeString()}`);
    el("makerCooldown").textContent = circuitBits.join(" · ");
    el("makerSystemStatus").innerHTML = `<i></i>${state.running ? " 运行中" : " 已停止"}`;
    el("makerSystemStatus").className = `status ${state.running ? "" : "paused"}`;
    updateMakerControls(state.running);
  } catch (error) { console.error(error); }
}

async function refreshFinance() {
  try { renderFinance(await api("/api/finance/summary")); }
  catch (error) { console.error(error); }
}

function renderFinance(payload) {
  const { summary, projects, wallet } = payload;
  const net = Number(summary.netPnlUsd || 0);
  el("financeWalletTotal").textContent = money(summary.walletTotalUsd);
  el("financeWalletTotal2").textContent = money(summary.walletTotalUsd);
  const change1h = summary.walletChange1hUsd == null ? null : Number(summary.walletChange1hUsd);
  const change24h = summary.walletChange24hUsd == null ? null : Number(summary.walletChange24hUsd);
  const trendText = [
    change1h == null ? "近1h —" : `近1h ${change1h >= 0 ? "+" : ""}${money(change1h)}`,
    change24h == null ? "近24h —" : `近24h ${change24h >= 0 ? "+" : ""}${money(change24h)}`
  ].join(" · ");
  el("financeWalletUpdated").textContent = `${trendText}`;
  el("financeNetPnl").textContent = `总盈亏 ${money(net)}`;
  el("financeNetPnl").className = pnlClass(net);
  el("financeNetPnl2").textContent = money(net);
  el("financeNetPnl2").className = pnlClass(net);
  el("financeBaseCapital").textContent = `资金基准 ${money(summary.baseCapitalUsd)}`;
  el("financeRealizedSum").textContent = money(summary.estimatedProjectsUsd ?? summary.realizedProjectsUsd);
  el("financeActive").textContent = String(summary.activeProjects || 0);
  el("financeGenerated").textContent = summary.generatedAt ? `更新 ${new Date(summary.generatedAt).toLocaleTimeString()}` : "—";
  el("financeWalletUpdated").textContent = `${wallet.updatedAt ? `更新 ${new Date(wallet.updatedAt).toLocaleTimeString()}` : "—"} · ${trendText}`;

  el("financeTable").innerHTML = projects.map(p => `
    <tr>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${escapeHtml(p.chain)}</td>
      <td><span class="status ${p.status === "运行中" ? "" : "paused"}"><i></i>${escapeHtml(p.status)}</span></td>
      <td class="${pnlClass(p.realizedPnlUsd)}">${money(p.realizedPnlUsd)}</td>
      <td>${money(p.volumeUsd)}</td>
      <td>${p.tradeCount ?? 0}</td>
      <td>${p.winRate == null ? "—" : `${p.winRate}%`}</td>
      <td class="finance-strategy" title="${escapeHtml(p.note || "")}">${escapeHtml(p.strategy)}</td>
    </tr>`).join("");

  el("financeNotes").innerHTML = projects.map(p => {
    const statusClass = p.status === "运行中" ? "" : "paused";
    const links = p.links
      ? Object.entries(p.links).map(([k, v]) => `<a class="finance-link" href="${v}" target="_blank" rel="noopener">${escapeHtml(k)}</a>`).join("")
      : "";
    const items = [];
    if (p.strategy) items.push(["策略", p.strategy]);
    if (p.startedAt) items.push(["启动", new Date(p.startedAt).toLocaleString()]);
    if (p.moduleCounterUsd != null) items.push(["模块计数", money(p.moduleCounterUsd)]);
    if (p.actualNetPnlUsd != null) items.push(["实际成交净盈亏", money(p.actualNetPnlUsd)]);
    if (p.estimatedNetPnlUsd != null) items.push(["模块估算净盈亏", money(p.estimatedNetPnlUsd)]);
    if (p.walletPnlSinceBaselineUsd != null) items.push(["钱包净值（新口径）", money(p.walletPnlSinceBaselineUsd)]);
    if (p.walletBaselineAt) items.push(["净值基准时间", new Date(p.walletBaselineAt).toLocaleString()]);
    if (p.accountingBasis) items.push(["统计口径", p.accountingBasis]);
    if (p.rank != null) items.push(["官方排名", String(p.rank)]);
    if (p.estimatedRewardUsd) items.push(["预估奖励", money(p.estimatedRewardUsd)]);
    if (p.note) items.push(["备注", p.note]);
    return `
      <div class="finance-note">
        <div class="finance-note-head">
          <b>${escapeHtml(p.name)}</b>
          <span class="status ${statusClass}"><i></i>${escapeHtml(p.status)}</span>
        </div>
        ${items.length ? `<div class="finance-note-grid">${items.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join("")}</div>` : ""}
        ${links ? `<div class="finance-note-links">${links}</div>` : ""}
      </div>`;
  }).join("");

  const assets = (wallet.assets || []).filter(a => Number(a.usdValue) > 0.01).sort((a, b) => Number(b.usdValue) - Number(a.usdValue));
  el("financeWalletAssets").innerHTML = assets.length
    ? `<table class="asset-table"><tbody>${assets.map(a => `<tr><td><b>${escapeHtml(a.symbol)}</b></td><td class="asset-value">${money(a.usdValue)}</td></tr>`).join("")}</tbody></table>`
    : "<table class='asset-table'><tbody><tr><td class='asset-empty'>暂无资产</td></tr></tbody></table>";
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportFinanceCsv() {
  api("/api/finance/summary").then(payload => {
    const header = ["项目", "链", "状态", "实际已实现盈亏USDT", "交易量USDT", "笔数", "胜率%", "策略", "备注"];
    const rows = payload.projects.map(p => [
      p.name, p.chain, p.status, p.realizedPnlUsd, p.volumeUsd, p.tradeCount ?? "", p.winRate ?? "",
      p.strategy, p.note ?? ""
    ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    downloadFile(`okx-finance-${new Date().toISOString().slice(0, 10)}.csv`, [header.join(","), ...rows].join("\n"), "text/csv");
  }).catch(error => console.error(error));
}

function exportFinanceJson() {
  api("/api/finance/summary").then(payload => {
    downloadFile(`okx-finance-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  }).catch(error => console.error(error));
}

function updateControls(running) {
  const start = el("startButton");
  const stop = el("stopButton");
  start.disabled = running;
  start.textContent = running ? "自动交易运行中" : "启动自动执行";
  start.className = `button start-control ${running ? "running" : ""}`;
  stop.disabled = !running;
  stop.textContent = running ? "紧急停止" : "当前已停止";
  stop.className = `button stop-control ${running ? "armed" : "stopped"}`;
}

async function refresh() {
  try { render(await api("/api/status")); }
  catch (error) { console.error(error); }
}

async function refreshLive() {
  try {
    const payload = await api("/api/live");
    renderVolume(payload.state);
    el("systemStatus").innerHTML = `<i></i>${payload.state.running ? " Autonomous" : " Paused"}`;
    el("systemStatus").className = `status ${payload.state.running ? "" : "paused"}`;
    updateControls(payload.state.running);
  } catch (error) { console.error(error); }
}

el("tabMaker").addEventListener("click", () => activateTab("maker"));
el("tabFinance").addEventListener("click", () => { activateTab("finance"); refreshFinance(); });
el("financeExportCsv").addEventListener("click", exportFinanceCsv);
el("financeExportJson").addEventListener("click", exportFinanceJson);

function activateTab(name) {
  el("panelMaker").classList.toggle("hidden", name !== "maker");
  el("panelFinance").classList.toggle("hidden", name !== "finance");
  el("tabMaker").classList.toggle("active", name === "maker");
  el("tabFinance").classList.toggle("active", name === "finance");
}
el("makerStartButton").addEventListener("click", async () => {
  await api("/api/maker/control", { method: "POST", body: JSON.stringify({ action: "start" }) });
  await refreshMaker();
});
el("makerStopButton").addEventListener("click", async () => {
  await api("/api/maker/control", { method: "POST", body: JSON.stringify({ action: "stop" }) });
  await refreshMaker();
});
el("makerCycleButton").addEventListener("click", async () => {
  await api("/api/maker/cycle", { method: "POST", body: "{}" });
  await refreshMaker();
});

refreshMaker();
renderHackathon();
refreshFinance();
setInterval(refreshMakerLive, 4000);
setInterval(refreshMaker, 5000);
setInterval(renderHackathon, 30000);
setInterval(refreshFinance, 30000);
