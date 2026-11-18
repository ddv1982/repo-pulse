import { createHash } from 'node:crypto';
import { actorName, branchName, safeAzureUrl } from '../src/events.js';

const STREAMS = ['pushes', 'refs', 'prs', 'closedPrs', 'builds', 'activeBuilds'];
const ZERO = /^0+$/;
const DAY = 86400000;
const LIVE_TURNS = 6;
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const iso = (ms) => new Date(ms).toISOString();
const prState = (pr) => ({ status: pr.status, isDraft: Boolean(pr.isDraft), title: pr.title,
  source: pr.lastMergeSourceCommit?.commitId, target: pr.targetRefName });
const buildState = (build) => ({ status: build.status, result: build.result, finishTime: build.finishTime,
  sourceVersion: build.sourceVersion, sourceBranch: build.sourceBranch });

/** Every tick does one bounded page, so busy streams cannot monopolize catch-up. */
export function createSync({ store, provider, now = Date.now, intervalMs = 180000, isForeground = () => true,
  refsIntervalMs = 600000, pollMs = 1000, overlapMs = 120000, background = {}, onPrCompleted } = {}) {
  let timer;
  let active;
  let stopped = false;
  const refreshedAt = new Map();
  let lastKey;
  let liveTurns = 0;
  let nextBackground = 'merge';
  const lastTurn = {};
  const counters = { pages: 0, errors: 0 };

  function ensureStreams() {
    const current = store.getStreams();
    for (const repo of store.listRepos()) {
      if (store.getSetting(`baseline:${repo.id}`, null) === null) store.setSetting(`baseline:${repo.id}`, iso(now()));
      for (const stream of STREAMS) {
        if (!current.some((state) => state.repoId === repo.id && state.stream === stream)) {
          store.saveStream({ repoId: repo.id, stream, initialized: false, nextAt: iso(now()), error: null });
        }
      }
    }
  }
  function makeEvent(repo, kind, sourceId, detail, imported) {
    const observedAt = iso(now());
    return { id: `${repo.id}:${kind}:${sourceId}`, repoId: repo.id, kind, observedAt,
      actor: 'Unknown', branch: '', summary: '', url: repo.webUrl, ...detail, imported,
      seen: imported };
  }
  function normalize(repo, stream, records, state) {
    const events = [];
    const entities = [];
    const jobs = [];
    const historical = Boolean(state.historical);
    const refs = stream === 'pushes' ? new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data])) : null;
    const baseline = store.getSetting(`baseline:${repo.id}`, iso(now()));
    const add = (kind, sourceId, detail) => {
      const time = detail.time || iso(now());
      const imported = !state.initialized && time <= baseline;
      events.push(makeEvent(repo, kind, sourceId, { ...detail, time }, historical || imported));
    };
    for (const item of records) {
      if (stream === 'pushes') {
        const source = String(item.pushId);
        if (!item.pushId || store.getEntity(repo.id, 'push', source)) continue;
        const updates = item.refUpdates || [];
        const branches = updates.filter((ref) => ref.name?.startsWith('refs/heads/'));
        const time = item.date || iso(now());
        const actor = actorName(item.pushedBy);
        const data = { pushId: item.pushId, refUpdates: branches, commits: item.commits || [] };
        const url = safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pushes?pushId=${encodeURIComponent(source)}`);
        add('push', source, { title: `${actor} pushed${branches.length ? ` to ${branches.map((r) => branchName(r.name)).join(', ')}` : ''}`,
          branch: branchName(branches[0]?.name), actor, time, url,
          summary: branches.length ? branches.map((ref) => `${ref.oldObjectId?.slice(0, 7) || '?'} → ${ref.newObjectId?.slice(0, 7) || '?'}`).join(' · ') : 'Repository push', data });
        entities.push({ type: 'push', id: source, data: { date: time } });
        jobs.push({ id: `merge:${repo.id}:push:${source}`, type: 'merge', repoId: repo.id, eventId: `${repo.id}:push:${source}`, status: 'pending', nextAt: iso(now()) });
        for (const ref of branches) {
          const created = ref.oldObjectId && ZERO.test(ref.oldObjectId);
          const deleted = ref.newObjectId && ZERO.test(ref.newObjectId);
          if (created || deleted) add(created ? 'branch-created' : 'branch-deleted', `${source}:${ref.name}`, {
            title: `${created ? 'New branch' : 'Branch deleted'} · ${branchName(ref.name)}`,
            branch: branchName(ref.name), actor, time, url,
            summary: `${created ? 'Created' : 'Deleted'} in push ${source}`, data: { ...data, evidence: 'push', ...ref } });
          // Azure lists pushes newest first. Keep a source watermark across pages/snapshots,
          // while retaining every historical event independently of the current ref state.
          const previous = refs.get(ref.name);
          if (!historical && (!previous?.lastPushId || Number(item.pushId) > previous.lastPushId)) {
            const current = { name: ref.name, objectId: ref.newObjectId, active: !deleted, evidence: 'push', lastPushId: Number(item.pushId) };
            refs.set(ref.name, current);
            entities.push({ type: 'ref', id: ref.name, data: current });
          }
        }
      } else if (stream === 'prs' || stream === 'closedPrs') {
        if (!item.pullRequestId || (item.repository?.id && item.repository.id.toLowerCase() !== repo.azureId?.toLowerCase())) continue;
        const key = String(item.pullRequestId);
        const value = prState(item);
        const previous = store.getEntity(repo.id, 'pr', key);
        if (!previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(value)) {
          const unchangedStatus = previous?.fingerprint?.status === item.status;
          const time = previous && !historical && unchangedStatus ? iso(now())
            : (item.status !== 'active' ? item.closedDate : null) || (!previous ? item.creationDate : null) || iso(now());
          // Active PRs can expose a successful preview merge. Only completion establishes
          // the actual merge result; retain its metadata from this existing response.
          const completion = item.status === 'completed' ? {
            mergeCommit: item.lastMergeCommit?.commitId, targetCommit: item.lastMergeTargetCommit?.commitId,
            mergeStatus: item.mergeStatus, mergeStrategy: item.completionOptions?.mergeStrategy, closedBy: actorName(item.closedBy),
            sourceRepositoryId: item.forkSource ? item.forkSource.repository?.id : item.repository?.id,
            targetRepositoryId: item.repository?.id,
          } : {};
          add('pr', historical ? `history:${key}:${fingerprint(value)}` : `${key}:${(previous?.revision || 0) + 1}:${fingerprint(value)}`, { title: `PR ${key} · ${item.title || 'Untitled'}`,
            branch: branchName(item.sourceRefName), actor: actorName(item.createdBy), time,
            summary: `${item.isDraft ? 'Draft · ' : ''}${item.status || 'unknown'} → ${branchName(item.targetRefName)}`,
            url: safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pullrequest/${encodeURIComponent(key)}`),
            data: { pullRequestId: item.pullRequestId, status: item.status, isDraft: item.isDraft,
              sourceRefName: item.sourceRefName, targetRefName: item.targetRefName, sourceCommit: item.lastMergeSourceCommit?.commitId,
              ...completion } });
        }
        if (!historical) entities.push({ type: 'pr', id: key, data: { fingerprint: value, status: item.status, revision: (previous?.revision || 0) + Number(!previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(value)) } });
      } else if (stream === 'builds' || stream === 'activeBuilds') {
        if (!item.id || item.repository?.id?.toLowerCase() !== repo.azureId?.toLowerCase()) continue;
        const key = String(item.id);
        const value = buildState(item);
        const previous = store.getEntity(repo.id, 'build', key);
        if (!previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(value)) {
          const time = item.finishTime || item.startTime || item.queueTime || iso(now());
          add('build', historical ? `history:${key}:${fingerprint(value)}` : `${key}:${(previous?.revision || 0) + 1}:${fingerprint(value)}`, { title: `${item.definition?.name || 'Pipeline'} · ${item.buildNumber || key}`,
            branch: branchName(item.sourceBranch), actor: actorName(item.requestedFor || item.requestedBy), time,
            summary: `${item.status || 'unknown'}${item.result ? ` · ${item.result}` : ''} · ${(item.sourceVersion || '').slice(0, 7)}`,
            url: safeAzureUrl(item._links?.web?.href, `${repo.organization}/${encodeURIComponent(repo.project)}/_build/results?buildId=${encodeURIComponent(key)}`),
            data: { id: item.id, buildId: item.id, status: item.status, result: item.result, sourceVersion: item.sourceVersion,
              sourceBranch: item.sourceBranch, definition: item.definition, reason: item.reason } });
        }
        if (!historical) entities.push({ type: 'build', id: key, data: { fingerprint: value, status: item.status, revision: (previous?.revision || 0) + Number(!previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(value)) } });
      }
    }
    return { events, entities, jobs };
  }
  function reconcileRefs(repo, records, state) {
    const before = new Map(store.listEntities(repo.id, 'ref').map((entry) => [entry.id, entry.data]));
    const current = new Map(records.filter((item) => item.name?.startsWith('refs/heads/')).map((item) => [item.name, item]));
    const events = [];
    const entities = [];
    for (const [name, item] of current) {
      const previous = before.get(name);
      if (state.initialized && (!previous || previous.active === false)) {
        events.push(makeEvent(repo, 'branch-created', `ref:${name}:${fingerprint([item.objectId, state.window.until])}`, {
          title: `Branch first seen · ${branchName(name)}`, branch: branchName(name), time: iso(now()),
          summary: 'Discovered in remote refs; creation time and actor unknown',
          data: { name, objectId: item.objectId, evidence: 'snapshot' }, actor: 'Unknown' }, false));
      }
      entities.push({ type: 'ref', id: name, data: { name, objectId: item.objectId, active: true, lastPushId: previous?.lastPushId } });
    }
    if (state.initialized) for (const [name, old] of before) {
      if (old.active !== false && !current.has(name)) {
        events.push(makeEvent(repo, 'branch-deleted', `ref:${name}:${fingerprint([old.objectId, state.window.until])}`, {
          title: `Branch no longer listed · ${branchName(name)}`, branch: branchName(name), time: iso(now()),
          summary: 'Missing from complete refs snapshot; deletion time and actor unknown',
          data: { name, objectId: old.objectId, evidence: 'snapshot' } }, false));
        entities.push({ type: 'ref', id: name, data: { ...old, active: false } });
      }
    }
    return { events, entities };
  }
  async function runBackground(automatic) {
    const other = nextBackground === 'merge' ? 'history' : 'merge';
    for (const kind of [nextBackground, other]) {
      if (kind === 'merge' && !automatic) continue;
      if (!await background[kind]?.()) continue;
      lastTurn[kind] = iso(now());
      nextBackground = kind === 'merge' ? 'history' : 'merge';
      liveTurns = 0;
      return true;
    }
    return false;
  }
  async function runPage() {
    if (stopped) return;
    ensureStreams();
    const automatic = store.getSetting('refreshEnabled', true) !== false;
    const repos = new Map(store.listRepos().filter((repo) => !repo.disabled).map((repo) => [repo.id, repo]));
    const due = store.getStreams().filter((state) => repos.has(state.repoId) && (automatic || state.manual) && Date.parse(state.nextAt || 0) <= now());
    due.sort((a, b) => (Date.parse(a.lastAttempt || 0) || 0) - (Date.parse(b.lastAttempt || 0) || 0));
    if (!due.length) { await runBackground(automatic); return; }
    if (liveTurns >= LIVE_TURNS && await runBackground(automatic)) return;
    liveTurns = Math.min(liveTurns + 1, LIVE_TURNS);
    lastTurn.live = iso(now());
    // Rotating equal-priority entries avoids repeatedly selecting a multi-page first stream.
    const index = due.findIndex((state) => `${state.repoId}:${state.stream}` === lastKey);
    const state = due[index === 0 && due.length > 1 ? 1 : 0];
    const repo = repos.get(state.repoId);
    lastKey = `${state.repoId}:${state.stream}`;
    const window = state.window || { since: iso(state.lastSuccess ? Date.parse(state.lastSuccess) - overlapMs : now() - 7 * DAY), until: iso(now()) };
    const working = { ...state, window, lastAttempt: iso(now()), pending: true };
    try {
      const page = await provider.read(repo, state.stream, { since: window.since, until: window.until, cursor: state.cursor || null });
      if (!page || !Array.isArray(page.items)) throw new Error('Azure returned an invalid page.');
      // Removal while the provider was in flight must not resurrect a local watch.
      if (stopped || !store.listRepos().some((entry) => entry.id === repo.id && !entry.disabled)) return;
      const complete = !page.nextCursor;
      let output;
      let pendingItems;
      const activeIds = ['activeBuilds', 'prs'].includes(state.stream)
        ? [...(state.activeIds || []), ...page.items.map((item) => String(item.id || item.pullRequestId))] : undefined;
      let items = page.items;
      if (complete && state.stream === 'activeBuilds' && provider.buildsById) {
        const missing = store.listEntities(repo.id, 'build').filter((entry) =>
          entry.data.status !== 'completed' && !activeIds.includes(entry.id)).slice(0, 20).map((entry) => entry.id);
        if (missing.length) items = [...items, ...await provider.buildsById(repo, missing)];
      }
      if (complete && state.stream === 'prs' && provider.pullRequest) {
        const missing = store.listEntities(repo.id, 'pr').filter((entry) =>
          entry.data.status === 'active' && !activeIds.includes(entry.id)).slice(0, 3);
        for (const entry of missing) {
          if (stopped || !store.listRepos().some((current) => current.id === repo.id && !current.disabled)) return;
          items = [...items, await provider.pullRequest(repo, entry.id)];
        }
      }
      if (stopped || !store.listRepos().some((entry) => entry.id === repo.id && !entry.disabled)) return;
      if (state.stream === 'refs') {
        pendingItems = [...(state.pendingItems || []), ...page.items];
        output = complete ? reconcileRefs(repo, pendingItems, working) : { events: [], entities: [] };
      } else output = normalize(repo, state.stream, items, working);
      // A refresh requested after this window was fixed must survive the commit of a page read before it.
      const latest = store.getStreams().find((entry) => entry.repoId === repo.id && entry.stream === state.stream) || state;
      const requested = { refreshRequestedAt: latest.refreshRequestedAt, manual: latest.manual };
      const refreshDue = Date.parse(latest.refreshRequestedAt) > Date.parse(window.until);
      const quietCycles = output.events.some(event => !event.imported) ? 0 : (state.quietCycles || 0) + 1;
      const cadence = !isForeground() || quietCycles >= 2 ? Math.max(intervalMs, 300000) : intervalMs;
      const next = complete ? {
        repoId: repo.id, stream: state.stream, initialized: true, lastSuccess: window.until,
        lastAttempt: iso(now()), nextAt: iso(now() + (state.stream === 'refs' ? refsIntervalMs : cadence)), quietCycles,
        error: null, pending: false, failures: 0,
        ...(refreshDue ? { ...requested, nextAt: iso(now()) } : {}),
      } : { ...working, ...requested, cursor: page.nextCursor, pendingItems, activeIds, nextAt: iso(now()), error: null };
      store.commitPage({ repoId: repo.id, stream: state.stream, state: next, ...output });
      for (const event of output.events) if (event.kind === 'pr' && event.data?.status === 'completed') onPrCompleted?.(repo, event.data);
      counters.pages++;
    } catch (error) {
      if (!store.listRepos().some((entry) => entry.id === repo.id)) return;
      const failures = (state.failures || 0) + 1;
      const delay = Math.min(30 * 60000, intervalMs * 2 ** Math.min(failures - 1, 4));
      // A manual request ends with its failure; retrying is left to the user while automatic checks are off.
      store.saveStream({ ...working, manual: false, failures, error: { code: error.code || 'SYNC_FAILED',
        message: error.code ? error.message : 'Could not refresh this Azure activity stream.' }, nextAt: iso(now() + delay) });
      counters.errors++;
    }
  }
  function tick() {
    if (active) return active;
    active = runPage().finally(() => { active = null; });
    return active;
  }
  function schedule() {
    if (stopped) return;
    // A failed turn must not reject unobserved (that would end the process) or stop polling.
    timer = setTimeout(() => { tick().catch(() => { counters.errors++; }).finally(schedule); }, pollMs);
    timer.unref?.();
  }
  return {
    start() { if (timer) return; stopped = false; ensureStreams(); schedule(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; return active; },
    tick,
    normalize,
    refresh(repoIds) {
      const repos = store.listRepos();
      if (repoIds && repoIds.some((id) => !repos.some((repo) => repo.id === id))) throw Object.assign(new Error('Repository is not watched.'), { code: 'NOT_FOUND' });
      // Batch additions must register every repository even when refresh requests coalesce.
      ensureStreams();
      // Cooldown is per repository so a second added repository still gets its initial import.
      const enabled = repos.filter((repo) => !repo.disabled).map((repo) => repo.id);
      const targets = (repoIds || enabled).filter((id) => enabled.includes(id) && !(now() - refreshedAt.get(id) < 30000));
      if (!targets.length && repos.length) return { scheduled: false, cooldown: true };
      for (const id of targets) refreshedAt.set(id, now());
      for (const state of store.getStreams()) {
        const repo = repos.find((entry) => entry.id === state.repoId);
        if (repo && targets.includes(repo.id)) store.saveStream({ ...state, nextAt: iso(now()), refreshRequestedAt: iso(now()), manual: store.getSetting('refreshEnabled', true) === false });
      }
      return { scheduled: true };
    },
    status() { return { running: Boolean(active), stopped, ...counters, streams: store.getStreams().length,
      lastTurn: { ...lastTurn } }; },
  };
}
