export interface ReferenceSample { milliseconds: number | null; error?: string }
/** Errors remain infinite samples and independently fail the run. JSON represents infinity explicitly. */
export function referenceRun(samples: readonly ReferenceSample[], budgetMilliseconds: number) {
  if (samples.length < 100 || !Number.isFinite(budgetMilliseconds) || budgetMilliseconds <= 0) throw new Error("A reference run needs at least 100 samples and a positive finite budget");
  const ranked = samples.map(sample => {
    if (sample.milliseconds !== null && (!Number.isFinite(sample.milliseconds) || sample.milliseconds < 0)) throw new Error("Invalid reference latency");
    return sample.error || sample.milliseconds === null ? Infinity : sample.milliseconds;
  }).sort((left, right) => left - right);
  const p95 = ranked[Math.ceil(ranked.length * 0.95) - 1]!;
  const failures = ranked.filter(value => value === Infinity).length;
  return { samples: samples.length, p95Milliseconds: Number.isFinite(p95) ? p95 : null, infinite: !Number.isFinite(p95), failures, passed: failures === 0 && p95 <= budgetMilliseconds, measurements: samples };
}
export function referenceScenario(runs: readonly (readonly ReferenceSample[])[], budgetMilliseconds: number) {
  if (runs.length !== 3) throw new Error("A reference scenario requires three independent runs");
  const results = runs.map(samples => referenceRun(samples, budgetMilliseconds));
  return { budgetMilliseconds, runs: results, passed: results.every(run => run.passed) };
}
