import type { ActivityItem, CiResult, RelatedCi } from '../src/activity.ts';

export type CiAttempt = RelatedCi & {
  pipeline?: string | undefined;
  sha?: string | undefined;
  startedAt?: string | null | undefined;
  reason?: string | null | undefined;
  revision?: number | undefined;
  beforeLanding?: boolean;
  revisionUnverified?: boolean;
};

export const activeCi = (run: RelatedCi) => ['queued', 'running', 'canceling'].includes(run.outcome);
const passed = (run: RelatedCi) => run.outcome === 'passed' || run.outcome === 'passing again';
const automatic = (run: CiAttempt) => ['individualCI', 'batchedCI'].includes(run.reason ?? '');
const start = (run: CiAttempt) => Date.parse(run.startedAt ?? '');
const stamp = (run: RelatedCi) => new Date(run.time).valueOf() || 0;
const newest = (a: RelatedCi, b: RelatedCi) => stamp(b) - stamp(a) || b.id.localeCompare(a.id);
const track = (run: CiAttempt) => JSON.stringify([run.postMerge, run.validation, run.pipeline, run.pipeline == null ? run.id : null]);

export function ciAttempt(run: Omit<RelatedCi, 'outcome'>, status: string): RelatedCi {
  const outcome =
    status === 'succeeded'
      ? 'passed'
      : status === 'failed'
        ? 'failed'
        : status === 'queued' || status === 'running' || status === 'canceling'
          ? status
          : 'partially succeeded';
  return { ...run, outcome };
}

function publicRun({ id, time, title, validation, postMerge, stale, outcome }: CiAttempt): RelatedCi {
  return { id, time, title, validation, postMerge, ...(stale ? { stale } : {}), outcome };
}

function resultRun(run: CiAttempt): RelatedCi {
  return publicRun(run.outcome === 'passing again' ? { ...run, outcome: 'passed' } : run);
}

function currentAttempts(runs: CiAttempt[]) {
  const latestRevision = runs.reduce((latest, run) => Math.max(latest, run.revision ?? -1), -1);
  // PR snapshots can change without a new commit. Same-SHA retries still need start-time evidence.
  const latestShas = new Set(runs.filter(run => run.revision === latestRevision).map(run => run.sha));
  const comparable = runs.filter(run => run.revision == null || run.revision < 0 || (run.sha && latestShas.has(run.sha)));
  const latestStart = new Map<string, number>();
  for (const run of comparable) {
    const started = start(run);
    if (run.sha && Number.isFinite(started)) latestStart.set(run.sha, Math.max(latestStart.get(run.sha) ?? -Infinity, started));
  }
  return comparable.filter(run => !run.sha || !(start(run) < (latestStart.get(run.sha) ?? -Infinity)));
}

function pipelineResults(runs: CiAttempt[], verified: (run: CiAttempt) => boolean): CiResult[] {
  const completed = currentAttempts(runs.filter(run => !activeCi(run)));
  const direct = completed.filter(run => !passed(run));
  const successful = completed.find(run => passed(run) && !run.revisionUnverified) ?? completed.find(passed);
  const confirmedFailure = direct.find(run => run.outcome === 'failed' && !run.revisionUnverified);
  const problem = confirmedFailure ?? direct.find(run => run.outcome === 'failed') ?? direct[0];
  const results: CiResult[] = [];
  if (problem) {
    const competingPass = successful && (problem.revisionUnverified || !successful.revisionUnverified);
    const uncertain =
      problem.revisionUnverified || (competingPass && (problem.sha !== successful.sha || !problem.sha))
        ? 'revision unknown'
        : competingPass
          ? 'retry order unknown'
          : undefined;
    results.push({
      run: publicRun(problem),
      tone: uncertain || problem.outcome !== 'failed' ? 'warn' : 'crit',
      ...(uncertain ? { note: uncertain } : {}),
    });
  } else if (successful) {
    const note =
      successful.postMerge && !verified(successful) ? 'trigger unverified' : successful.revisionUnverified ? 'revision unknown' : undefined;
    const run = resultRun(successful);
    results.push(note ? { run, tone: 'neutral', note } : { run, tone: 'ok' });
  }

  const pending = currentAttempts(runs.filter(activeCi))[0];
  // Keep the last completed failure visible while its retry is pending.
  if (pending && (completed.length === 0 || currentAttempts([...completed, pending]).includes(pending))) {
    results.push({ run: publicRun(pending), tone: 'neutral' });
  }
  return results;
}

export function applyCiSummary(item: ActivityItem, attempts: CiAttempt[], limit = Infinity) {
  if (!attempts.length) return;
  const ordered = [...attempts].sort(newest);
  const eligible = ordered.filter(run => run.postMerge && automatic(run) && !run.beforeLanding);
  const earliestTrigger = new Map<string, number>();
  for (const run of eligible) {
    const started = start(run);
    if (run.pipeline != null) {
      earliestTrigger.set(
        run.pipeline,
        Math.min(earliestTrigger.get(run.pipeline) ?? Infinity, Number.isFinite(started) ? started : Infinity),
      );
    }
  }
  const verified = (run: CiAttempt) =>
    run.postMerge &&
    !run.beforeLanding &&
    (automatic(run) || (run.reason === 'manual' && run.pipeline != null && start(run) > (earliestTrigger.get(run.pipeline) ?? Infinity)));
  const postMerge = eligible.some(run => !activeCi(run));
  const hasValidation = ordered.some(run => run.validation);
  const byPipeline = new Map<string, CiAttempt[]>();
  for (const run of ordered) {
    if (item.data?.status === 'abandoned' || run.stale || run.beforeLanding || (postMerge && run.validation)) continue;
    // An unrelated pass on the landed commit cannot replace a verified pipeline result.
    if (run.postMerge && passed(run) && !verified(run) && run.pipeline != null && earliestTrigger.has(run.pipeline)) continue;
    const key = track(run);
    const list = byPipeline.get(key);
    if (list) list.push(run);
    else byPipeline.set(key, [run]);
  }
  const severity = { crit: 3, warn: 2, ok: 1, neutral: 0 };
  const results = [...byPipeline.values()]
    .flatMap(runs => pipelineResults(runs, verified))
    .filter(result => result.note !== 'trigger unverified' || !(postMerge || hasValidation));
  results.sort((a, b) => severity[b.tone] - severity[a.tone] || newest(a.run, b.run));
  // Give one passing result the headline. Other passes are available with the attempts.
  const problems = results.filter(result => result.tone === 'crit' || result.tone === 'warn' || activeCi(result.run));
  const headline = problems.length ? problems : results.slice(0, 1);
  if (!headline.length && ordered[0]) headline.push({ run: resultRun(ordered[0]), tone: 'neutral' });
  item.ciSummary = { results: headline, historyCount: ordered.length - headline.length };
  item.relatedCi = ordered.slice(0, limit).map(publicRun);
}
