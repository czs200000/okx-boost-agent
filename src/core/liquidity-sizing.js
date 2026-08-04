const defaultSteps = [330, 250, 200, 150, 100, 50];

export function liquidityCandidates({ requestedUsd, tokenCapUsd, minimumUsd = 50, steps = defaultSteps }) {
  const ceiling = Math.max(0, Math.min(Number(requestedUsd), Number(tokenCapUsd)));
  return [...new Set([ceiling, ...steps])]
    .filter(value => Number.isFinite(value) && value >= Number(minimumUsd) && value <= ceiling)
    .sort((a, b) => b - a);
}

export function liquidityQuoteAcceptable(result, maxRoundTripLossBps) {
  return result?.outbound?.action === "ok"
    && result?.returnQuote?.action === "ok"
    && Number.isFinite(Number(result.roundTripLossBps))
    && Number(result.roundTripLossBps) <= Number(maxRoundTripLossBps);
}

export function projectedWorstLossUsd(amountUsd, roundTripLossBps, stopLossBps) {
  const combinedBps = Math.max(0, Number(roundTripLossBps)) + Math.max(0, Number(stopLossBps));
  return Math.max(0, Number(amountUsd)) * combinedBps / 10000;
}
