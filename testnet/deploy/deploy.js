import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://testrpc.xlayer.tech/terigon";
const CHAIN_ID = Number(process.env.CHAIN_ID || 195);
const AGENT_NAME = process.env.AGENT_NAME || "OKX Boost Agent";

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY is required (see .env.example)");
  process.exit(1);
}

const contractPath = fileURLToPath(new URL("../contracts/OKXBoostAgentLedger.sol", import.meta.url));
const source = readFileSync(contractPath, "utf8");

const input = {
  language: "Solidity",
  sources: { "OKXBoostAgentLedger.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter(e => e.severity === "error");
if (errors.length) {
  console.error(errors.map(e => e.formattedMessage).join("\n"));
  process.exit(1);
}

const contract = output.contracts["OKXBoostAgentLedger.sol"].OKXBoostAgentLedger;
const abi = contract.abi;
const bytecode = "0x" + contract.evm.bytecode.object;

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`Deployer  : ${wallet.address}`);
console.log(`Balance   : ${ethers.formatEther(balance)} testnet OKB`);
if (balance < 10000000000000000n) {
  console.error("Insufficient testnet OKB for gas (need >= 0.01). Claim from https://www.okx.com/xlayer/faucet/xlayerfaucet");
  process.exit(1);
}

const factory = new ethers.ContractFactory(abi, bytecode, wallet);
const deployTx = await factory.deploy(AGENT_NAME);
await deployTx.waitForDeployment();
const address = await deployTx.getAddress();
const receipt = await deployTx.deploymentTransaction().wait();

const deployed = {
  chainId: CHAIN_ID,
  rpc: RPC_URL,
  agentName: AGENT_NAME,
  address,
  txHash: receipt.hash,
  blockNumber: receipt.blockNumber,
  deployedAt: new Date().toISOString()
};

const outDir = fileURLToPath(new URL("../deployments", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL("../deployments/deployed.json", import.meta.url), JSON.stringify(deployed, null, 2));
console.log("Deployed OKXBoostAgentLedger ->", address);
console.log("Tx hash:", receipt.hash);
console.log("Saved  : testnet/deployments/deployed.json");
