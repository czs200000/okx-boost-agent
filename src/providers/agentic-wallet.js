import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";

export async function readAgenticWalletStatus() {
  try {
    const options = { timeout: 15000, maxBuffer: 1024 * 1024 };
    const [{ stdout }, { stdout: addressesStdout }] = await Promise.all([
      execFileAsync(cli, ["wallet", "status"], options),
      execFileAsync(cli, ["wallet", "addresses"], options)
    ]);
    const payload = JSON.parse(stdout);
    const addressesPayload = JSON.parse(addressesStdout);
    const data = payload?.data || {};
    const addresses = addressesPayload?.data || {};
    return {
      connected: Boolean(data.loggedIn),
      accountName: data.currentAccountName || null,
      accountCount: Number(data.accountCount || 0),
      evmAddress: addresses.xlayer?.[0]?.address || addresses.evm?.[0]?.address || null,
      solAddress: addresses.solana?.[0]?.address || null,
      totalValueUsd: data.totalValueUsd || null
    };
  } catch {
    return {
      connected: false,
      accountName: null,
      accountCount: 0,
      evmAddress: null,
      solAddress: null,
      totalValueUsd: null
    };
  }
}
