# OKX Boost Agent — 会话交接文档

> 更新：2026-08-11（黑客松进行中）。切换模型后请先读本文件，再读 `README.md` 与 `.env`（注意不泄露密钥）。

## 1. 项目概览

本系统是运行在本机（macOS）的 **OKX X Layer 高频网格做市 + 交易赛自动化系统**（OKXBoostAgent）：

- **Maker 做市**：X Layer 链上多币种网格交易（限价单低买高卖），当前运行 OKB + CRCLx 两个网格
- **黑客松参赛**：OKX.AI 交易黑客松第一季（8/11-8/25），以 Trading ASP「网格智投 · OKB GridBot」报名参赛，排名按收益率 PnL% + 净盈亏
- **飞书机器人**：查看盈亏/控制台/命令执行/定时播报
- **控制台 UI**：本地 Web 面板（端口 4310），财务汇总、各项目 P&L、钱包资产趋势

## 2. 环境与连接（关键）

- 工作目录：`/Users/office/Documents/okx.agents`（软链 → `/Users/office/Library/Application Support/OKXBoostAgent`）
- 服务：launchd `com.okx.boost-agent`；改代码后 `launchctl kickstart -k gui/$(id -u)/com.okx.boost-agent` 重启
- **网络代理**：所有联网命令（onchainos/curl/git push）必须带 `HTTPS_PROXY=http://127.0.0.1:1082 http_proxy=http://127.0.0.1:1082`，否则超时
- 钱包：OKX Agentic Wallet（邮箱 dinkundefined19841@gmail.com），EVM `0x33441af57ff0a08a8747d68dde5a6ebb25584f64`，链 X Layer（196）
- 凭证均在 `.env`（gitignore），**绝不打印/回显 App Secret、私钥等**

## 3. 当前交易配置与状态（2026-08-11）

### Maker 网格
| 网格 | 状态 | 配置 | 当前状态 |
|---|---|---|---|
| OKB（原生 `0xeeee...`） | ✅ 运行 | 8 格 / 50bps 间距 / **+150bps 止盈** / 90% 部署 / 0.08% 费 + $0.01 gas | mid ~95.3，已实现 +$1.99 |
| CRCLx（`0xfebded1b...`） | ✅ 运行（独立模块） | 8 格 / 50bps / +150bps / 40% 部署 / **0 费** | mid ~67.0，刚启动 |
| NVDAx（`0xc845b2...`） | ⏸️ 已停（`MAKER_GRID_MAIN_ENABLED=false`） | 12 格 / 50bps / +50bps / 45% | 4 格持仓保留，已实现 +$12.27 |

### 关键机制（新模型必须理解）
- **资金预算闸门**（`MAKER_GRID_BUDGET_PCT=90`）：两/三网格买单总额 ≤ 可用 USDT×90%，按部署比例分配；超出自动跳过买单档位（日志「资金预算闸门：跳过第N格买单」是正常保护）
- **卖出止盈单强制挂出**：挂卖单时传给平台的 currentPrice 强制低于止盈价（`order.price*0.995`），确保平台按“止盈单”派生、不会因价格源偏高被误判为已触发止损单而市价卖出
- **真实成交价记账**：OKB 卖出按链上实际成交价入账（`fetchLastSellPrice`），杜绝假盈利
- **gas 储备**：OKB 网格保留 0.05 OKB 不可卖（`MAKER_GRID_EXTRA_GAS_RESERVE`）
- **连亏熔断**：连亏 3 轮冷却 10 分钟 + K 线企稳恢复；两币合计硬止损 -$15

### 重要历史（为什么代码长这样）
1. **OKB 假账问题（已修复）**：OKX 余额接口对原生 OKB 读数不稳定（曾报 0.838 而链上实为 0.4008），导致网格按余额变动凭空记账、卖出单被误判止损提前市价成交 → 面板显示假盈利。修复：权威余额源（portfolio/RPC）+ 卖出防误触发 + 真实成交价记账
2. **价格源偏差**：OKB 价格源偶尔比 DEX 实际成交价高 0.5-0.9%，加宽止盈到 150bps 后仍有安全垫
3. **控制台口径**：总盈亏 = 钱包总资产 − 基准（`TOTAL_CAPITAL_USD=1650.14`，8/7 校准），包含历史亏损（RWA 旧策略 -$30、早期 CRCLx -$21 等），Maker 盈利在填坑中；**用户只看“钱包总资产”作为真实口径**（已加钱包资产 1h/24h 趋势显示）

## 4. 黑客松参赛（OKX.AI Trading Hackathon S1）

- ASP：**网格智投 · OKB GridBot**（ID **10744**，X Layer，已上架/在线）
- 服务：OKB 网格交易信号（5 USDT/月 + 3 天免费试用）——**我们收订阅费，不是支出**
- 报名：✅ 已成功（web3，钱包 0x3344...，2026-08-11 01:40:55 UTC `registered:true`）
- 比赛：8/11 12:00 UTC+8 – 8/25 12:00 UTC+8；排名按收益率 + 净盈亏；Onchain OS 口径（链上交易都计入）
- 当前排名：约 **57 名**（-0.13%，-$2 左右）——比赛早期，正常
- 后台监控脚本 `scripts/asp-review-watch.sh`（launchd `com.okx.asp-review-watch`）已完成使命（报名成功），无需再跑
- A2A 守护进程 `okx-a2a`（launchd `com.okx.a2a`）保持运行，ASP 在线
- ⚠️ 参赛期间保持 Mac 开机不休眠；勿删除订阅服务（会失格）

### 参赛选手钱包分析（用户关心）
- 已建映射表 `data/asp-wallets.json`（64 个 ASP 名称→所有者钱包，模糊匹配，需谨慎）
- **关键限制**：参赛者用独立交易钱包（非 ASP 所有者钱包），公开数据拿不到交易钱包；唯一可分析样本 HuaQuant（0x9c4141...，SOL+XDOG 高频小额，胜率 31%，微亏）
- 第一名「大招交易」agent #10603 所有者钱包 0x9eb3...（近 7 天仅 2 笔小额买入，非交易钱包）
- 用户可能继续要求分析排行榜选手策略——需要交易钱包地址（浏览器控制或用户提供）

## 5. 飞书集成

- 已启用（`FEISHU_ENABLED=true`，App ID `cli_a96248fba9385bd5`，Secret 在 .env）
- 管理员 open_id：`ou_7a1cb092991bb01767edbc8a9fca10d2`（仅该账号可命令）
- 支持命令：查看 maker 盈亏 / 控制台 / 钱包 / 黑客松状态 / 启动停止 maker / 修改请求（记录到 `data/feishu-pending.json` 需 Codex 会话确认执行）
- 每小时盈亏播报 + 每天 12:30（东京）复盘推送
- 与 Hermes 飞书机器人**独立应用、无冲突**

## 6. 工具与脚本

- `scripts/backtest-okb-grid.mjs`：网格回测（支持 `--token-address`、`--from/--to` 日期、`--levels/--spacing-bps/--profit-bps/--deploy-pct` 等）
- `scripts/map-asp-wallets.mjs`：ASP 名称→钱包映射
- `scripts/asp-review-watch.sh`：黑客松报名监控（已完成）
- 常用验证：`onchainos agent get-agents --agent-ids <id>`、`onchainos market portfolio-overview --address <addr> --chain xlayer`、链上 RPC `eth_getBalance`

## 7. 用户偏好与沟通

- 中文交流；用户重视**真实盈亏**（只信钱包总资产），讨厌虚假/虚增数据
- 用户希望我**主动提策略优化建议**，不等他问
- 策略调整前先回测给数据，确认后再执行；执行策略变更需明确确认
- 止损/风控优先（目标是 0 损耗 + 交易量）
- 用户可能随时要求：切换网格币种、调参数、查黑客松排名、分析选手策略、飞书命令

## 8. 安全注意事项

- `.env` 含密钥（Feishu App Secret 等），**任何对话/日志不得回显**
- 黑客松报名不可逆；交易/合约操作需用户确认
- 涉及资金的操作（撤单、启停网格、改部署）先读当前状态再执行
