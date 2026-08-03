const planSchema = {
  action: ["BUY", "SELL", "HOLD"],
  token: ["NVDAx", "SNDKx", "SPCXx", null],
  quoteToken: ["USDG", "OKB", "WOKB", "USDT", "USDC"]
};

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("DeepSeek returned an invalid plan");
  const action = String(plan.action || "").toUpperCase();
  const token = plan.token == null ? null : String(plan.token);
  const quoteToken = plan.quoteToken == null && action === "HOLD"
    ? "USDT"
    : String(plan.quoteToken || "").toUpperCase();
  if (!planSchema.action.includes(action)) throw new Error("DeepSeek returned an invalid action");
  if (!planSchema.token.includes(token)) throw new Error("DeepSeek returned an invalid token");
  if (!planSchema.quoteToken.includes(quoteToken)) throw new Error("DeepSeek returned an invalid quote token");
  for (const key of ["amountUsd", "maxSlippageBps", "confidence"]) {
    if (!Number.isFinite(Number(plan[key]))) throw new Error(`DeepSeek returned invalid ${key}`);
  }
  return {
    action,
    token,
    quoteToken,
    amountUsd: Number(plan.amountUsd),
    maxSlippageBps: Number(plan.maxSlippageBps),
    confidence: Number(plan.confidence),
    reason: String(plan.reason || "")
  };
}

export class DeepSeekProvider {
  constructor(options) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async analyze(context) {
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
            content: "You are a constrained trading-plan analyst. Return only JSON with action, token, quoteToken, amountUsd, maxSlippageBps, confidence, reason. action must be BUY, SELL, or HOLD. token must be NVDAx, SNDKx, SPCXx, or null. quoteToken must always be one of USDG, OKB, WOKB, USDT, USDC; use USDT for HOLD. Never invent tokens and never attempt to bypass campaign rules. HOLD when evidence is insufficient or campaign attribution is unverified."
          },
          { role: "user", content: JSON.stringify(context) }
        ]
      })
    });
    if (!response.ok) throw new Error(`DeepSeek request failed: ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    return validatePlan(JSON.parse(content));
  }
}
