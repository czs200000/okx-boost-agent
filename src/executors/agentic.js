import { execFile } from "node:child_process";

const cli = process.env.ONCHAINOS_CLI || "onchainos";
const USDT_BY_CHAIN = Object.freeze({
  xlayer: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  bsc: "0x55d398326f99059ff775485246999027b3197955"
});

const run = args => new Promise(resolve => {
  execFile(cli, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    let payload;
    try { payload = JSON.parse(stdout || stderr); } catch { payload = { ok: false, error: stderr || error?.message || "CLI error" }; }
    resolve({ exitCode: error?.code && Number.isInteger(error.code) ? error.code : 0, payload });
  });
});

const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export class AgenticWalletExecutor {
  constructor({ enabled = false, walletAddress, tokens, maxSlippageBps = 15, chain = "xlayer", quoteTokenAddress = USDT_BY_CHAIN[chain] || USDT_BY_CHAIN.xlayer } = {}) {
    this.enabled = enabled;
    this.walletAddress = walletAddress;
    this.tokens = tokens;
    this.maxSlippageBps = maxSlippageBps;
    this.chain = chain;
    this.quoteTokenAddress = quoteTokenAddress;
  }

  resolve(plan, snapshot) {
    const tokenAddress = this.tokens[plan.token];
    if (!tokenAddress) throw new Error("Unsupported competition token");
    if (plan.action === "BUY") return { from: this.quoteTokenAddress, to: tokenAddress, amount: Number(plan.amountUsd).toFixed(2) };
    const isNative = String(tokenAddress).toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
    const asset = isNative
      ? snapshot.wallet.assets.find(item => !item.tokenAddress
          && String(item.symbol || "").toUpperCase() === String(plan.token).toUpperCase())
      : snapshot.wallet.assets.find(item => item.tokenAddress?.toLowerCase() === tokenAddress);
    const available = Number(asset?.balance || 0);
    // Lot exits use an explicit token amount; legacy exits still fall back to
    // closing the currently available token balance.
    const requested = Number(plan.amountToken || 0);
    const amount = requested > 0 ? Math.min(requested, available) : available;
    if (!(amount > 0)) throw new Error(`No ${plan.token} balance available to sell`);
    const safeAmount = Math.floor(amount * 1e12) / 1e12;
    return { from: tokenAddress, to: this.quoteTokenAddress, amount: safeAmount.toFixed(12) };
  }

  async quote(plan, snapshot) {
    const pair = this.resolve(plan, snapshot);
    return this.quotePair(pair);
  }

  async quotePair(pair) {
    const result = await run(["swap", "quote", "--from", pair.from, "--to", pair.to, "--readable-amount", pair.amount, "--chain", this.chain]);
    const route = result.payload?.data?.[0];
    if (!result.payload?.ok || !route) throw new Error(result.payload?.error || "No swap route");
    return {
      ...pair,
      action: route.action,
      reason: route.reason || "",
      priceImpactPct: Number(route.priceImpactPercent || 0),
      fromAmount: Number(route.fromTokenAmount) / (10 ** Number(route.fromToken.decimal)),
      toAmount: Number(route.toTokenAmount) / (10 ** Number(route.toToken.decimal)),
      fromSymbol: route.fromToken.tokenSymbol,
      toSymbol: route.toToken.tokenSymbol,
      // The OnchainOS CLI documents tradeFee as an absolute USD value.
      tradeFeeUsd: Number(route.tradeFee || 0),
      gasLimit: Number(route.estimateGasFee || 0),
      route: (route.dexRouterList || []).map(item => item.dexProtocol?.dexName).filter(Boolean)
    };
  }

  async quoteRoundTrip(plan, snapshot) {
    const outbound = await this.quote(plan, snapshot);
    if (plan.action !== "BUY") return { outbound, returnQuote: null, roundTripLossUsd: null, roundTripLossBps: null };
    const returnQuote = await this.quotePair({
      from: outbound.to,
      to: outbound.from,
      amount: String(outbound.toAmount)
    });
    const roundTripLossUsd = Math.max(0, Number(outbound.fromAmount) - Number(returnQuote.toAmount));
    const roundTripLossBps = outbound.fromAmount > 0 ? roundTripLossUsd / outbound.fromAmount * 10000 : Infinity;
    return { outbound, returnQuote, roundTripLossUsd, roundTripLossBps };
  }

  async execute(plan, snapshot, quote) {
    if (!this.enabled) {
      throw new Error("Agentic execution is locked until wallet setup and Boost attribution verification are complete");
    }
    if (!this.walletAddress) throw new Error("Agentic Wallet address is unavailable");
    if (quote.action === "block") throw new Error(`BLOCK: ${quote.reason || "route rejected by OKX risk controls"}`);
    if (quote.action === "warn") throw new Error(`WARN: ${quote.reason || "route requires manual review"}`);
    if (quote.priceImpactPct * 100 > this.maxSlippageBps) throw new Error("Quote exceeds configured slippage/impact limit");
    const args = ["swap", "execute", "--from", quote.from, "--to", quote.to, "--readable-amount", quote.amount, "--chain", this.chain, "--wallet", this.walletAddress, "--gas-level", "average", "--max-auto-slippage", String(this.maxSlippageBps / 100)];
    const result = await run(args);
    if (result.exitCode === 2 || result.payload?.confirming) {
      return { status: "CONFIRMING", message: result.payload?.message || result.payload?.error || "Wallet confirmation required", next: result.payload?.next || null };
    }
    if (!result.payload?.ok) throw new Error(result.payload?.error || "Swap execution failed");
    const data = result.payload.data || {};
    return {
      status: "BROADCAST",
      txHash: data.swapTxHash,
      approveTxHash: data.approveTxHash || null,
      // CLI execution amounts may be returned in base units. The immediately
      // preceding quote is already decimal-normalized and is safe for state.
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      priceImpactPct: Number(data.priceImpact || quote.priceImpactPct),
      nextSteps: data.nextSteps || null
    };
  }
}
