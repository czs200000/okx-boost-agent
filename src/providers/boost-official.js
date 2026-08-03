const baseUrl = "https://web3.okx.com/priapi/v1/dapp/competition";

const finiteNumber = value => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseOfficialBoostResponse(personalPayload, rankPayload = null, checkedAt = new Date().toISOString()) {
  if (Number(personalPayload?.code) !== 0) throw new Error(personalPayload?.msg || personalPayload?.detailMsg || "OKX Boost API rejected the request");
  if (rankPayload && Number(rankPayload?.code) !== 0) throw new Error(rankPayload?.msg || rankPayload?.detailMsg || "OKX Boost rank API rejected the request");
  const data = personalPayload?.data || {};
  const rankData = rankPayload?.data || {};
  const mine = rankData.myPnlRankInfo || {};
  const volumeUsd = finiteNumber(mine.volume ?? mine.userTotal ?? data.volume ?? data.userTotal ?? data.tradingVolume ?? data.myVolume);
  const rankUpdateTime = finiteNumber(rankData.rankUpdateTime);
  return {
    checkedAt,
    officialUpdatedAt: rankUpdateTime ? new Date(rankUpdateTime).toISOString() : null,
    volumeUsd,
    rank: finiteNumber(mine.currentRank ?? data.currentRank ?? data.myRank),
    estimatedRewardUsd: finiteNumber(mine.expectedRewards ?? data.myExpectedReward) ?? 0,
    participationStatus: finiteNumber(data.participationStatus),
    minVolumeToRankUsd: finiteNumber(data.minVolumeToRank),
    nextTierVolumeUsd: finiteNumber(data.nextTierMetric),
    valueAvailable: volumeUsd != null
  };
}

export async function readOfficialBoostStatus({ activityId, walletAddress, fetchImpl = fetch }) {
  if (!walletAddress) throw new Error("Wallet address is unavailable");
  const personalUrl = new URL(`${baseUrl}/queryLeaderBoard`);
  personalUrl.searchParams.set("activityId", String(activityId));
  personalUrl.searchParams.set("tab", "1");
  personalUrl.searchParams.set("walletAddress", walletAddress);
  const rankUrl = new URL(`${baseUrl}/queryPnlRank`);
  rankUrl.searchParams.set("activityId", String(activityId));
  rankUrl.searchParams.set("sortType", "5");
  rankUrl.searchParams.set("tab", "1");
  rankUrl.searchParams.set("walletAddress", walletAddress);
  const options = {
    headers: { accept: "application/json", "user-agent": "OKX-Boost-Agent-Dashboard/0.1" },
    signal: AbortSignal.timeout(15000)
  };
  const [personalResponse, rankResponse] = await Promise.all([
    fetchImpl(personalUrl, options),
    fetchImpl(rankUrl, options)
  ]);
  if (!personalResponse.ok) throw new Error(`OKX Boost API HTTP ${personalResponse.status}`);
  if (!rankResponse.ok) throw new Error(`OKX Boost rank API HTTP ${rankResponse.status}`);
  return parseOfficialBoostResponse(await personalResponse.json(), await rankResponse.json());
}
