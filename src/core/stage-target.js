export function nextStageTarget({ localVolumeUsd, currentTargetUsd, nextTierUsd }) {
  const local = Number(localVolumeUsd);
  const current = Number(currentTargetUsd);
  const nextTier = Number(nextTierUsd);
  if (![local, current, nextTier].every(Number.isFinite)) return current;
  return local >= current && nextTier > current ? nextTier : current;
}
