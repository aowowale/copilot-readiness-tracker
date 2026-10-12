// Run history per data source, so a failed, partial or stale source is visible.

export const RUN_STATUS = { ok: "ok", partial: "partial", failed: "failed", skipped: "skipped" };

export function buildRunRecord({ source, startedAt, finishedAt, status, recordsRead = 0, warnings = [], error = null, staleAfterHours = null }) {
  if (!source) throw new Error("A run record requires a source.");
  const finished = finishedAt || new Date().toISOString();
  // Reverse-time row key so a table scan returns the newest runs first.
  const reverse = String(9_999_999_999_999 - new Date(finished).getTime()).padStart(13, "0");
  return {
    runId: `${reverse}-${source}`,
    source,
    startedAt: startedAt || finished,
    finishedAt: finished,
    status: RUN_STATUS[status] || RUN_STATUS.failed,
    recordsRead,
    warnings: warnings.slice(0, 20).map((warning) => String(warning).slice(0, 300)),
    error: error ? String(error).slice(0, 300) : null,
    staleAfterHours
  };
}

export function summarizeSources(runs, { now = new Date(), staleHours = 36 } = {}) {
  const latest = new Map();
  for (const run of runs) {
    const current = latest.get(run.source);
    if (!current || run.finishedAt > current.finishedAt) latest.set(run.source, run);
  }
  return [...latest.values()]
    .map((run) => {
      const ageHours = Math.max(0, Math.round(((now - new Date(run.finishedAt)) / 3_600_000) * 10) / 10);
      return { ...run, ageHours, stale: ageHours > (run.staleAfterHours ?? staleHours) };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
}
