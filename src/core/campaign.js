export const xLayerRwaCampaign = Object.freeze({
  id: "xlayer-rwa",
  officialActivityId: 162,
  name: "X Layer RWA Trading Competition",
  chain: "x-layer",
  rewardPoolUsd: 50000,
  rewardedRanks: 600,
  minimumTradeUsd: 1,
  minimumLeaderboardVolumeUsd: 100,
  competitionTokens: [
    { symbol: "NVDAx", address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d" },
    { symbol: "SNDKx", address: "0xb63efbc28860c8097e341de1fcf59456161e9d98" },
    { symbol: "SPCXx", address: "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28" },
    { symbol: "CRCLx", address: "0xfebded1b0986a8ee107f5ab1a1c5a813491deceb" },
    { symbol: "SKHYx", address: "0x58100046a4afcd4ee4fadbd4244f3f895a341c56" }
  ],
  quoteTokens: ["USDG", "OKB", "WOKB", "USDT", "USDC"],
  apiOrdersCount: false,
  executionPolicy: "agentic-supported",
  rewards: [
    { from: 4, to: 20, amountUsd: 275 },
    { from: 21, to: 50, amountUsd: 195 },
    { from: 51, to: 100, amountUsd: 140 },
    { from: 101, to: 200, amountUsd: 95 },
    { from: 201, to: 400, amountUsd: 70 },
    { from: 401, to: 600, amountUsd: 35 }
  ]
});

export const aeonCampaign = Object.freeze({
  id: "aeon",
  officialActivityId: 167,
  shortName: "aeon",
  name: "AEON Trading Competition",
  chain: "bsc",
  chainId: 56,
  chainLabel: "BNB Chain",
  rewardTokenSymbol: "AEON",
  rewardTokenAddress: "0x277add739c6e0477616948357af9e79fe1ec9b80",
  rewardPoolTokens: 1000000,
  rewardPoolUsd: 60000,
  rewardedRanks: 1000,
  minimumTradeUsd: 1,
  minimumLeaderboardVolumeUsd: 100,
  competitionTokens: [
    { symbol: "AEON", address: "0x277add739c6e0477616948357af9e79fe1ec9b80" }
  ],
  quoteTokens: ["USDT", "USDC", "BNB", "WBNB", "BUSD"],
  apiOrdersCount: false,
  executionPolicy: "agentic-supported",
  rewards: [
    { from: 1, to: 1, amountToken: 29470 },
    { from: 2, to: 2, amountToken: 17300 },
    { from: 3, to: 3, amountToken: 10175 },
    { from: 4, to: 10, amountToken: 6165 },
    { from: 11, to: 50, amountToken: 3735 },
    { from: 51, to: 100, amountToken: 2260 },
    { from: 101, to: 200, amountToken: 1370 },
    { from: 201, to: 500, amountToken: 810 },
    { from: 501, to: 1000, amountToken: 515 }
  ]
});

export function campaignAllowsAutonomousExecution(campaign, attributionVerified) {
  if (campaign.executionPolicy === "agentic-supported") return true;
  return campaign.executionPolicy === "unverified-agentic" && attributionVerified;
}
