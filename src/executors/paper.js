export class PaperExecutor {
  async execute(plan, quote) {
    return {
      id: `paper_${crypto.randomUUID()}`,
      mode: "paper",
      status: "confirmed",
      token: plan.token,
      action: plan.action,
      amountUsd: plan.amountUsd,
      expectedPrice: quote?.price || null,
      timestamp: new Date().toISOString()
    };
  }
}
