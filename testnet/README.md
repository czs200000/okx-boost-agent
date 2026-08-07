# X Layer Testnet Deployment — OKX Boost Agent

This folder contains the on-chain testnet artifact for the **OKX Boost Agent**
submission to the OKX Build X "AI Season" Hackathon (Aug 7 – Aug 21, 2026).

## Requirement mapping

| Hackathon requirement | How OKX Boost Agent satisfies it |
| --- | --- |
| AI element in the product | DeepSeek LLM advisor drives trade analysis; deterministic risk core is the final authority |
| Deployed on X Layer | Agent executes market-making on X Layer; this ledger contract is deployed on X Layer testnet |
| Testnet deployment during hackathon | `OKXBoostAgentLedger.sol` deployed on X Layer testnet (see below), mainnet live since Aug 2026 |
| Independent X account + post @XLayerOfficial | @<your-handle> (see submission form) |

## Contract

`contracts/OKXBoostAgentLedger.sol` — an on-chain decision ledger. The agent appends
every trading decision (`BUY` / `SELL` / `HOLD`, token, 8-decimal price, timestamp)
and emits heartbeats, making its behavior auditable on-chain.

## Network

- Name: X Layer testnet
- Chain ID: `1952`
- RPC: `https://testrpc.xlayer.tech/terigon`
- Explorer: `https://www.okx.com/web3/explorer/xlayer-test`
- Faucet (0.2 testnet OKB / day): `https://www.okx.com/xlayer/faucet/xlayerfaucet`

## Deploy

```bash
cd testnet/deploy
npm install
cp .env.example .env   # set PRIVATE_KEY (throwaway testnet key only!)
npm run deploy         # compiles + deploys, writes ../deployments/deployed.json
npm run seed           # records sample decisions + heartbeat
```

## Current deployment

- Contract: **`0x53A35F8f5B1fcb5Dd7154216BC0ad892FbaB8B6e`** (OKXBoostAgentLedger)
- Deploy tx: `0xc932ce0ab8af07ed6f654047f121655f2a9bbadba100dcae77a08f0509a5149c`
- Block: `37660871` · Chain ID: `1952`
- Explorer: <https://www.okx.com/web3/explorer/xlayer-test/address/0x53A35F8f5B1fcb5Dd7154216BC0ad892FbaB8B6e>
- On-chain state: `decisionCount = 3` (BUY / SELL / HOLD samples + heartbeat)

See [`deployments/deployed.json`](deployments/deployed.json) for the machine-readable
record. The address is also referenced by [`demo/index.html`](demo/index.html).

> ⚠️ The private key used for testnet deployment is a throwaway testnet-only key
> with no mainnet funds. Never reuse it, and never commit `.env`.
