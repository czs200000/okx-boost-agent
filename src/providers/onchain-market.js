import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";
const tokens = Object.freeze({
  NVDAx: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
  SNDKx: "0xb63efbc28860c8097e341de1fcf59456161e9d98",
  SPCXx: "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28"
});

let cache = { at: 0, value: null };

export async function readOnchainSnapshot(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 30000) return cache.value;
  const tokenArg = Object.values(tokens).map(address => `196:${address}`).join(",");
  const options = { timeout: 20000, maxBuffer: 2 * 1024 * 1024 };
  try {
    const [{ stdout: pricesStdout }, { stdout: balanceStdout }] = await Promise.all([
      execFileAsync(cli, ["market", "prices", "--tokens", tokenArg], options),
      execFileAsync(cli, ["wallet", "balance", "--chain", "xlayer"], options)
    ]);
    const prices = JSON.parse(pricesStdout)?.data || [];
    const balance = JSON.parse(balanceStdout)?.data || {};
    const namesByAddress = Object.fromEntries(Object.entries(tokens).map(([name, address]) => [address, name]));
    const value = {
      fetchedAt: new Date().toISOString(),
      prices: Object.fromEntries(prices.map(item => [namesByAddress[item.tokenContractAddress], Number(item.price)])),
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
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache.value || { fetchedAt: null, prices: {}, wallet: { totalValueUsd: 0, assets: [] } };
  }
}

export { tokens as xLayerRwaTokens };
