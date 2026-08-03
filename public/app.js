const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
const el = id => document.getElementById(id);
const tokenAmount = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(Number(value || 0));
const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "(native)";
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

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
  el("officialSyncStatus").textContent = state.officialBoostUpdatedAt
    ? `官方更新 ${new Date(state.officialBoostUpdatedAt).toLocaleString()}`
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
  el("dailyPnl").textContent = money(state.dailyPnlUsd);
  el("pnlMetric").className = `metric panel ${Number(state.dailyPnlUsd) < 0 ? "tone-red" : "tone-green"}`;
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

refresh();
setInterval(refreshLive, 2000);
setInterval(refresh, 15000);
