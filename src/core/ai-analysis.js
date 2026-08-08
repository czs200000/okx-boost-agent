// AI market-regime analysis for the maker circuit breaker.
// Uses the configured DeepSeek endpoint and returns a structured verdict
// (resume / pause / adjust) that the maker executes as its next action.

const VERDICTS = ["resume", "pause", "adjust"];
const PARAM_RANGES = {
  legUsd: [50, 2000],
  buyTriggerBps: [1, 50],
  sellTriggerBps: [1, 50],
  stopLossBps: [10, 300],
  cooldownMinutes: [1, 120]
};

function clamp(value, [lo, hi]) {
  return Math.max(lo, Math.min(hi, Number(value)));
}

export function validateVerdict(raw) {
  if (!raw || typeof raw !== "object") throw new Error("AI returned an invalid verdict");
  const verdict = String(raw.verdict || "").toLowerCase();
  if (!VERDICTS.includes(verdict)) throw new Error(`AI returned invalid verdict: ${verdict}`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("AI returned invalid confidence");
  }
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.slice(0, 6).map(r => String(r).slice(0, 200))
    : [];
  let suggestedParams = null;
  if (raw.suggestedParams && typeof raw.suggestedParams === "object") {
    suggestedParams = {};
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
      const value = raw.suggestedParams[key];
      if (value != null && Number.isFinite(Number(value))) suggestedParams[key] = clamp(value, range);
    }
  }
  return { verdict, confidence, reasons, suggestedParams };
}

export function applySuggestedParams(target, suggestedParams) {
  if (!suggestedParams) return [];
  const applied = [];
  for (const [key, range] of Object.entries(PARAM_RANGES)) {
    const value = suggestedParams[key];
    if (value == null || !Number.isFinite(Number(value))) continue;
    target[key] = clamp(value, range);
    applied.push(`${key}=${target[key]}`);
  }
  return applied;
}

export class AiVerdictProvider {
  constructor(options) {
    this.apiKey = options.apiKey;
    this.baseUrl = String(options.baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
    this.model = options.model;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async verdict(context) {
    if (!this.configured) throw new Error("DEEPSEEK_API_KEY is not configured");
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a market-regime analyst for an automated market-making bot on OKX X Layer. The bot trades a wrapped US-stock token and just hit a circuit breaker. Decide whether it should resume trading. Return ONLY JSON with this exact shape: {"verdict":"resume"|"pause"|"adjust","confidence":0.0-1.0,"reasons":["..."],"suggestedParams":{"legUsd":number|null,"buyTriggerBps":number|null,"sellTriggerBps":number|null,"stopLossBps":number|null,"cooldownMinutes":number|null}}. verdict=resume when the market is range-bound/stable and safe to reopen; verdict=pause when it is trending down, highly volatile, or uncertain; verdict=adjust when it is tradable but parameters should change. Keep reasons short (2-4). Never include text outside the JSON.`
          },
          { role: "user", content: JSON.stringify(context) }
        ]
      })
    });
    if (!response.ok) throw new Error(`DeepSeek request failed: ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    return validateVerdict(JSON.parse(content));
  }
}

export function summarizeKlines(klines) {
  if (!Array.isArray(klines) || klines.length < 2) {
    return { bars: Array.isArray(klines) ? klines.length : 0 };
  }
  const first = klines[klines.length - 1].c; // oldest close
  const last = klines[0].c; // newest close
  const hi = Math.max(...klines.map(k => k.h));
  const lo = Math.min(...klines.map(k => k.l));
  return {
    bars: klines.length,
    trendBps: first > 0 ? Math.round((last / first - 1) * 10000) : 0,
    rangeBps: lo > 0 ? Math.round((hi / lo - 1) * 10000) : 0,
    lastClose: Math.round(last * 10000) / 10000
  };
}

export function usSessionLabel(now = new Date()) {
  // Approximate US Eastern time (EDT, UTC-4) for session classification.
  const et = new Date(now.getTime() - 4 * 3600 * 1000);
  const hour = et.getUTCHours() + et.getUTCMinutes() / 60;
  const day = et.getUTCDay();
  if (day === 0 || day === 6) return "weekend_closed";
  if (hour >= 4 && hour < 9.5) return "premarket";
  if (hour >= 9.5 && hour < 16) return "regular";
  if (hour >= 16 && hour < 20) return "afterhours";
  return "overnight_closed";
}
