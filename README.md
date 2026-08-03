# OKX Boost Agent Workflow

A local-first dashboard that combines deterministic trading logic, optional DeepSeek analysis, live liquidity sizing, OKX Agentic Wallet execution, and Boost leaderboard tracking on X Layer.

> **Important:** This is experimental software, not financial advice. Real trading can lose money. Competition rules can change, and abnormal, manipulative, circular, or wash trading may be excluded or disqualified. Review the current campaign terms before enabling execution.

## Features

- Safe paper-mode defaults; real execution is opt-in.
- Optional DeepSeek advisor with deterministic local controls as the final authority.
- Single-position mean-reversion strategy for NVDAx, SNDKx, and SPCXx.
- Liquidity-aware sizing with two-sided quote checks and configurable round-trip-loss limits.
- Slippage, exposure, frequency, loss, and campaign-cost controls.
- Automatic pause on OKX `warn`, `block`, or wallet-confirmation responses.
- Live X Layer wallet holdings and local transaction-volume accounting.
- Official Boost volume, rank, reward estimate, leaderboard minimum, and next-tier target polling.
- Responsive local control-room UI with start, stop, and manual synchronization controls.

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

- Samples market prices every autonomous cycle.
- Monitors market prices every 30 seconds by default, evaluates the strategy every 60 seconds, and refreshes AI analysis every 120 seconds.
- Requires a configurable discount below the rolling mean before buying.
- Holds one primary competition-token position at a time.
- Exits on take-profit, stop-loss, or maximum holding time.
- Tests descending notional sizes against outbound and immediate return quotes.
- Executes only when route classifications and configured cost limits pass.
- Treats a near-zero-loss quote as an objective, never a guarantee.

## Configuration

All runtime settings are documented in [.env.example](.env.example). Important groups include:

- `AUTONOMOUS_*`: execution enablement and cycle timing
- `MIN_SIGNAL_BPS`, `TAKE_PROFIT_BPS`, `STOP_LOSS_BPS`: strategy thresholds
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
- The current strategy is single-account and single-position; it is not safe to switch active accounts while running.
- No strategy can guarantee profit, zero loss, leaderboard eligibility, or rewards.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues containing credentials, wallet-session data, or exploitable transaction details.

## License

MIT — see [LICENSE](LICENSE).
