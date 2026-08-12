// Pure logic for flow-based capital allocation between two grids.
// Shares deployed capital proportionally to each token's recent on-chain
// volume, clamped to [floorPct, capPct] so no grid is starved or overloaded.

export function allocateByVolume(volumeMain, volumeOther, totalDeployPct, floorPct, capPct) {
  const total = Math.max(0, Number(volumeMain) || 0) + Math.max(0, Number(volumeOther) || 0);
  if (total <= 0) {
    // No volume data: split evenly.
    const half = totalDeployPct / 2;
    return {
      main: clampPct(half, floorPct, capPct),
      other: clampPct(totalDeployPct - clampPct(half, floorPct, capPct), floorPct, capPct)
    };
  }
  const mainShare = Math.max(0, Number(volumeMain) || 0) / total;
  let mainPct = clampPct(totalDeployPct * mainShare, floorPct, capPct);
  let otherPct = clampPct(totalDeployPct - mainPct, floorPct, capPct);
  // If the floor/cap clamps pushed the sum above the total, shrink the larger
  // side so the combined deployment never exceeds the target.
  if (mainPct + otherPct > totalDeployPct) {
    if (mainPct >= otherPct) {
      mainPct = Math.max(floorPct, totalDeployPct - otherPct);
    } else {
      otherPct = Math.max(floorPct, totalDeployPct - mainPct);
    }
  }
  return { main: round1(mainPct), other: round1(otherPct) };
}

function clampPct(value, floorPct, capPct) {
  return Math.min(Math.max(Number(value) || 0, floorPct), capPct);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}
