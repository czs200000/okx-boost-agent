import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";
const CHAIN_TOKENS = Object.freeze({
  xlayer: Object.freeze({
    NVDAx: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
    SNDKx: "0xb63efbc28860c8097e341de1fcf59456161e9d98",
    SPCXx: "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28",
    CRCLx: "0xfebded1b0986a8ee107f5ab1a1c5a813491deceb",
    SKHYx: "0x58100046a4afcd4ee4fadbd4244f3f895a341c56"
  }),
  bsc: Object.freeze({
    AEON: "0x277add739c6e0477616948357af9e79fe1ec9b80",
    BNB: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
  })
});
const CHAIN_ID = Object.freeze({ xlayer: "196", bsc: "56" });
const caches = {};
const priceCaches = {};
const options = { timeout: 20000, maxBuffer: 2 * 1024 * 1024 };

export const xLayerRwaTokens = CHAIN_TOKENS.xlayer;
export const aeonTokens = CHAIN_TOKENS.bsc;

export function chainTokens(chain) {
  return CHAIN_TOKENS[chain] || {};
}

export async function readMarketPrices(force = false, chain = "xlayer") {
  const tokens = chainTokens(chain);
  const cache = priceCaches[chain] || (priceCaches[chain] = { at: 0, value: null });
  if (!force && cache.value && Date.now() - cache.at < 15000) return cache.value;
  const tokenArg = Object.values(tokens).map(address => `${CHAIN_ID[chain]}:${address}`).join(",");
  if (!tokenArg) return { fetchedAt: new Date().toISOString(), prices: {} };
  const namesByAddress = Object.fromEntries(Object.entries(tokens).map(([name, address]) => [address, name]));
  try {
    const { stdout } = await execFileAsync(cli, ["market", "prices", "--tokens", tokenArg], options);
    const prices = JSON.parse(stdout)?.data || [];
    const value = {
      fetchedAt: new Date().toISOString(),
      prices: Object.fromEntries(prices.map(item => [namesByAddress[item.tokenContractAddress], Number(item.price)]))
    };
    priceCaches[chain] = { at: Date.now(), value };
    return value;
  } catch {
    return cache.value || { fetchedAt: null, prices: {} };
  }
}

export async function readOnchainSnapshot(force = false, chain = "xlayer") {
  const cache = caches[chain] || (caches[chain] = { at: 0, value: null });
  if (!force && cache.value && Date.now() - cache.at < 30000) return cache.value;
  try {
    const [market, { stdout: balanceStdout }] = await Promise.all([
      readMarketPrices(false, chain),
      execFileAsync(cli, ["wallet", "balance", "--chain", chain], options)
    ]);
    const balance = JSON.parse(balanceStdout)?.data || {};
    const value = {
      fetchedAt: new Date().toISOString(),
      prices: market.prices,
      wallet: {
        totalValueUsd: Number(balance.totalValueUsd || 0),
        assets: (balance.details || []).flatMap(detail => detail.tokenAssets || []).map(asset => ({
          symbol: asset.symbol,
          balance: asset.balance,
          usdValue: Number(asset.usdValue || 0),
          tokenAddress: asset.tokenAddress || null
        }))
      }
    };
    caches[chain] = { at: Date.now(), value };
    return value;
  } catch {
    return cache.value || { fetchedAt: null, prices: {}, wallet: { totalValueUsd: 0, assets: [] } };
  }
}
