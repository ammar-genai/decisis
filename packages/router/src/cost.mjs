// Cost helpers. Actual cost comes from Claude Code's own total_cost_usd.
// The "all on the top model" figure is a rough counterfactual: the same tokens billed at the
// top model's rates. Opus, Sonnet and Haiku all price output at 5x input, so that is a simple
// price ratio. Treat it as an estimate; a different model would not use identical tokens.
export const INPUT_PRICE_PER_MTOK = { haiku: 1, sonnet: 2, opus: 5, fable: 10 };

export function familyOf(model) {
  const m = String(model ?? '').toLowerCase();
  return Object.keys(INPUT_PRICE_PER_MTOK).find((f) => m.includes(f)) ?? null;
}

export function counterfactualUsd(costUsd, model, target = 'opus') {
  const fam = familyOf(model);
  if (!fam || !INPUT_PRICE_PER_MTOK[target]) return null;
  return costUsd * (INPUT_PRICE_PER_MTOK[target] / INPUT_PRICE_PER_MTOK[fam]);
}
