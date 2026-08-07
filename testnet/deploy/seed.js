import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://testrpc.xlayer.tech/terigon";
const CHAIN_ID = Number(process.env.CHAIN_ID || 195);
let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!CONTRACT_ADDRESS) {
  try {
    const deployed = JSON.parse(
      readFileSync(fileURLToPath(new URL("../deployments/deployed.json", import.meta.url)), "utf8")
    );
    CONTRACT_ADDRESS = deployed.address;
  } catch {
    console.error("CONTRACT_ADDRESS is required (or deploy first)");
    process.exit(1);
  }
}

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY is required");
  process.exit(1);
}

// Sample decisions mirror the maker rotation strategy (NVDAx, X Layer).
const samples = [
  ["BUY", "NVDAx", 223.87628639],
  ["SELL", "NVDAx", 224.35471251],
  ["HOLD", "NVDAx", 224.11429875]
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const abi = [
  "function recordDecision(string action, string token, uint256 price) external",
  "function heartbeat() external",
  "function decisionCount() view returns (uint256)"
];
const ledger = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

for (const [action, token, price] of samples) {
  const price8 = ethers.parseUnits(price.toFixed(8), 8);
  const tx = await ledger.recordDecision(action, token, price8);
  const receipt = await tx.wait();
  console.log(`recorded ${action} ${token} @ ${price} (tx ${receipt.hash.slice(0, 18)}…)`);
}

await (await ledger.heartbeat()).wait();
const count = await ledger.decisionCount();
console.log("Ledger decisionCount =", count.toString());
