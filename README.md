# OKX Boost Agent Workflow

A local-first dashboard that combines deterministic trading logic, optional DeepSeek analysis, live liquidity sizing, OKX Agentic Wallet execution, and Boost leaderboard tracking. It runs two independent campaigns:

- **X Layer RWA** — grid trading of RWA stock tokens on X Layer (0-gas).
- **AEON (BNB Chain)** — AEON/USDT dip-buy / rebound-sell market making for the AEON Boost trading competition, with a live BSC gas-cost gate that holds entries when network fees are uneconomical.

> **Important:** This is experimental software, not financial advice. Real trading can lose money. Competition rules can change, and abnormal, manipulative, circular, or wash trading may be excluded or disqualified. Review the current campaign terms before enabling execution.

## Features

- Safe paper-mode defaults; real execution is opt-in.
- Optional DeepSeek advisor with deterministic local controls as the final authority.
- Independent per-token positions driven by executable X Layer quotes.
- Liquidity-aware sizing with two-sided quote checks and configurable round-trip-loss limits.
- Slippage, exposure, frequency, loss, and campaign-cost controls.
- Automatic pause on OKX `warn`, `block`, or wallet-confirmation responses.
- Live X Layer wallet holdings and local transaction-volume accounting.
- Official Boost volume, rank, reward estimate, leaderboard minimum, and next-tier target polling.
- Responsive local control-room UI with start, stop, and manual synchronization controls.
- Multi-campaign tabbed UI: independent stores, risk gates, controls, and official leaderboards per competition.
- AEON module: BSC wallet asset panel, official leaderboard table, gas-gate status, and grid strategy parameters.
- Maker rotation module: NVDAx limit-order market making — strict buy/sell alternation, 12s order life, inventory neutral, loss/cool-down circuit breakers, maintenance window 03–07 UTC.

## Maker rotation (X Layer RWA)

Modeled on the top-200 leaderboard wallets (single token, ~10s holds, perfectly
symmetric buy/sell alternation). The module places short-life OKX limit orders
3 bps below/above mid on NVDAx, cancels and re-places them every `MAKER_ORDER_TTL_MS`,
and keeps inventory neutral so realized PnL comes from spread capture, not
direction. Sized by `MAKER_LEG_USD` (default 200) and capped by
`MAKER_MAX_INVENTORY_USD`. Inventory that cannot exit within `MAKER_MAX_HOLD_MS`
fast-exits at `MAKER_FAST_EXIT_TRIGGER_BPS` below mid, and a `MAKER_STOP_LOSS_BPS`
floor stops out inventory that drifts too far below its cost basis. Set
`MAX_TRADE_NVDA_USD=0` so the dip strategy does not fight the maker module for the
same token.

## AEON (BNB Chain) module

The AEON competition counts AEON trades against USDT/USDC/BNB/WBNB/BUSD on BNB Chain through OKX DEX only (DEX API orders and third-party router orders are excluded). The module:

- Buys AEON only when the OKX DEX ask dips a configured number of basis points below its rolling mean (`AEON_ENTRY_DIP_BPS`, default 30) **and** the executable bid is not collapsing (`AEON_MIN_BID_TREND_BPS`), with a minimum net edge over round-trip cost (`AEON_MIN_ENTRY_NET_EDGE_BPS`, default 15).
- Sells each lot at the profit target `AEON_EXIT_GAIN_BPS` (default 100 bps) and cuts losses at `AEON_STOP_LOSS_BPS` (default 200 bps) so a single lot can never bleed beyond ~2%. A realized-loss circuit breaker (`AEON_MAX_LOSS_USD`, default 20) stops the bot after repeated stop-outs.
- Single open lot by default (`AEON_MAX_GRID_LOTS=1`), so exposure is bounded and the only loss path is unrealized while waiting for the profit target.
- Holds entries when the live BSC gas cost exceeds `AEON_MAX_GAS_COST_USD_PER_SWAP` (fail-safe default: also holds when gas cannot be measured).
- Auto-unlocks autonomous execution when OKX reports `participationStatus = 2` for the connected wallet (or when `AEON_ATTRIBUTION_VERIFIED=true`).
- Tracks official volume, rank, leaderboard minimum, and the top-20 leaderboard from OKX every 60 seconds.

## Architecture

```text
DeepSeek (optional advice)
          |
          v
Deterministic signal strategy
          |
          v
Risk + two-sided liquidity quotes + economics gates
          |
          v
OKX Agentic Wallet / OnchainOS
          |
          v
X Layer transaction + local state + Boost status polling
```

DeepSeek cannot approve a trade or bypass local controls. If the API is unavailable, the system falls back to the deterministic strategy.

## Requirements

- Node.js 20 or newer
- The official [OKX OnchainOS CLI and skills](https://github.com/okx/onchainos-skills)
- An authenticated OKX Agentic Wallet for wallet reads or real execution
- A DeepSeek API key only if AI analysis is desired

## Quick start

```bash
cp .env.example .env
npm test
npm start
```

Open <http://127.0.0.1:4310>.

If `onchainos` is not on your `PATH`, set `ONCHAINOS_CLI` in `.env` to its executable path.

## Safe activation flow

The included `.env.example` cannot place real trades. Keep it in paper mode until all setup and verification steps are complete.

1. Authenticate Agentic Wallet locally.
2. Confirm the campaign, eligible chain, tokens, pairs, dates, and current rules.
3. Register using an officially supported route.
4. Run a small attribution test and verify that the official leaderboard counts it.
5. Test quotes and risk limits with conservative amounts.
6. Only then set:

```dotenv
EXECUTION_MODE=agentic
AUTONOMOUS_ENABLED=true
BOOST_ATTRIBUTION_VERIFIED=true
```

Restart the service after changing `.env`.

## Strategy summary

- Samples executable buy and immediate-return quotes every autonomous cycle.
- Monitors held positions and evaluates the strategy independently for each enabled token.
- Requires a configurable executable-ask discount before buying.
- Supports multiple grid lots per enabled token, so one underwater lot does not block new lower entries or other tokens.
- Exits only when fresh executable proceeds exceed that specific lot's recorded entry cost and configured net-profit buffer.
- Tests descending notional sizes against outbound and immediate return quotes.
- Executes only when route classifications and configured cost limits pass.
- Treats a near-zero-loss quote as an objective, never a guarantee.

## Configuration

All runtime settings are documented in [.env.example](.env.example). Important groups include:

- `AUTONOMOUS_*`: execution enablement and cycle timing
- `NVDA_ENTRY_SIGNAL_BPS`, `SNDK_ENTRY_SIGNAL_BPS`, `SPCX_ENTRY_SIGNAL_BPS`, `MIN_NET_EXIT_BPS`: executable-quote strategy thresholds
- `MAX_GRID_LOTS_PER_TOKEN`, `MAX_OPEN_GRID_LOTS`: multi-layer grid inventory limits
- `MAX_TRADE_*`: global and token-specific notional caps
- `MAX_ROUND_TRIP_LOSS_BPS`: two-sided quote loss ceiling
- `MAX_SLIPPAGE_BPS`: execution slippage ceiling
- `MAX_*_EXPOSURE_PCT`: wallet exposure limits
- `MAX_CAMPAIGN_COSTS_USD`: cumulative strategy cost budget

Setting a limit to `0` may disable it where supported. Do not copy somebody else's live values without understanding the consequences.

## Local data and credentials

The following are intentionally excluded from Git:

- `.env` and all API keys
- Agentic Wallet credentials and sessions
- `data/state.json`, positions, logs, and transaction history
- locally installed `.agents/` skills

Never commit API keys, wallet exports, seed phrases, private keys, session tokens, personal email addresses, or production state.

## Testing

```bash
npm run check
```

The tests cover strategy decisions, risk gates, liquidity sizing, economics, Boost response parsing, and dynamic reward-tier targets.

## Known limitations

- The Boost integration uses campaign-specific public web endpoints that may change.
- Official leaderboard updates can lag local transaction broadcasts.
- Agentic Wallet execution depends on the currently authenticated local account.
- The current strategy is single-account with independent grid lots per enabled token; it is not safe to switch active accounts while running.
- No strategy can guarantee profit, zero loss, leaderboard eligibility, or rewards.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues containing credentials, wallet-session data, or exploitable transaction details.

## License

MIT — see [LICENSE](LICENSE).
