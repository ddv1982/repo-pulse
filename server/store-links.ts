import { localPrLink, mergeUpdates } from './merge-evidence.ts';
import { readEvent } from './store-records.ts';
import type { MergeEvidenceData } from '../src/activity.ts';
import type { StoredEvent } from '../src/contract.ts';
import type { StoreDb } from './store-db.ts';
import type { StoreEvents } from './store-events.ts';

/**
 * Links between stored pushes and completed pull requests, by tip: `push_tips` indexes the refs each push moved, and a
 * push whose new tip is a completed PR's merge commit on the PR's target gains that PR in its merge evidence. None of
 * these writes opens a transaction; the facade owns them.
 */
export function createStoreLinks({ q }: StoreDb, events: Pick<StoreEvents, 'getEvent' | 'enrich'>) {
  /**
   * Adds each stored completed PR whose merge commit is the new tip of the PR's target ref in this push. An absent match
   * writes nothing.
   */
  function linkPush(id: string) {
    const push = events.getEvent(id);
    if (!push) return;
    const evidence = (push.data?.mergeEvidence || {}) as MergeEvidenceData;
    const prs = [...(evidence.prs || [])];
    // Saved complete analysis that proves which commits the push introduced outranks tip identity: a branch reset back
    // to an old merge commit matches the tip without introducing it.
    const proven = evidence.status === 'complete' && Array.isArray(evidence.introducedCommitIds);
    const introduced = new Set(((proven && evidence.introducedCommitIds) || []).map(commit => String(commit).toLowerCase()));
    let changed = false;
    for (const ref of mergeUpdates(push)) {
      if (proven && !introduced.has(ref.newObjectId.toLowerCase())) continue;
      const rows = q(`SELECT id,data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.targetRefName')=?
        AND lower(json_extract(data,'$.data.mergeCommit'))=? ORDER BY time`).all(push.repoId, ref.name, ref.newObjectId.toLowerCase());
      for (const pr of rows.map(readEvent)) {
        // The query matched `data.status`, so `data` is present; `?.` only satisfies the compiler.
        const key = `${pr.data?.pullRequestId}:${ref.name}`;
        const index = prs.findIndex(item => `${item.pullRequestId ?? item.id}:${item.targetRefName}` === key);
        const local = localPrLink(pr);
        if (index < 0) {
          prs.push(local);
          changed = true;
          continue;
        }
        // The tip identity is the strongest relationship; a saved entry for the same PR keeps its metadata and gains
        // the fields only the stored PR has.
        const existing = prs[index] as Record<string, unknown>;
        const filled = Object.fromEntries(Object.entries(local).filter(([field, value]) => value != null && existing[field] == null));
        if (existing.relationship === 'result-introduced' && !Object.keys(filled).length) continue;
        prs[index] = { ...prs[index], ...filled, relationship: 'result-introduced' };
        changed = true;
      }
    }
    if (changed) events.enrich(id, { mergeEvidence: { ...evidence, prs } });
  }
  /** Records the refs a push moved and links it to the completed PRs already stored. */
  function indexPush(push: StoredEvent) {
    const insert = q('INSERT OR IGNORE INTO push_tips(event_id,ref,repo_id,tip) VALUES(?,?,?,?)');
    for (const ref of mergeUpdates(push)) insert.run(push.id, ref.name, push.repoId, ref.newObjectId.toLowerCase());
    linkPush(push.id);
  }
  /** Links a completed PR to the stored pushes that moved its target to its merge commit. */
  function linkPr(pr: StoredEvent) {
    const { status, targetRefName, mergeCommit } = pr.data || {};
    if (status !== 'completed' || !targetRefName || !mergeCommit) return;
    for (const row of q('SELECT event_id FROM push_tips WHERE repo_id=? AND ref=? AND tip=?').all(
      pr.repoId,
      targetRefName,
      mergeCommit.toLowerCase(),
    ))
      linkPush(String(row.event_id));
  }
  /** Links a newly inserted event: a push by its tips, a PR by its merge commit. */
  function linkInserted(event: StoredEvent) {
    if (event.kind === 'push') indexPush(event);
    else if (event.kind === 'pr') linkPr(event);
  }
  return { indexPush, linkInserted };
}

export type StoreLinks = ReturnType<typeof createStoreLinks>;
