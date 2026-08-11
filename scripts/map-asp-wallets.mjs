#!/usr/bin/env node
// Map hackathon ASP names -> owner wallets via the OKX.AI agent marketplace.
// Output: data/asp-wallets.json
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";

const names = [
  "大招交易", "Signal tracking maniac", "链上聪明钱", "ToxicFlow Radar",
  "Market Signal Desk", "PolyDesk", "Lolah", "ST Quant",
  "FunnySir Onchain Analyst", "XAI Pulse", "Àkànjí Oníṣòwò", "AlphaTerminal",
  "Undisputed", "超预测事件交易", "pasignal",
  "PREX · 合约信号", "VailElla", "VeraX", "韧性交易者 · Resilience Trader",
  "Perp Trend Radar", "Crosswind", "CreaoAI Hackathon Agent", "龙骨",
  "Alphio Quant", "CounterPeak AI", "信号共振", "JOJO Quant", "AlphaGate",
  "Cohesion Capital", "聪明钱合约信号", "Plumb", "Keda's", "磐衡量化",
  "Obelisk", "AlphaGreed", "WatchFill", "链上趋势哨兵", "CoAgentic Council",
  "Otto AI", "EVIDIQ Helm", "Optic Trader", "Tidewatch Labs", "oudima",
  "呆瓜小贱", "CongressAgent", "DeskSeven", "夜猫PERP", "TradeBook",
  "RelayFills", "Ethy AI", "SideCard", "Alpha Engine", "SmartMoney Alpha",
  "Pools Sentine", "HuaQuant", "网格智投 · OKB GridBot", "Tachyo",
  "币世策略机器人", "Minara", "PumpFader", "SignalXYZ",
  "Stock BreakOut Signal", "Nexus-8 Signals", "1M · 斯巴达"
];

async function run(args) {
  const { stdout } = await execFileAsync(cli, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

const results = [];
for (const name of names) {
  try {
    const search = await run(["agent", "search", "--query", name, "--page-size", "3"]);
    const hit = search?.data?.list?.[0];
    if (!hit) {
      results.push({ name, agentId: null, owner: "", note: "no match" });
      continue;
    }
    const detail = await run(["agent", "get-agents", "--agent-ids", String(hit.agentId)]);
    const a = detail?.data?.[0] || {};
    results.push({
      name,
      matchedName: a.name || hit.name || "",
      agentId: a.agentId || hit.agentId || "",
      owner: a.ownerAddress || "",
      comm: hit.communicationAddress || ""
    });
  } catch (error) {
    results.push({ name, agentId: null, owner: "", note: error.message });
  }
}

writeFileSync(new URL("../data/asp-wallets.json", import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
