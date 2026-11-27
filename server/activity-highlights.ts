import type { DatabaseSync } from 'node:sqlite';
import type { SqlRow } from './activity-query.ts';
import type { ActivityEvent, ActivityItem, HighlightReason, RelatedCi } from '../src/activity.ts';

type Entry = { event: ActivityEvent; key: string; sequence: number; status: string; time: number; observed: number; defaultRef: string };
type Highlight = { reason: HighlightReason; ci?: RelatedCi[]; host?: string; mergeCommit?: string };
const keyOf = (...parts: unknown[]) => JSON.stringify(parts);
const prNumber = (event: ActivityEvent) => /^refs\/pull\/(\d+)\/merge$/.exec(event.data?.sourceBranch ?? '')?.[1];
const pipeline = (event: ActivityEvent) => (event.data?.definition?.id == null ? undefined : String(event.data.definition.id));
const sha = (value?: string) => (typeof value === 'string' ? value.toLowerCase() : undefined);
const started = (entry: Entry) => Date.parse(entry.event.data?.buildStartedAt ?? '') || entry.time;

function prReason(event: ActivityEvent, before?: ActivityEvent): HighlightReason | undefined {
  const data = event.data;
  if (!data) return;
  if (data.status === 'completed' && before?.data?.status !== 'completed') return 'merged';
  if (data.status === 'abandoned' && before?.data?.status !== 'abandoned') return 'abandoned';
  if (event.imported || data.status !== 'active' || data.isDraft) return;
  if (!before) return 'review-ready';
  if (before.data?.status !== 'active') return 'reopened';
  if (before.data.isDraft) return 'review-ready';
  if (before.data.targetRefName && data.targetRefName && before.data.targetRefName !== data.targetRefName) return 'retargeted';
  if (data.voteChanges?.some(change => change.vote < 0)) return 'review-blocked';
  const approved = (snapshot: ActivityEvent) => {
    const votes = snapshot.data?.reviewers ?? [];
    return votes.some(vote => vote.required) && votes.every(vote => vote.vote >= 0 && (!vote.required || vote.vote >= 5));
  };
  if (data.voteChanges?.some(change => change.vote >= 5) && approved(event) && !approved(before)) return 'review-approved';
}

function ciLink(entry: Entry, validation: boolean, postMerge: boolean, recovery = false, stale = false): RelatedCi {
  return {
    id: entry.event.id,
    time: entry.event.time,
    title: entry.event.title ?? 'CI run',
    validation,
    postMerge,
    stale,
    outcome: recovery
      ? 'passing again'
      : entry.status === 'succeeded'
        ? 'passed'
        : entry.status === 'failed'
          ? 'failed'
          : 'partially succeeded',
  };
}

/** Derive decisions from the pinned history, before text, status, and unread filtering. */
export function activityHighlights(db: DatabaseSync, hydrate: (row: SqlRow) => ActivityEvent, through: number, repos?: string[]) {
  const entries = db
    .prepare(
      `SELECT e.id,e.seen,e.imported,m.group_key,m.sequence,m.status_id,m.time,m.observed,
      CASE m.kind WHEN 'push' THEN json_remove(e.data,'$.data.commits','$.data.mergeEvidence.commits','$.data.mergeEvidence.refRanges')
        ELSE e.data END AS data,
      CASE WHEN m.kind='push' AND n.data IS NOT NULL
        THEN json_remove(n.data,'$.mergeEvidence.commits','$.mergeEvidence.refRanges') END AS enrichment,
      json_extract(r.data,'$.defaultBranch') AS default_ref
    FROM activity_members m JOIN events e ON e.id=m.event_id JOIN repositories r ON r.id=e.repo_id
    LEFT JOIN enrichment n ON n.event_id=e.id
    WHERE m.sequence<=? AND m.kind<>'branch-created'
      AND (? IS NULL OR e.repo_id IN (SELECT value FROM json_each(?))) ORDER BY m.sequence`,
    )
    .all(through, repos ? JSON.stringify(repos) : null, repos ? JSON.stringify(repos) : null)
    .map(row => {
      const event = hydrate(row);
      const branch = String(row.default_ref || 'main');
      return {
        event,
        key: String(row.group_key),
        sequence: Number(row.sequence),
        status: String(row.status_id),
        time: Number(row.time),
        observed: Number(row.observed),
        defaultRef: branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`,
      };
    });
  return projectHighlights(entries);
}

const observedOrder = (a: Entry, b: Entry) =>
  a.observed - b.observed || a.time - b.time || (a.event.id < b.event.id ? -1 : Number(a.event.id > b.event.id));
const terminalKey = (event: ActivityEvent) => keyOf(event.repoId, String(event.data?.pullRequestId), event.data?.status);
const landingKey = (repo: string, ref?: string, commit?: string) => keyOf(repo, ref, sha(commit));

function projectHighlights(entries: Entry[]) {
  const highlights = new Map<string, Highlight>();
  const pullRequests = new Map<string, Entry[]>();
  const builds = new Map<string, Entry>();
  const landings = new Map<string, Entry>();
  const latestHosts = new Map<string, Entry>();
  const add = (entry: Entry, reason: HighlightReason) => highlights.set(entry.event.id, { reason });
  for (const entry of entries) {
    const { event, key } = entry;
    if (event.kind === 'pr') {
      const pr = keyOf(event.repoId, String(event.data?.pullRequestId ?? event.id));
      const history = pullRequests.get(pr) ?? [];
      if (!pullRequests.has(pr)) pullRequests.set(pr, history);
      history.push(entry);
    } else if (event.kind === 'build') {
      const before = builds.get(key);
      if (!before || observedOrder(before, entry) < 0) builds.set(key, entry);
    } else if (event.kind === 'tag' && event.data?.evidence !== 'snapshot') {
      add(entry, 'tag');
    }
  }
  for (const [pr, history] of pullRequests) {
    recordPrHighlights(
      history,
      (entry, reason) => {
        add(entry, reason);
        latestHosts.set(pr, entry);
      },
      landings,
      highlights,
    );
  }
  applyRefHighlights(entries, pullRequests, landings, add);
  projectCi([...builds.values()], pullRequests, latestHosts, landings, highlights);
  return highlights;
}

function recordPrHighlights(
  history: Entry[],
  add: (entry: Entry, reason: HighlightReason) => void,
  landings: Map<string, Entry>,
  highlights: Map<string, Highlight>,
) {
  history.sort(
    (a, b) =>
      Number(Boolean(b.event.imported)) - Number(Boolean(a.event.imported)) ||
      (a.event.imported ? a.time - b.time : a.observed - b.observed) ||
      a.sequence - b.sequence,
  );
  const terminals = new Set(
    history
      .filter(({ event }) => !event.imported && ['completed', 'abandoned'].includes(event.data?.status ?? ''))
      .map(({ event }) => terminalKey(event)),
  );
  let previous: ActivityEvent | undefined;
  let completion: Entry | undefined;
  for (const entry of history) {
    const { event } = entry;
    if (event.imported && terminals.has(terminalKey(event))) continue;
    const reason = prReason(event, previous);
    previous = event;
    if (reason) add(entry, reason);
    if (event.data?.status !== 'completed') {
      completion = undefined;
      continue;
    }
    if (reason === 'merged') completion = entry;
    const commit = event.data.mergeCommit;
    if (!completion || !commit || !event.data.targetRefName) continue;
    landings.set(landingKey(event.repoId, event.data.targetRefName, commit), completion);
    const highlight = highlights.get(completion.event.id);
    if (highlight) highlight.mergeCommit = commit;
  }
}

function landingPushes(entries: Entry[], landings: Map<string, Entry>) {
  const closest = new Map<string, { id: string; distance: number }>();
  for (const { event, time } of entries) {
    if (event.kind !== 'push') continue;
    const ref = event.data?.refUpdates?.[0];
    if (!ref?.newObjectId || event.data?.refUpdates?.length !== 1) continue;
    const evidence = event.data.mergeEvidence;
    if (
      evidence?.status === 'complete' &&
      evidence.introducedCommitIds &&
      !evidence.introducedCommitIds.some(commit => sha(commit) === sha(ref.newObjectId))
    )
      continue;
    if (evidence?.rewrite?.some(update => update.ref === ref.name && update.status === 'rewrite')) continue;
    const key = landingKey(event.repoId, ref.name, ref.newObjectId);
    const landing = landings.get(key);
    if (!landing) continue;
    const distance = Math.abs(time - landing.time);
    // Push and closure are separate Azure records. Match one nearby observation, even if it was recorded much later.
    if (distance <= 10 * 60_000 && distance < (closest.get(key)?.distance ?? Infinity)) closest.set(key, { id: event.id, distance });
  }
  return new Set([...closest.values()].map(push => push.id));
}

function applyRefHighlights(
  entries: Entry[],
  pullRequests: Map<string, Entry[]>,
  landings: Map<string, Entry>,
  add: (entry: Entry, reason: HighlightReason) => void,
) {
  const branches = new Map<string, Entry[]>();
  for (const history of pullRequests.values()) {
    for (const entry of history) {
      const { event } = entry;
      const data = event.data;
      if (
        !data?.sourceRefName ||
        data.fork ||
        (data.sourceRepositoryId && data.targetRepositoryId && sha(data.sourceRepositoryId) !== sha(data.targetRepositoryId))
      )
        continue;
      const key = keyOf(event.repoId, data.sourceRefName);
      const tracked = branches.get(key) ?? [];
      if (!branches.has(key)) branches.set(key, tracked);
      tracked.push(entry);
    }
  }
  const activeAt = (repo: string, ref: string | undefined, time: number, deletion = false) => {
    const latest = new Map<string, Entry>();
    for (const entry of branches.get(keyOf(repo, ref)) ?? []) {
      const skew = deletion && entry.event.data?.status === 'completed' ? 1000 : 0;
      if (entry.time > time + skew) continue;
      const pr = String(entry.event.data?.pullRequestId);
      const before = latest.get(pr);
      if (!before || entry.time > before.time || (entry.time === before.time && entry.sequence > before.sequence)) latest.set(pr, entry);
    }
    return [...latest.values()].some(entry => entry.event.data?.status === 'active');
  };
  const mergePushIds = landingPushes(entries, landings);
  for (const entry of entries) {
    const { event, time, defaultRef } = entry;
    const data = event.data;
    if (event.kind === 'push') {
      const refs = data?.refUpdates ?? [];
      const rewrite = data?.mergeEvidence?.rewrite?.some(
        update => update.status === 'rewrite' && (update.ref === defaultRef || activeAt(event.repoId, update.ref, time)),
      );
      if (rewrite) add(entry, 'rewrite');
      else if (refs.some(ref => ref.name === defaultRef && ref.newObjectId && !/^0+$/.test(ref.newObjectId) && !mergePushIds.has(event.id)))
        add(entry, 'default-push');
    } else if (event.kind === 'branch-deleted' && entry.status === 'branch-deleted' && activeAt(event.repoId, data?.name, time, true)) {
      add(entry, 'active-branch-deleted');
    }
  }
}

function projectCi(
  builds: Entry[],
  pullRequests: Map<string, Entry[]>,
  hosts: Map<string, Entry>,
  landings: Map<string, Entry>,
  highlights: Map<string, Highlight>,
) {
  builds.sort((a, b) => started(a) - started(b) || a.time - b.time || a.sequence - b.sequence);
  const failures = new Map<string, Map<string, number>>();
  const attach = (host: Entry | undefined, link: RelatedCi) => {
    const highlight = host && highlights.get(host.event.id);
    if (highlight) (highlight.ci ??= []).push(link);
  };
  for (const entry of builds) {
    const { event, status, defaultRef } = entry;
    if (!['succeeded', 'failed', 'partially-succeeded'].includes(status)) continue;
    const bad = status !== 'succeeded';
    const data = event.data;
    const ref = data?.sourceBranch;
    const number = prNumber(event);
    const pr = keyOf(event.repoId, number);
    const host = hosts.get(pr);
    const tested = sha(data?.sourceVersion);
    const failed: Highlight = { reason: 'ci-failed', ...(host ? { host: host.event.id } : {}) };
    if (!number) {
      const landing = ref && tested ? landings.get(landingKey(event.repoId, ref, tested)) : undefined;
      if (landing) attach(landing, ciLink(entry, false, true));
      if (bad && (ref === defaultRef || ref?.startsWith('refs/tags/') || !ref))
        highlights.set(event.id, landing ? { ...failed, host: landing.event.id } : failed);
      continue;
    }
    const track = keyOf(event.repoId, number, pipeline(event) ?? event.id, event.imported);
    const state = failures.get(track) ?? new Map<string, number>();
    if (!failures.has(track)) failures.set(track, state);
    const decision = validationDecision(entry, pullRequests.get(pr) ?? [], state);
    attach(host, ciLink(entry, true, false, decision.recovered, decision.stale));
    if (decision.highlight) highlights.set(event.id, failed);
  }
}

function validationDecision(entry: Entry, history: Entry[], unresolved: Map<string, number>) {
  const { event, status } = entry;
  const tested = sha(event.data?.sourceVersion);
  const latest = history.findLast(item => !item.event.imported) ?? history.at(-1);
  const matchesPreview = (item: Entry) => Boolean(tested && sha(item.event.data?.previewCommit) === tested);
  const knownAtStart = history.findLastIndex(item => item.time <= started(entry) && matchesPreview(item));
  const revision = knownAtStart >= 0 ? knownAtStart : history.findIndex(matchesPreview);
  const stale =
    revision >= 0 &&
    history.some(
      (item, index) =>
        index > revision &&
        item.time <= started(entry) &&
        Boolean(item.event.data?.previewCommit && sha(item.event.data.previewCommit) !== tested),
    );
  const closed = latest && ['completed', 'abandoned'].includes(latest.event.data?.status ?? '') && latest.time <= started(entry);
  const open = unresolved.size > 0;
  if (stale || closed) return { highlight: false, stale, recovered: false };
  if (tested) {
    for (const [commit, rank] of unresolved) {
      if (commit === tested || (rank >= 0 && revision > rank)) unresolved.delete(commit);
    }
  }
  if (status === 'succeeded') {
    const recovered = open && !unresolved.size;
    // A verified pass starts a new observation window for incomparable failures.
    // Those earlier attempts stay in history without an assertion of recovery.
    if (revision >= 0) {
      for (const [commit, rank] of unresolved) if (rank < 0) unresolved.delete(commit);
    }
    return { highlight: false, stale, recovered };
  }
  // A missing SHA can establish a failure, but never proves a recovery.
  unresolved.set(tested || event.id, revision);
  return { highlight: !open || pipeline(event) == null, stale, recovered: false };
}

export function attachHighlights(items: ActivityItem[], highlights: Map<string, Highlight>) {
  for (const item of items) {
    const highlight = highlights.get(item.id) ?? item.events.map(event => highlights.get(event.id)).find(Boolean);
    if (!highlight) continue;
    item.highlight = highlight.reason;
    if (highlight.host) item.ciHost = highlight.host;
    if (highlight.mergeCommit) item.data = { ...item.data, mergeCommit: highlight.mergeCommit };
    if (item.kind === 'push' && item.data?.refUpdates?.length === 1 && item.data.mergeEvidence) {
      item.data = { ...item.data, mergeEvidence: { ...item.data.mergeEvidence, prs: [] } };
    }
    if (highlight.ci) {
      item.earlierCiCount = Math.max(0, highlight.ci.length - 6);
      item.relatedCi = [...highlight.ci]
        .sort((a, b) => (new Date(b.time).valueOf() || 0) - (new Date(a.time).valueOf() || 0) || b.id.localeCompare(a.id))
        .slice(0, 6);
    }
  }
}
