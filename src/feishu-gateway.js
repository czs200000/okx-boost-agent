// Feishu (Lark) bot gateway for the OKX Boost Agent.
// - Receives messages via WebSocket long connection (no public URL needed)
// - Routes natural-language commands to local API / status endpoints
// - Can push proactive messages (maker P&L, alerts) to the admin chat
// Environment:
//   FEISHU_ENABLED=true
//   FEISHU_APP_ID=<app id>
//   FEISHU_APP_SECRET=<app secret>
//   FEISHU_ADMIN_OPEN_ID=<open id of the owner chat> (optional but recommended)
//   FEISHU_PUSH_HOURLY=true  -> push a maker summary every hour
import * as lark from "@larksuiteoapi/node-sdk";

const BASE = "http://127.0.0.1:4310";

let client = null;
let wsClient = null;
let cfg = {};

function loadConfig() {
  return {
    enabled: process.env.FEISHU_ENABLED === "true" || process.env.FEISHU_ENABLED === "1",
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    adminOpenId: (process.env.FEISHU_ADMIN_OPEN_ID || "").trim(),
    pushHourly: process.env.FEISHU_PUSH_HOURLY === "true" || process.env.FEISHU_PUSH_HOURLY === "1"
  };
}

const money = value => `$${Number(value || 0).toFixed(2)}`;

async function localJson(path, options) {
  const response = await fetch(`${BASE}${path}`, { headers: { "content-type": "application/json" }, ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return response.json();
}

async function makerStatus() {
  const payload = await localJson("/api/maker/status");
  const pnl = payload.pnlByToken || {};
  const us = pnl[payload.maker?.token] || {};
  const okb = pnl.extraGridToken ? pnl[payload.maker.extraGridToken] : null;
  const total = pnl.total || {};
  const state = payload.state || {};
  const lines = [
    `📊 Maker 做市盈亏`,
    `▸ 状态：${state.running ? "运行中" : "已停止"}${state.cooldownActive ? "（冷却中）" : ""}${state.stopReason ? `（${state.stopReason}）` : ""}`,
    `▸ 美股 ${payload.maker?.token || "NVDAx"}：已实现 ${money(us.realizedPnlUsd)} · 浮动 ${money(us.unrealizedUsd)}`,
    ...(okb ? [`▸ OKB：已实现 ${money(okb.realizedPnlUsd)} · 浮动 ${money(okb.unrealizedUsd)}`] : []),
    `▸ 合计：已实现 ${money(total.realizedPnlUsd)} · 浮动 ${money(total.unrealizedUsd)} · 净 ${money(total.netUsd)}`,
    `▸ 持仓 ${total.positions ?? "—"} 仓 · 挂单 ${total.activeOrders ?? "—"} 单 · 交易量 ${money(total.volumeUsd)}`
  ];
  return lines.join("\n");
}

async function financeSummary() {
  const payload = await localJson("/api/finance/summary");
  const lines = [
    `📒 控制台（各项目汇总）`,
    `▸ 钱包资产 ${money(payload.summary.walletTotalUsd)} · 基准 ${money(payload.summary.baseCapitalUsd)} · 净盈亏 ${money(payload.summary.netPnlUsd)}`,
    `▸ 各项目已实现合计 ${money(payload.summary.realizedProjectsUsd)}`
  ];
  for (const p of payload.projects || []) {
    lines.push(`▸ ${p.name}：${money(p.realizedPnlUsd)} · 量 ${money(p.volumeUsd)} · ${p.status}`);
  }
  return lines.join("\n");
}

async function walletAssets() {
  const payload = await localJson("/api/finance/summary");
  const assets = (payload.wallet?.assets || []).filter(a => Number(a.usdValue) > 0.01).sort((a, b) => Number(b.usdValue) - Number(a.usdValue));
  const lines = [`👛 钱包资产（X Layer）`, `▸ 总价值 ${money(payload.summary.walletTotalUsd)}`];
  for (const a of assets) lines.push(`▸ ${a.symbol}：${a.balance}（${money(a.usdValue)}）`);
  return lines.join("\n");
}

async function hackathonWatch() {
  const fs = await import("node:fs");
  const logPath = new URL("../data/asp-review-watch.log", import.meta.url);
  let tail = "";
  try {
    tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-5).join("\n");
  } catch {
    tail = "暂无监控日志";
  }
  return `🎯 黑客松报名监控\n${tail || "（等待记录）"}`;
}

async function controlMaker(action) {
  if (!["start", "pause", "stop"].includes(action)) return "无效操作";
  await localJson("/api/maker/control", { method: "POST", body: JSON.stringify({ action }) });
  return action === "start" ? "✅ Maker 已启动" : action === "pause" ? "⏸️ Maker 已暂停" : "🛑 Maker 已停止";
}

async function pendingChange(text) {
  const fs = await import("node:fs");
  const path = new URL("../data/feishu-pending.json", import.meta.url);
  const list = [];
  try { list.push(...JSON.parse(fs.readFileSync(path, "utf8"))); } catch { /* first write */ }
  list.push({ at: new Date().toISOString(), request: text });
  fs.writeFileSync(path, JSON.stringify(list.slice(-20), null, 2));
  return "✏️ 已记录你的修改请求（" + text + "）。参数修改需要我在 Codex 会话里确认执行——我稍后看到会处理，或你直接在这里确认也可以。";
}

async function routeCommand(text) {
  const t = (text || "").replace(/@_user_\d+/g, "").trim().toLowerCase();
  if (!t) return "请发送指令（回复“帮助”查看支持的命令）。";
  if (/帮助|菜单|指令|help/.test(t)) {
    return [
      "🤖 支持的命令：",
      "▸ 查看盈亏 / maker 状态",
      "▸ 查看控制台 / 财务汇总",
      "▸ 查看钱包 / 资产",
      "▸ 查看 OKB 网格 / NVDAx 网格",
      "▸ 查看黑客松报名状态",
      "▸ 启动 maker / 停止 maker",
      "▸ 修改请求：例如“OKB 网格改成 8 档”（会转给我确认执行）"
    ].join("\n");
  }
  if (/盈亏|收益|maker|做市|状态/.test(t)) return makerStatus();
  if (/控制台|财务|汇总|项目/.test(t)) return financeSummary();
  if (/钱包|资产|余额/.test(t)) return walletAssets();
  if (/okb/.test(t)) return makerStatus();
  if (/nvdax|美股/.test(t)) return makerStatus();
  if (/黑客松|审核|报名/.test(t)) return hackathonWatch();
  if (/启动\s*maker|开始\s*maker/.test(t)) return controlMaker("start");
  if (/停止\s*maker|暂停\s*maker/.test(t)) return controlMaker("stop");
  if (/改成|调整|修改|设置|暂停|恢复/.test(t)) return pendingChange(text);
  return "未识别的指令。回复“帮助”查看支持的命令。";
}

async function sendText(target, text, receiveIdType = "chat_id") {
  if (!client) throw new Error("飞书网关未启动");
  await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: target, msg_type: "text", content: JSON.stringify({ text }) }
  });
}

export async function pushToAdmin(text) {
  if (!client || !cfg.adminOpenId) return false;
  await sendText(cfg.adminOpenId, text, "open_id");
  return true;
}

export async function startFeishuGateway(log) {
  cfg = loadConfig();
  if (!cfg.enabled) return null;
  if (!cfg.appId || !cfg.appSecret) {
    log("飞书网关未启动：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET", "warn");
    return null;
  }
  client = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, appType: lark.AppType.SelfBuild });
  wsClient = new lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: lark.LoggerLevel.info });

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const message = data?.message || {};
        const sender = data?.sender || {};
        const senderOpenId = sender?.sender_id?.open_id || "";
        const chatType = message.chat_type || "";
        let text = "";
        try { text = JSON.parse(message.content || "{}").text || ""; } catch { /* ignore */ }
        const chatId = message.chat_id || "";
        const messageId = message.message_id || "";
        try {
          if (cfg.adminOpenId && senderOpenId && senderOpenId !== cfg.adminOpenId) {
            return; // silently ignore non-admin
          }
          if (!cfg.adminOpenId && chatType !== "p2p") {
            return; // before admin is configured, only answer direct chats
          }
          if (!cfg.adminOpenId && senderOpenId) {
            log(`飞书收到消息，sender_open_id=${senderOpenId}（可设置 FEISHU_ADMIN_OPEN_ID 锁定管理员）`, "info");
          }
          const reply = await routeCommand(text);
          await client.im.v1.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ text: reply }), msg_type: "text" } });
          log(`飞书已回复：${text.slice(0, 40)}`, "info");
        } catch (error) {
          const detail = JSON.stringify(error?.response?.data?.field_violations || error?.response?.data || "");
          log(`飞书消息处理失败：${error.message} ${detail ? `| 明细 ${detail}` : ""}`, "error");
          try {
            await client.im.v1.message.reply({ path: { message_id: messageId }, data: { content: JSON.stringify({ text: `处理失败：${error.message}` }), msg_type: "text" } });
          } catch { /* ignore */ }
        }
      }
    })
  });
  log("飞书网关已启动（WebSocket 长连接）", "info");

  if (cfg.pushHourly) {
    setInterval(async () => {
      try {
        const text = await makerStatus();
        await pushToAdmin(`⏰ 定时盈亏播报\n${text}`);
      } catch (error) {
        log(`飞书定时推送失败：${error.message}`, "error");
      }
    }, 60 * 60 * 1000);
    log("飞书定时盈亏播报已启用（每小时）", "info");
  }
  // Daily recap at 12:30 Asia/Tokyo.
  const dailyPushed = { date: "" };
  setInterval(async () => {
    try {
      const now = new Date();
      const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
      if (hhmm === "12:30" && dailyPushed.date !== dateKey) {
        dailyPushed.date = dateKey;
        const text = await makerStatus();
        await pushToAdmin(`📅 每日复盘（12:30）\n${text}`);
        log("飞书每日复盘已推送", "info");
      }
    } catch (error) {
      log(`飞书每日复盘失败：${error.message}`, "error");
    }
  }, 60 * 1000);
  log("飞书每日复盘已启用（每天 12:30 东京时间）", "info");
  return { pushToAdmin };
}
