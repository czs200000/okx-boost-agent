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

function renderMaker(payload) {
  const { state, wallet, onchain, maker, capabilities } = payload;
  const token = maker?.token || "NVDAx";
  const price = Number(onchain?.prices?.[token] || 0);
  el("makerTokenTitle").textContent = `${token} 做市轮转`;
  el("makerInventoryLabel").textContent = `${token} 库存`;
  el("makerPriceLabel").textContent = `当前 ${token} 价格`;
  el("makerLegUsd").textContent = money(maker.legUsd);
  el("makerPauseLabel").textContent = `维护窗口 ${maker.pauseStartUtc}–${maker.pauseEndUtc} UTC · 触发 ±${maker.buyTriggerBps}/${maker.sellTriggerBps}bps`;
  el("makerPhase").textContent = state.phase || "—";
  el("makerOrderStatus").textContent = state.activeOrderId
    ? `挂单 ${String(state.activeOrderId).slice(-8)}`
    : "无挂单";
  el("makerInventory").textContent = tokenAmount(state.inventoryUnits);
  el("makerInventoryUsd").textContent = money(Number(state.inventoryUnits || 0) * price);
  el("makerCostBasis").textContent = money(state.costBasisUsd);
  const sells = (state.trades || []).filter(t => t.kind === "SELL");
  el("makerRoundTrips").textContent = String(sells.length);
  el("makerTradeCount").textContent = `${(state.trades || []).length} 笔成交记录`;
  const usRealized = Number(state.realizedPnlUsd || 0);
  const okbRealized = Number(state.realizedPnlBtcUsd || 0);
  el("makerPnl").textContent = money(usRealized + okbRealized);
  el("makerPnl").className = pnlClass(usRealized + okbRealized);
  el("makerLossStreak").textContent = `美股 ${money(usRealized)} · OKB ${money(okbRealized)} · 连亏 ${Math.max(Number(state.lossStreak || 0), Number(state.lossStreakBtc || 0))}`;
  const inCooldown = state.cooldownUntil && Date.now() < new Date(state.cooldownUntil).getTime();
  el("makerCircuit").textContent = inCooldown ? "冷却中" : state.running ? "正常" : "已停止";
  el("makerCooldown").textContent = inCooldown
    ? `至 ${new Date(state.cooldownUntil).toLocaleTimeString()}`
    : "—";
  el("makerPrice").textContent = price ? `$${price.toFixed(4)}` : "—";
  el("makerTriggerInfo").textContent = state.lastDecision?.orderInfo
    ? `触发 $${Number(state.lastDecision.orderInfo.triggerPrice).toFixed(4)}`
    : `触发 ±${maker.buyTriggerBps}/${maker.sellTriggerBps}bps`;
  const usdtAsset = (onchain?.wallet?.assets || []).find(a => a.tokenAddress?.toLowerCase() === maker.quoteAddress?.toLowerCase());
  el("makerUsdtBalance").textContent = money(usdtAsset?.usdValue || usdtAsset?.balance || 0);
  el("makerSystemStatus").innerHTML = `<i></i>${state.running ? " 运行中" : " 已停止"}`;
  el("makerSystemStatus").className = `status ${state.running ? "" : "paused"}`;
  updateMakerControls(state.running);
  el("makerLogs").innerHTML = state.logs.map(item => `<div class="log"><time>${new Date(item.at).toLocaleTimeString()}</time><span class="${item.level}">${item.level}</span><div>${item.message}</div></div>`).join("");
  renderMakerDecision(state.lastDecision);
  renderTokenPnl(payload);
}

function renderTokenPnl(payload) {
  const pnl = payload?.pnlByToken;
  if (!pnl) return;
  const keys = Object.keys(pnl).filter(k => k !== "total");
  const us = keys[0] ? pnl[keys[0]] : null;
  const btc = keys[1] ? pnl[keys[1]] : null;
  const crclx = pnl["CRCLx"] || null;
  const total = pnl.total;
  const fill = (prefix, data, label) => {
    if (!data) return;
    if (label) el(`${prefix}Title`).textContent = label;
    el(`${prefix}Realized`).textContent = money(data.realizedPnlUsd);
    el(`${prefix}Realized`).className = pnlClass(data.realizedPnlUsd);
    el(`${prefix}Unrealized`).textContent = money(data.unrealizedUsd);
    el(`${prefix}Unrealized`).className = pnlClass(data.unrealizedUsd);
    el(`${prefix}Net`).textContent = money(data.netUsd);
    el(`${prefix}Net`).className = pnlClass(data.netUsd);
    el(`${prefix}Meta`).textContent = data.positions != null ? `${data.positions} 仓 · ${data.activeOrders} 单` : "—";
    el(`${prefix}Volume`).textContent = `${money(data.volumeUsd)} · ${data.winRate == null ? "—" : `${data.winRate}%`}`;
  };
  fill("pnlUs", us, `美股 · ${keys[0] || "—"}`);
  fill("pnlBtc", btc, keys[1] || "BTC");
  fill("pnlCrclx", crclx, "CRCLx · 独立模块");
  if (total) {
    el("pnlTotalRealized").textContent = money(total.realizedPnlUsd);
    el("pnlTotalRealized").className = pnlClass(total.realizedPnlUsd);
    el("pnlTotalUnrealized").textContent = money(total.unrealizedUsd);
    el("pnlTotalUnrealized").className = pnlClass(total.unrealizedUsd);
    el("pnlTotalNet").textContent = money(total.netUsd);
    el("pnlTotalNet").className = pnlClass(total.netUsd);
    el("pnlTotalMeta").textContent = `${(us?.positions || 0) + (btc?.positions || 0) + (crclx?.positions || 0)} 仓 · ${(us?.activeOrders || 0) + (btc?.activeOrders || 0) + (crclx?.activeOrders || 0)} 单`;
    el("pnlTotalVolume").textContent = money((us?.volumeUsd || 0) + (btc?.volumeUsd || 0) + (crclx?.volumeUsd || 0));
  }
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
    el("makerPhase").textContent = state.phase || "—";
    el("makerOrderStatus").textContent = state.activeOrderId ? `挂单 ${String(state.activeOrderId).slice(-8)}` : "无挂单";
    el("makerRoundTrips").textContent = String(state.roundTrips || 0);
    el("makerTradeCount").textContent = `${state.tradeCount || 0} 笔成交记录`;
    const usRealized = Number(state.realizedPnlUsd || 0);
    const okbRealized = Number(state.realizedPnlBtcUsd || 0);
    el("makerPnl").textContent = money(usRealized + okbRealized);
    el("makerPnl").className = pnlClass(usRealized + okbRealized);
    el("makerLossStreak").textContent = `美股 ${money(usRealized)} · OKB ${money(okbRealized)} · 连亏 ${Math.max(Number(state.lossStreak || 0), Number(state.lossStreakBtc || 0))}`;
    const inCooldown = state.cooldownUntil && Date.now() < new Date(state.cooldownUntil).getTime();
    el("makerCircuit").textContent = inCooldown ? "冷却中" : state.running ? "正常" : "已停止";
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
  el("financeRealizedSum").textContent = money(summary.realizedProjectsUsd);
  el("financeActive").textContent = String(summary.activeProjects || 0);
  el("financeGenerated").textContent = summary.generatedAt ? `更新 ${new Date(summary.generatedAt).toLocaleTimeString()}` : "—";
  el("financeWalletUpdated").textContent = wallet.updatedAt ? `更新 ${new Date(wallet.updatedAt).toLocaleTimeString()}` : "—";

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
    const header = ["项目", "链", "状态", "累计盈亏USDT", "交易量USDT", "笔数", "胜率%", "策略", "备注"];
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

el("refreshButton").addEventListener("click", refresh);
el("syncBoostButton").addEventListener("click", async () => {
  const button = el("syncBoostButton");
  const before = el("officialVolume").textContent;
  button.disabled = true;
  button.textContent = "正在检查官方数据…";
  try {
    const payload = await api("/api/boost/sync", { method: "POST", body: "{}" });
    await refresh();
    const state = payload.state;
    if (state.officialBoostSyncStatus === "synced" && el("officialVolume").textContent !== before) {
      button.textContent = "已更新";
    } else if (state.officialBoostSyncStatus === "personal_volume_withheld") {
      button.textContent = "检查完成 · 官方暂无新数据";
      el("officialSyncStatus").textContent = `刚刚检查完成 · OKX 约每 10 分钟批量更新${state.officialMinVolumeToRankUsd != null ? ` · 入榜线 ${money(state.officialMinVolumeToRankUsd)}` : ""}`;
    } else {
      button.textContent = "同步完成";
    }
  } catch (error) {
    button.textContent = "同步失败 · 重试";
    el("officialSyncStatus").textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "立即检查官方数据";
    }, 2500);
  }
});
el("syncWalletButton").addEventListener("click", async () => {
  const button = el("syncWalletButton");
  button.disabled = true;
  button.textContent = "同步中…";
  try { await api("/api/wallet/sync", { method: "POST", body: "{}" }); await refresh(); }
  finally { button.disabled = false; button.textContent = "立即同步资产"; }
});
el("startButton").addEventListener("click", async () => { await api("/api/control", { method: "POST", body: JSON.stringify({ action: "start" }) }); await refresh(); });
el("stopButton").addEventListener("click", async () => { await api("/api/control", { method: "POST", body: JSON.stringify({ action: "stop" }) }); await refresh(); });
el("simulateButton").addEventListener("click", async () => {
  const decision = await api("/api/decision", { method: "POST", body: JSON.stringify({ useDeepSeek: true }) });
  renderDecision(decision);
  await refresh();
});
el("tabXlayer").addEventListener("click", () => activateTab("xlayer"));
el("tabMaker").addEventListener("click", () => activateTab("maker"));
el("tabFinance").addEventListener("click", () => { activateTab("finance"); refreshFinance(); });
el("financeExportCsv").addEventListener("click", exportFinanceCsv);
el("financeExportJson").addEventListener("click", exportFinanceJson);

function activateTab(name) {
  el("panelXlayer").classList.toggle("hidden", name !== "xlayer");
  el("panelMaker").classList.toggle("hidden", name !== "maker");
  el("panelFinance").classList.toggle("hidden", name !== "finance");
  el("tabXlayer").classList.toggle("active", name === "xlayer");
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

refresh();
refreshMaker();
renderHackathon();
refreshFinance();
setInterval(refreshLive, 2000);
setInterval(refresh, 15000);
setInterval(refreshMakerLive, 4000);
setInterval(refreshMaker, 15000);
setInterval(renderHackathon, 30000);
setInterval(refreshFinance, 30000);
