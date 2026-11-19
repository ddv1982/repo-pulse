// @ts-check
import { createHash } from 'node:crypto';
import { actorName, branchName, safeAzureUrl } from '../src/events.js';
import { mergeUpdates } from './merge-evidence.js';

/** @typedef {import('../src/activity.js').ActivityKind} ActivityKind */
/** @typedef {import('./azure-client.js').AzureStream} StreamName */
/** @typedef {import('./azure-client.js').AzureRecord} AzureRecord */
/** @typedef {import('./azure-client.js').AzureRepo & { id: string, disabled?: boolean }} WatchedRepo */
/** What `normalize` reads from a stream state; backfill passes `historical: true`. */
/** @typedef {{ initialized: boolean, historical?: boolean }} NormalizeState */
/** What `reconcileRefs` reads from a stream state. */
/** @typedef {{ initialized: boolean, window: { until: string } }} RefReconcileState */
/**
 * @typedef {{ id: string, repoId: string, kind: ActivityKind, observedAt: string, time: string, actor: string,
 *   branch: string, summary: string, url: string, title?: string, data?: Record<string, unknown>,
 *   imported: boolean, seen: boolean }} SyncEvent
 */
/** @typedef {Partial<Omit<SyncEvent, 'id'|'repoId'|'kind'|'observedAt'|'imported'|'seen'>>} EventDetail */
/** Entity data is stored JSON, so its shape depends on the entity type. */
/** @typedef {{ type: string, id: string, data: any }} Entity */
/** @typedef {import('./rewrite-check.js').RewriteJob} RewriteJob */
/** @typedef {{ events: SyncEvent[], entities: Entity[], jobs?: RewriteJob[] }} SyncBatch */
/**
 * @typedef {{
 *   getSetting: (key: string, fallback: unknown) => unknown,
 *   getEntity: (repoId: string, type: string, id: string) => any,
 *   listEntities: (repoId: string, type: string) => {id: string, data: any}[],
 * }} NormalizeStore
 */

const ZERO = /^0+$/;
/** @param {unknown} value */
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
/** @param {string} name */
const tagName = name => name.replace(/^refs\/tags\//, '');
/** @type {Record<'created' | 'moved' | 'deleted', string>} */
const tagTitles = { created: 'New tag', moved: 'Tag moved', deleted: 'Tag deleted' };
/** @param {number} ms */
const iso = ms => new Date(ms).toISOString();
/** @param {AzureRecord} pr @returns {{ id: string, name: string, vote: number, required: boolean }[]} */
const reviewers = pr =>
  (pr.reviewers || []).map((/** @type {AzureRecord} */ reviewer) => ({
    id: String(reviewer.id),
    name: reviewer.displayName || 'Unknown reviewer',
    vote: Number(reviewer.vote) || 0,
    required: Boolean(reviewer.isRequired),
  }));
/** Reviewers without a vote are left out, so adding or removing one is not a vote change. @param {AzureRecord} pr @returns {[string, number][]} */
const reviewerVotes = pr =>
  reviewers(pr)
    .filter(({ vote }) => vote)
    .map(({ id, vote }) => /** @type {[string, number]} */ ([id, vote]))
    .sort();
/**
 * Reviewers whose vote differs from the previous snapshot. A snapshot without votes, or a first sighting, has no changes.
 * @param {[string, number][] | undefined} before @param {AzureRecord} pr
 */
const voteChanges = (before, pr) => {
  if (!before) return [];
  const previous = new Map(before);
  return reviewers(pr)
    .filter(reviewer => (previous.get(reviewer.id) ?? 0) !== reviewer.vote)
    .map(({ name, vote }) => ({ name, vote }));
};
/** @param {AzureRecord} pr */
const prState = pr => ({
  status: pr.status,
  isDraft: Boolean(pr.isDraft),
  title: pr.title,
  source: pr.lastMergeSourceCommit?.commitId,
  target: pr.targetRefName,
  votes: reviewerVotes(pr),
});
// Active PRs can expose a successful preview merge. Only completion establishes
// the actual merge result; retain its metadata from this existing response.
/** @param {AzureRecord} item */
const prCompletion = item =>
  item.status === 'completed'
    ? {
        mergeCommit: item.lastMergeCommit?.commitId,
        targetCommit: item.lastMergeTargetCommit?.commitId,
        mergeStatus: item.mergeStatus,
        mergeStrategy: item.completionOptions?.mergeStrategy,
        closedBy: actorName(item.closedBy),
        sourceRepositoryId: item.forkSource ? item.forkSource.repository?.id : item.repository?.id,
        targetRepositoryId: item.repository?.id,
      }
    : {};
/** @param {AzureRecord} build */
const buildState = build => ({
  status: build.status,
  result: build.result,
  finishTime: build.finishTime,
  sourceVersion: build.sourceVersion,
  sourceBranch: build.sourceBranch,
});

/**
 * Turns Azure DevOps stream payloads and complete ref snapshots into stored events, entities, and rewrite jobs.
 * @param {{ store: NormalizeStore, now?: () => number }} options
 */
export function createNormalizer({ store, now = Date.now }) {
  /**
   * @param {WatchedRepo} repo @param {ActivityKind} kind @param {string} sourceId
   * @param {EventDetail & { time: string }} detail @param {boolean} imported @returns {SyncEvent}
   */
  function makeEvent(repo, kind, sourceId, detail, imported) {
    const observedAt = iso(now());
    return {
      id: `${repo.id}:${kind}:${sourceId}`,
      repoId: repo.id,
      kind,
      observedAt,
      actor: 'Unknown',
      branch: '',
      summary: '',
      url: repo.webUrl,
      ...detail,
      imported,
      seen: imported,
    };
  }
  // PRs and builds are snapshots: an event is emitted only when their fingerprint changes.
  /** @param {WatchedRepo} repo @param {string} type @param {string} key @param {{ status: string }} value @param {boolean} historical */
  function snapshot(repo, type, key, value, historical) {
    const previous = store.getEntity(repo.id, type, key);
    // Snapshots saved before votes were recorded adopt the current votes instead of reporting them as a change.
    const comparable = previous?.fingerprint && !('votes' in previous.fingerprint) ? { ...value, votes: undefined } : value;
    const changed = !previous || JSON.stringify(previous.fingerprint) !== JSON.stringify(comparable);
    const revision = (previous?.revision || 0) + Number(changed);
    return {
      previous,
      changed,
      // Historical IDs hash the state without votes, as before votes were recorded, so re-importing a closure finds its row.
      sourceId: historical
        ? `history:${key}:${fingerprint({ ...value, votes: undefined })}`
        : `${key}:${(previous?.revision || 0) + 1}:${fingerprint(value)}`,
      entity: historical ? null : { type, id: key, data: { fingerprint: value, status: value.status, revision } },
    };
  }
  /**
   * A non-status change to a live PR is dated when observed; otherwise the event takes the
   * closure time Azure reports, or the creation time for a PR seen for the first time.
   * @param {AzureRecord} item @param {any} previous @param {boolean} historical
   */
  function prEventTime(item, previous, historical) {
    const unchangedStatus = previous?.fingerprint?.status === item.status;
    if (previous && !historical && unchangedStatus) return iso(now());
    return (item.status !== 'active' ? item.closedDate : null) || (!previous ? item.creationDate : null) || iso(now());
  }
  /**
   * @typedef {{ repo: WatchedRepo, add: (kind: ActivityKind, sourceId: string, detail: EventDetail) => void,
   *   entities: Entity[], refs: Map<string, any>|null, historical: boolean }} NormalizeContext
   * @typedef {(item: AzureRecord, context: NormalizeContext) => void} Normalizer
   */
  /** @type {Record<'pushes'|'prs'|'builds', Normalizer> & Partial<Record<StreamName, Normalizer>>} */
  const normalizers = {
    pushes(item, { repo, add, entities, refs, historical }) {
      const source = String(item.pushId);
      if (!item.pushId || store.getEntity(repo.id, 'push', source)) return;
      const updates = item.refUpdates || [];
      /** @type {AzureRecord[]} */
      const branches = updates.filter((/** @type {AzureRecord} */ ref) => ref.name?.startsWith('refs/heads/'));
      /** @type {AzureRecord[]} */
      const tags = updates.filter((/** @type {AzureRecord} */ ref) => ref.name?.startsWith('refs/tags/'));
      const time = item.date || iso(now());
      const actor = actorName(item.pushedBy);
      const data = { pushId: item.pushId, refUpdates: branches, commits: item.commits || [] };
      const url = safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pushes?pushId=${encodeURIComponent(source)}`);
      entities.push({ type: 'push', id: source, data: { date: time } });
      // Azure lists pushes newest first. Keep a source watermark across pages/snapshots,
      // while retaining every historical event independently of the current ref state.
      /** @param {AzureRecord} ref */
      const recordRef = ref => {
        const previous = refs?.get(ref.name);
        if (historical || (previous?.lastPushId && Number(item.pushId) <= previous.lastPushId)) return;
        const current = {
          name: ref.name,
          objectId: ref.newObjectId,
          active: !ZERO.test(ref.newObjectId || ''),
          evidence: 'push',
          lastPushId: Number(item.pushId),
        };
        refs?.set(ref.name, current);
        entities.push({ type: 'ref', id: ref.name, data: current });
      };
      for (const ref of tags) {
        const change = ZERO.test(ref.oldObjectId || '') ? 'created' : ZERO.test(ref.newObjectId || '') ? 'deleted' : 'moved';
        add('tag', `${source}:${ref.name}`, {
          title: `${tagTitles[change]} · ${tagName(ref.name)}`,
          branch: tagName(ref.name),
          actor,
          time,
          url,
          summary: `${change === 'deleted' ? 'Deleted' : change === 'created' ? 'Created' : 'Moved'} in push ${source}`,
          data: {
            pushId: item.pushId,
            evidence: 'push',
            change,
            name: ref.name,
            oldObjectId: ref.oldObjectId,
            newObjectId: ref.newObjectId,
          },
        });
        recordRef(ref);
      }
      // A tag-only push has no branch work to show; its tag rows carry it.
      if (tags.length && !branches.length) return;
      add('push', source, {
        title: `${actor} pushed${branches.length ? ` to ${branches.map(r => branchName(r.name)).join(', ')}` : ''}`,
        branch: branchName(branches[0]?.name),
        actor,
        time,
        url,
        summary: branches.length
          ? branches.map(ref => `${ref.oldObjectId?.slice(0, 7) || '?'} → ${ref.newObjectId?.slice(0, 7) || '?'}`).join(' · ')
          : 'Repository push',
        data,
      });
      for (const ref of branches) {
        const created = ref.oldObjectId && ZERO.test(ref.oldObjectId);
        const deleted = ref.newObjectId && ZERO.test(ref.newObjectId);
        if (created || deleted)
          add(created ? 'branch-created' : 'branch-deleted', `${source}:${ref.name}`, {
            title: `${created ? 'New branch' : 'Branch deleted'} · ${branchName(ref.name)}`,
            branch: branchName(ref.name),
            actor,
            time,
            url,
            summary: `${created ? 'Created' : 'Deleted'} in push ${source}`,
            data: { ...data, evidence: 'push', ...ref },
          });
        recordRef(ref);
      }
    },
    prs(item, { repo, add, entities, historical }) {
      if (!item.pullRequestId || (item.repository?.id && item.repository.id.toLowerCase() !== repo.azureId?.toLowerCase())) return;
      const key = String(item.pullRequestId);
      const { previous, changed, sourceId, entity } = snapshot(repo, 'pr', key, prState(item), historical);
      if (changed) {
        add('pr', sourceId, {
          title: `PR ${key} · ${item.title || 'Untitled'}`,
          branch: branchName(item.sourceRefName),
          actor: actorName(item.createdBy),
          time: prEventTime(item, previous, historical),
          summary: `${item.isDraft ? 'Draft · ' : ''}${item.status || 'unknown'} → ${branchName(item.targetRefName)}`,
          url: safeAzureUrl(item._links?.web?.href, `${repo.webUrl}/pullrequest/${encodeURIComponent(key)}`),
          data: {
            pullRequestId: item.pullRequestId,
            status: item.status,
            isDraft: item.isDraft,
            sourceRefName: item.sourceRefName,
            targetRefName: item.targetRefName,
            sourceCommit: item.lastMergeSourceCommit?.commitId,
            reviewers: reviewers(item),
            voteChanges: voteChanges(previous?.fingerprint?.votes, item),
            // Azure names a source repository only for a PR from a fork. It stays out of the fingerprint,
            // so recording it creates no update for PRs seen before.
            ...(item.forkSource
              ? { fork: { repository: item.forkSource.repository?.name, project: item.forkSource.repository?.project?.name } }
              : {}),
            ...prCompletion(item),
          },
        });
      }
      if (entity) entities.push(entity);
    },
    builds(item, { repo, add, entities, historical }) {
      if (!item.id || item.repository?.id?.toLowerCase() !== repo.azureId?.toLowerCase()) return;
      const key = String(item.id);
      const { changed, sourceId, entity } = snapshot(repo, 'build', key, buildState(item), historical);
      if (changed) {
        add('build', sourceId, {
          title: `${item.definition?.name || 'Pipeline'} · ${item.buildNumber || key}`,
          branch: branchName(item.sourceBranch),
          actor: actorName(item.requestedFor || item.requestedBy),
          time: item.finishTime || item.startTime || item.queueTime || iso(now()),
          summary: `${item.status || 'unknown'}${item.result ? ` · ${item.result}` : ''} · ${(item.sourceVersion || '').slice(0, 7)}`,
          url: safeAzureUrl(
            item._links?.web?.href,
            `${repo.organization}/${encodeURIComponent(repo.project)}/_build/results?buildId=${encodeURIComponent(key)}`,
          ),
          data: {
            id: item.id,
            buildId: item.id,
            status: item.status,
            result: item.result,
            sourceVersion: item.sourceVersion,
            sourceBranch: item.sourceBranch,
            definition: item.definition,
            reason: item.reason,
          },
        });
      }
      if (entity) entities.push(entity);
    },
  };
  normalizers.closedPrs = normalizers.prs;
  normalizers.activeBuilds = normalizers.builds;

  /**
   * @param {WatchedRepo} repo @param {StreamName} stream @param {AzureRecord[]} records @param {NormalizeState} state
   * @returns {SyncBatch}
   */
  function normalize(repo, stream, records, state) {
    /** @type {SyncEvent[]} */
    const events = [];
    /** @type {Entity[]} */
    const entities = [];
    const historical = Boolean(state.historical);
    const refs = stream === 'pushes' ? new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data])) : null;
    const baseline = /** @type {string} */ (store.getSetting(`baseline:${repo.id}`, iso(now())));
    /** @type {NormalizeContext['add']} */
    const add = (kind, sourceId, detail) => {
      const time = detail.time || iso(now());
      const imported = !state.initialized && Date.parse(time) <= Date.parse(baseline);
      events.push(makeEvent(repo, kind, sourceId, { ...detail, time }, historical || imported));
    };
    const normalizeItem = normalizers[stream];
    if (normalizeItem) for (const item of records) normalizeItem(item, { repo, add, entities, refs, historical });
    // Only a live push that moved an existing branch is checked for a rewrite; history is not news.
    /** @type {RewriteJob[]} */
    const jobs = events
      .filter(event => event.kind === 'push' && !event.imported)
      .flatMap(event =>
        mergeUpdates(/** @type {import('./merge-evidence.js').PushEvent} */ (event)).map(ref => ({
          id: `rewrite:${event.id}:${ref.name}`,
          type: /** @type {const} */ ('rewrite'),
          repoId: repo.id,
          eventId: event.id,
          ref: ref.name,
          oldObjectId: ref.oldObjectId,
          newObjectId: ref.newObjectId,
          attempts: 0,
          nextAt: event.observedAt,
        })),
      );
    return { events, entities, jobs };
  }

  /**
   * @param {WatchedRepo} repo @param {AzureRecord[]} records @param {RefReconcileState} state
   * @returns {SyncBatch}
   */
  function reconcileRefs(repo, records, state) {
    const before = new Map(store.listEntities(repo.id, 'ref').map(entry => [entry.id, entry.data]));
    /** @type {Map<string, AzureRecord>} */
    const current = new Map(records.filter(item => /^refs\/(heads|tags)\//.test(item.name || '')).map(item => [item.name, item]));
    // Tags joined the snapshot after branches. Until one complete snapshot has recorded them,
    // every existing tag would look new, so tag changes are reported only after that baseline.
    const tagsKnown = state.initialized && Boolean(store.getEntity(repo.id, 'ref-baseline', 'tags'));
    /** @param {string} name @param {'created' | 'deleted'} change @param {Record<string, unknown>} data */
    const tagEvent = (name, change, data) =>
      makeEvent(
        repo,
        'tag',
        `ref:${name}:${fingerprint([data.objectId, state.window.until])}`,
        {
          title: `${change === 'created' ? 'Tag first seen' : 'Tag no longer listed'} · ${tagName(name)}`,
          branch: tagName(name),
          time: iso(now()),
          summary:
            change === 'created'
              ? 'Discovered in remote tags; creation time and actor unknown'
              : 'Missing from complete refs snapshot; deletion time and actor unknown',
          data: { ...data, name, change, evidence: 'snapshot' },
        },
        false,
      );
    /** @type {SyncEvent[]} */
    const events = [];
    /** @type {Entity[]} */
    const entities = [];
    for (const [name, item] of current) {
      const previous = before.get(name);
      const tag = name.startsWith('refs/tags/');
      const peeled = item.peeledObjectId ? { peeledObjectId: item.peeledObjectId } : {};
      if (tag) {
        if (tagsKnown && (!previous || previous.active === false))
          events.push(tagEvent(name, 'created', { objectId: item.objectId, ...peeled }));
        entities.push({
          type: 'ref',
          id: name,
          data: { name, objectId: item.objectId, ...peeled, active: true, lastPushId: previous?.lastPushId },
        });
        continue;
      }
      if (state.initialized && (!previous || previous.active === false)) {
        events.push(
          makeEvent(
            repo,
            'branch-created',
            `ref:${name}:${fingerprint([item.objectId, state.window.until])}`,
            {
              title: `Branch first seen · ${branchName(name)}`,
              branch: branchName(name),
              time: iso(now()),
              summary: 'Discovered in remote refs; creation time and actor unknown',
              data: { name, objectId: item.objectId, evidence: 'snapshot' },
              actor: 'Unknown',
            },
            false,
          ),
        );
      }
      entities.push({ type: 'ref', id: name, data: { name, objectId: item.objectId, active: true, lastPushId: previous?.lastPushId } });
    }
    if (state.initialized)
      for (const [name, old] of before) {
        if (old.active !== false && !current.has(name)) {
          if (name.startsWith('refs/tags/')) {
            if (tagsKnown) events.push(tagEvent(name, 'deleted', { objectId: old.objectId }));
            entities.push({ type: 'ref', id: name, data: { ...old, active: false } });
            continue;
          }
          events.push(
            makeEvent(
              repo,
              'branch-deleted',
              `ref:${name}:${fingerprint([old.objectId, state.window.until])}`,
              {
                title: `Branch no longer listed · ${branchName(name)}`,
                branch: branchName(name),
                time: iso(now()),
                summary: 'Missing from complete refs snapshot; deletion time and actor unknown',
                data: { name, objectId: old.objectId, evidence: 'snapshot' },
              },
              false,
            ),
          );
          entities.push({ type: 'ref', id: name, data: { ...old, active: false } });
        }
      }
    entities.push({ type: 'ref-baseline', id: 'tags', data: { at: iso(now()) } });
    return { events, entities };
  }

  return { normalize, reconcileRefs };
}
