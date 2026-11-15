// "Mission Designer" game scoring. Turns the real engine into a challenge: succeed first (the lander
// survives the whole stay), then do it efficiently (a smaller battery scores higher). Pure functions —
// the dashboard feeds in the already-computed mission + verdict and renders the result.

export const GAME = {
  batteryBudgetWh: 3000,     // "budget": beating the verdict on a smaller battery earns the efficiency points
  reliabilityMax: 60,
  efficiencyMax: 40,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Score a mission 0–100 from the model output.
 *  - Reliability (0–60): the engine's own viability score (power × comms × blackout), scaled.
 *  - Efficiency (0–40): only once the mission is a GO — reward spending less than the battery budget.
 * Returns the parts too, so the UI can show an honest breakdown rather than a mystery number.
 */
export function gameScore({ mission, verdict, capacityWh }) {
  if (!mission || mission.error || verdict === "unknown" || verdict === "preliminary") {
    return { total: null, reliability: null, efficiency: null, verdict, note: "Not enough data to score — pick a site and date the model can judge." };
  }
  const base = mission.viability?.score;
  const reliability = base == null
    ? (verdict === "go" ? GAME.reliabilityMax : verdict === "caution" ? GAME.reliabilityMax * 0.5 : 0)
    : clamp((base / 100) * GAME.reliabilityMax, 0, GAME.reliabilityMax);
  // Efficiency only counts if the mission actually works — you can't "save battery" by failing.
  const spent = clamp(capacityWh / GAME.batteryBudgetWh, 0, 1);
  const efficiency = verdict === "go" ? clamp((1 - spent) * GAME.efficiencyMax, 0, GAME.efficiencyMax) : 0;
  const total = Math.round(reliability + efficiency);
  return { total, reliability: Math.round(reliability), efficiency: Math.round(efficiency), verdict,
    overBudget: capacityWh > GAME.batteryBudgetWh };
}

export function scoreGrade(total) {
  if (total == null) return { grade: "—", label: "Can't score", tier: "unknown" };
  if (total >= 90) return { grade: "S", label: "Flagship mission", tier: "go" };
  if (total >= 75) return { grade: "A", label: "Mission-ready", tier: "go" };
  if (total >= 60) return { grade: "B", label: "Viable", tier: "go" };
  if (total >= 40) return { grade: "C", label: "Risky", tier: "caution" };
  return { grade: "D", label: "Infeasible", tier: "nogo" };
}

/** One actionable tip toward a higher score, given the result. */
export function scoreTip(result, { capacityWh }) {
  if (result.total == null) return "Choose a site and landing date the power model can evaluate (CR1 or SR1).";
  if (result.verdict === "nogo") return "It's a NO-GO: the battery runs out. Try a sunnier landing date, a bigger panel, or more battery.";
  if (result.verdict === "caution") return "Earth contact falls short. Try a date with longer line-of-sight, or relax the contact limits.";
  if (result.overBudget) return `You're over the ${GAME.batteryBudgetWh.toLocaleString()} Wh budget. It works — now try trimming the battery to score on efficiency.`;
  if (result.efficiency < GAME.efficiencyMax - 1) return "It works! Now shrink the battery (or panel) as far as it'll go while staying GO to push the score up.";
  return "Near-perfect — you're squeezing a GO out of a tiny battery. Try a tougher site or a harder date.";
}
