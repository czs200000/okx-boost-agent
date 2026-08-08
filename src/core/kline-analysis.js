// Short-term K-line trend analysis for the maker circuit breaker.
// Uses standard technical-analysis methods used by short-term traders:
// EMA trend, RSI, MACD histogram, Bollinger Bands and ATR volatility.

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) { out.push(null); continue; }
    const slice = values.slice(i + 1 - period, i + 1);
    out.push(slice.reduce((s, v) => s + v, 0) / period);
  }
  return out;
}

function stddev(slice) {
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length);
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macdHistogram(closes, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  const offset = slow - 1;
  return macdLine.map((v, i) => (i >= offset ? v - signalLine[i - offset] : null));
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = closes.map((_, i) => {
    if (mid[i] == null || i + 1 < period) return null;
    return mid[i] + mult * stddev(closes.slice(i + 1 - period, i + 1));
  });
  const lower = closes.map((_, i) => {
    if (mid[i] == null || i + 1 < period) return null;
    return mid[i] - mult * stddev(closes.slice(i + 1 - period, i + 1));
  });
  return { mid, upper, lower };
}

function atrPercent(klines, period = 14) {
  if (klines.length <= period) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].h;
    const l = klines[i].l;
    const pc = klines[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const lastClose = klines[klines.length - 1].c;
  return lastClose > 0 ? (atr / lastClose) * 10000 : null;
}

export function analyzeStabilization(klines) {
  // klines: array of {o,h,l,c,t}, oldest -> newest.
  if (!Array.isArray(klines) || klines.length < 30) {
    return { ok: false, reason: `insufficient klines (${Array.isArray(klines) ? klines.length : 0})` };
  }
  const closes = klines.map(k => k.c);
  const last = closes[closes.length - 1];

  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const ema8SlopeBps = ema8[ema8.length - 2] > 0
    ? ((ema8[ema8.length - 1] - ema8[ema8.length - 2]) / ema8[ema8.length - 2]) * 10000
    : 0;
  const ema8vs21Bps = ema21[ema21.length - 1] > 0
    ? ((ema8[ema8.length - 1] - ema21[ema21.length - 1]) / ema21[ema21.length - 1]) * 10000
    : 0;
  const rsi14 = rsi(closes, 14);
  const macdHist = macdHistogram(closes);
  const macdNow = macdHist[macdHist.length - 1];
  const macdPrev = macdHist[macdHist.length - 2];
  const bb = bollinger(closes);
  const bbNow = bb.mid[bb.mid.length - 1];
  const bbPrev = bb.mid[bb.mid.length - 2];
  const bbWidthBps = bbNow > 0
    ? ((bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bbNow) * 10000
    : null;
  const bbWidthPrevBps = bbPrev > 0
    ? ((bb.upper[bb.upper.length - 2] - bb.lower[bb.lower.length - 2]) / bbPrev) * 10000
    : null;
  const atrBps = atrPercent(klines);

  const recentLows = closes.slice(-12, -1);
  const noFreshLow = last >= Math.min(...recentLows);
  const emaStable = ema8SlopeBps > -15;
  const rsiOk = rsi14 != null && rsi14 >= 38;
  const macdOk = macdNow != null && macdPrev != null && macdNow >= macdPrev;
  const volOk = bbWidthBps != null && bbWidthPrevBps != null && bbWidthBps <= bbWidthPrevBps * 1.02;

  const conditions = [noFreshLow, emaStable, rsiOk, macdOk, volOk];
  const score = conditions.filter(Boolean).length;
  const stable = noFreshLow && emaStable && score >= 4;

  const reasons = [];
  if (noFreshLow) reasons.push("近12根K线未创新低，下跌动能减弱");
  else reasons.push("仍在创近期新低，尚未企稳");
  if (emaStable) reasons.push(`短期均线走平/向上（斜率 ${ema8SlopeBps.toFixed(1)}bps）`);
  else reasons.push(`短期均线仍向下（斜率 ${ema8SlopeBps.toFixed(1)}bps）`);
  if (rsiOk) reasons.push(`RSI=${rsi14 == null ? "—" : rsi14.toFixed(1)}，脱离超卖区`);
  else reasons.push(`RSI=${rsi14 == null ? "—" : rsi14.toFixed(1)}，偏弱`);
  if (macdOk) reasons.push("MACD 柱状图回升/转正");
  else reasons.push("MACD 柱状图仍走弱");
  if (volOk) reasons.push("布林带收窄，波动收敛");
  else reasons.push("波动仍在放大");

  return {
    ok: true,
    stable,
    score,
    total: 5,
    reasons: reasons.slice(0, 4),
    metrics: {
      ema8SlopeBps: Math.round(ema8SlopeBps * 10) / 10,
      ema8vs21Bps: Math.round(ema8vs21Bps * 10) / 10,
      rsi14: rsi14 == null ? null : Math.round(rsi14 * 10) / 10,
      macdHistogram: macdNow == null ? null : Math.round(macdNow * 100000) / 100000,
      bollingerWidthBps: bbWidthBps == null ? null : Math.round(bbWidthBps),
      atrBps: atrBps == null ? null : Math.round(atrBps),
      lastClose: last
    }
  };
}
