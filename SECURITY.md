# Security Policy

## Reporting a vulnerability

Please report security issues privately to the repository owner. Do not include secrets, wallet credentials, private keys, seed phrases, session tokens, personal data, or active exploit details in a public issue.

Include:

- the affected version or commit;
- a concise reproduction;
- the potential impact;
- a suggested mitigation, if available.

## Operational guidance

- Start in paper mode.
- Use a dedicated wallet with limited funds.
- Keep `.env`, wallet sessions, and `data/state.json` private.
- Review every dependency and campaign rule before live use.
- Stop the service immediately if wallet, quote, or leaderboard data looks inconsistent.
