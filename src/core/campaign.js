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
    { symbol: "SPCXx", address: "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28" }
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

export function campaignAllowsAutonomousExecution(campaign, attributionVerified) {
  if (campaign.executionPolicy === "agentic-supported") return true;
  return campaign.executionPolicy === "unverified-agentic" && attributionVerified;
}
