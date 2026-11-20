// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { activityKey, lifecycleKey, supportingPushKey } from '../src/activity.js';
import { activityStatusId, activityEvidenceId, activitySearchText, azureDevOpsService } from '../src/activity-text.js';
import { createActivityQuery } from './activity-query.js';
import { localPrLink, mergeUpdates } from './merge-evidence.js';
import { forkJob } from './fork-origin.js';

/** @typedef {import('node:sqlite').SQLOutputValue} SqlValue */
/** @typedef {Record<string, SqlValue>} SqlRow */
/** @typedef {import('../src/activity.js').ActivityEvent} ActivityEvent */
/** @typedef {import('../src/activity.js').EventData} EventData */
/** @typedef {import('./sync.js').StreamState} StreamState */
/** @typedef {import('./sync.js').StreamName} StreamName */
/** The JSON in `events.data`. Insertion always fills `time` and `observedAt`; `data` keeps provider fields beyond EventData. */
/** @typedef {ActivityEvent & { observedAt: string, data?: EventData & Record<string, unknown> }} StoredEvent */
/** An event as the store returns it: the read flags come from their columns and enrichment is merged into `data`. */
/** @typedef {StoredEvent & { seen: boolean, imported: boolean }} HydratedEvent */
/** Every watched repository was resolved through Azure (or is a demo fixture), so its Azure identity is always present. */
/** @typedef {import('./azure-client.js').AzureRepo & { id: string, name: string, disabled?: boolean, localPath?: string }} Repository */
/** Jobs share the indexed columns; every other field belongs to the job type. */
/** @typedef {{ id: string, type: string, repoId: string, nextAt?: string, status?: string, eventId?: string, [field: string]: unknown }} Job */
/** Settings hold any JSON value, written with JSON.stringify. */
/** @typedef {null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue }} SettingValue */
/** @typedef {{ type: string, id: string | number, data: unknown }} EntityInput */
/**
 * Reads one JSON `data` column. A present row yields T; a possibly missing row yields T or undefined.
 * @template T
 * @typedef {<R extends SqlRow | undefined>(row: R) => R extends SqlRow ? T : T | undefined} Reader
 */

/**
 * node:sqlite rows are untyped. Every JSON `data` column is read here, and the readers below assert
 * which stored shape each table holds, so the rest of the module works with typed values.
 * @param {SqlRow | undefined} row
 * @returns {any}
 */
const parse = row => (row ? JSON.parse(/** @type {string} */ (row.data)) : undefined);
/** @type {Reader<Repository>} */
const readRepo = parse;
/** @type {Reader<StoredEvent>} */
const readEvent = parse;
/** Rows selected with `json_extract(data,'$.data.status')`, so `data` is present. */
/** @type {Reader<StoredEvent & { data: EventData & Record<string, unknown> }>} */
const readEventWithData = parse;
/** @type {Reader<Job>} */
const readJob = parse;
/** @type {Reader<StreamState>} */
const readStream = parse;
/** @type {Reader<SettingValue>} */
const readSetting = parse;
/** @type {Reader<Record<string, unknown>>} */
const readEnrichment = parse;
/** Entity data depends on the entity type, so callers check its shape. */
/** @type {Reader<unknown>} */
const readEntity = parse;
/** The first sync imports this far back from its baseline (server/sync.js, the first window's `since`). */
const FIRST_SYNC_MS = 7 * 86400000;
/** @param {string} message */
const badRequest = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });
/** @param {string} value */
const stamp = value => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);
/** SQLite owns durable events, cursor transactions and indexed view-only activity membership. */
export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  /** @param {string} sql */
  const q = sql => db.prepare(sql);
  // `settings.data` is a TEXT column, so the incremented counter reads back as a string.
  const activityRevision = () => /** @type {string} */ (q("SELECT data FROM settings WHERE key='activityRevision'").get()?.data || '0');
  const bumpActivity = () =>
    q(`INSERT INTO settings(key,data) VALUES('activityRevision','1')
    ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();
  /** @template T @param {() => T} fn @returns {T} */
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  /** @param {string} id */
  const requireRepo = id => {
    const repo = readRepo(q('SELECT data FROM repositories WHERE id=?').get(id));
    if (!repo) throw Object.assign(new Error('Repository is not watched.'), { code: 'NOT_FOUND' });
    return repo;
  };
  /**
   * The boundary for event rows: `enrichment` is the JSON overlay column joined from the enrichment table.
   * @type {Reader<HydratedEvent>}
   */
  const hydrate = row => {
    if (!row) return /** @type {any} */ (undefined);
    const event = readEvent(row);
    /** @type {Record<string, unknown>} */
    const overlay = row.enrichment ? JSON.parse(/** @type {string} */ (row.enrichment)) : {};
    return { ...event, data: { ...event.data, ...overlay }, seen: Boolean(row.seen), imported: Boolean(row.imported) };
  };
  /** @param {ActivityEvent} event */
  function indexLabels(event) {
    q(`UPDATE activity_members SET status_id=?, evidence_id=?, search_text=? WHERE event_id=?`).run(
      activityStatusId(event),
      activityEvidenceId(event),
      activitySearchText(event),
      event.id,
    );
  }
  /** @param {StoredEvent} event */
  function saveMembership(event) {
    let key = activityKey(event);
    const candidate = supportingPushKey(event);
    if (candidate && q('SELECT 1 FROM activity_members WHERE group_key=? AND kind=?').get(candidate, 'branch-deleted')) key = candidate;
    q(`INSERT INTO activity_members(event_id,group_key,kind,status_id,evidence_id,search_text,observed,time)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET group_key=excluded.group_key,kind=excluded.kind,
       status_id=excluded.status_id,evidence_id=excluded.evidence_id,search_text=excluded.search_text,observed=excluded.observed,time=excluded.time`).run(
      event.id,
      key,
      event.kind,
      activityStatusId(event),
      activityEvidenceId(event),
      activitySearchText(event),
      stamp(event.observedAt),
      stamp(event.time),
    );
    if (event.kind === 'branch-deleted' && lifecycleKey(event)) {
      const siblings = q(`SELECT e.data,e.seen,e.imported FROM events e WHERE e.repo_id=?
        AND json_extract(e.data,'$.kind')='push' AND CAST(json_extract(e.data,'$.data.pushId') AS TEXT)=?`).all(
        event.repoId,
        // lifecycleKey returned a key, so `data` is present; `?.` only satisfies the compiler.
        String(event.data?.pushId),
      );
      for (const row of siblings)
        if (supportingPushKey(readEvent(row)) === key)
          q('UPDATE activity_members SET group_key=? WHERE event_id=?').run(key, readEvent(row).id);
    }
  }
  /** @param {Job} job */
  function saveJob(job) {
    requireRepo(job.repoId);
    if (typeof job.id !== 'string' || !job.id || typeof job.type !== 'string' || !job.type)
      throw badRequest('Job ID and type are required.');
    q(`INSERT INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id)
       DO UPDATE SET repo_id=excluded.repo_id,type=excluded.type,next_at=excluded.next_at,data=excluded.data`).run(
      job.id,
      job.repoId,
      job.type,
      job.nextAt || '1970-01-01T00:00:00.000Z',
      JSON.stringify(job),
    );
  }
  const selectEvents = 'SELECT e.data,e.seen,e.imported,n.data AS enrichment FROM events e LEFT JOIN enrichment n ON n.event_id=e.id';
  /**
   * Adds each stored completed PR whose merge commit is the new tip of the PR's target ref in this push. An absent match
   * writes nothing.
   * @param {string} id
   */
  function linkPush(id) {
    const push = hydrate(q(`${selectEvents} WHERE e.id=?`).get(id));
    if (!push) return;
    const evidence = /** @type {import('../src/activity.js').MergeEvidenceData} */ (push.data?.mergeEvidence || {});
    const prs = [...(evidence.prs || [])];
    // Saved complete analysis that proves which commits the push introduced outranks tip identity: a branch reset back
    // to an old merge commit matches the tip without introducing it.
    const proven = evidence.status === 'complete' && Array.isArray(evidence.introducedCommitIds);
    const introduced = new Set(((proven && evidence.introducedCommitIds) || []).map(commit => String(commit).toLowerCase()));
    let changed = false;
    for (const ref of mergeUpdates(push)) {
      if (proven && !introduced.has(ref.newObjectId.toLowerCase())) continue;
      const rows = q(`SELECT data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.targetRefName')=?
        AND lower(json_extract(data,'$.data.mergeCommit'))=? ORDER BY time`).all(push.repoId, ref.name, ref.newObjectId.toLowerCase());
      for (const pr of rows.map(readEventWithData)) {
        const key = `${pr.data.pullRequestId}:${ref.name}`;
        const index = prs.findIndex(item => `${item.pullRequestId ?? item.id}:${item.targetRefName}` === key);
        const local = localPrLink(pr);
        if (index < 0) {
          prs.push(local);
          changed = true;
          continue;
        }
        // The tip identity is the strongest relationship; a saved entry for the same PR keeps its metadata and gains
        // the fields only the stored PR has.
        const existing = /** @type {Record<string, unknown>} */ (prs[index]);
        const filled = Object.fromEntries(Object.entries(local).filter(([field, value]) => value != null && existing[field] == null));
        if (existing.relationship === 'result-introduced' && !Object.keys(filled).length) continue;
        prs[index] = { ...prs[index], ...filled, relationship: 'result-introduced' };
        changed = true;
      }
    }
    if (changed) enrichEvent(id, { mergeEvidence: { ...evidence, prs } });
  }
  /** @param {StoredEvent} push */
  function indexPush(push) {
    const insert = q('INSERT OR IGNORE INTO push_tips(event_id,ref,repo_id,tip) VALUES(?,?,?,?)');
    for (const ref of mergeUpdates(push)) insert.run(push.id, ref.name, push.repoId, ref.newObjectId.toLowerCase());
    linkPush(push.id);
  }
  /** @param {StoredEvent} pr */
  function linkPr(pr) {
    const { status, targetRefName, mergeCommit } = pr.data || {};
    if (status !== 'completed' || !targetRefName || !mergeCommit) return;
    for (const row of q('SELECT event_id FROM push_tips WHERE repo_id=? AND ref=? AND tip=?').all(
      pr.repoId,
      targetRefName,
      mergeCommit.toLowerCase(),
    ))
      linkPush(String(row.event_id));
  }
  // Each step upgrades a database below its version and is recorded in user_version once it has run.
  // A fresh database runs every step against empty tables and ends at the last version.
  /** @type {[number, () => void][]} */
  const migrations = [
    [
      2,
      () => {
        // Membership is added without rewriting any existing event or read flag.
        for (const row of q('SELECT data FROM events ORDER BY rowid').all()) saveMembership(readEvent(row));
      },
    ],
    [
      7,
      () => {
        for (const row of q(selectEvents).iterate()) indexLabels(hydrate(row));
        db.exec('DROP INDEX IF EXISTS activity_label; DROP INDEX IF EXISTS activity_evidence;');
      },
    ],
    [
      8,
      () => {
        // Paused repositories kept showing cached activity; disabled ones are hidden everywhere except Repositories.
        db.exec(`UPDATE repositories SET data=json_remove(json_set(data,'$.disabled',
        json(CASE WHEN json_extract(data,'$.paused') THEN 'true' ELSE 'false' END)),'$.paused');`);
      },
    ],
    [
      9,
      () => {
        // Pull now uses git merge --ff-only, so the crash journal for the custom fast-forward is gone.
        db.exec('DROP TABLE IF EXISTS pull_operations;');
      },
    ],
    [
      10,
      () => {
        // Pushes link to completed PRs from stored events; index the stored pushes and link the pairs already stored.
        for (const row of q("SELECT data FROM events WHERE json_extract(data,'$.kind')='push'").all()) indexPush(readEvent(row));
      },
    ],
    [
      11,
      () => {
        // Background merge analysis stopped: its queue goes and saved evidence stays. Evidence a running or retrying job
        // left behind is marked incomplete without progress or retry wording, since nothing will finish it.
        const rows = q(`SELECT event_id,data FROM enrichment WHERE json_extract(data,'$.mergeEvidence.status')='enriching'
          OR event_id IN (SELECT json_extract(data,'$.eventId') FROM jobs WHERE type='merge')`).all();
        q("DELETE FROM jobs WHERE type='merge'").run();
        /** @param {string} text */
        const settled = text => text.replace(/\s*Retrying later\.$/, '');
        for (const row of rows) {
          const evidence = JSON.parse(String(row.data)).mergeEvidence;
          if (!evidence || ['complete', 'not-applicable'].includes(evidence.status)) continue;
          const limitations = (evidence.limitations || [])
            .filter((/** @type {string} */ item) => item !== 'Merge enrichment is still in progress.')
            .map(settled);
          const error =
            evidence.error && typeof evidence.error === 'object'
              ? { ...evidence.error, message: settled(String(evidence.error.message || '')) }
              : evidence.error && settled(String(evidence.error));
          enrichEvent(String(row.event_id), {
            mergeEvidence: { ...evidence, status: 'incomplete', limitations: [...new Set(limitations)], ...(error ? { error } : {}) },
          });
        }
      },
    ],
    [
      12,
      () => {
        // The merge analysis cached Azure commits and their PR lookups, which nothing reads any more, and no code ever
        // wrote a rule. Pushes indexed under the retired "Merge commit" badge get their labels again.
        q("DELETE FROM entities WHERE type IN ('commit','commit-pr')").run();
        db.exec('DROP TABLE IF EXISTS rules;');
        for (const row of q(`${selectEvents} JOIN activity_members m ON m.event_id=e.id WHERE m.evidence_id='merge-commit'`).all())
          indexLabels(hydrate(row));
        q("INSERT OR REPLACE INTO settings(key,data) VALUES('compactPending','true')").run();
      },
    ],
    [
      13,
      () => {
        // Index named searchable fields instead of stringifying entire event payloads into search_text.
        for (const row of q(selectEvents).iterate()) indexLabels(hydrate(row));
        q("INSERT OR REPLACE INTO settings(key,data) VALUES('compactPending','true')").run();
      },
    ],
    [
      14,
      () => {
        // Sync used to save Azure's merge preview updates (refs/pull/N/merge) as service pushes without a branch, and
        // no longer does. The saved ones leave the activity index, so no view lists or counts them. The events stay.
        q(`DELETE FROM activity_members WHERE kind='push' AND event_id IN (SELECT id FROM events
          WHERE json_extract(data,'$.actor')=? AND COALESCE(json_extract(data,'$.branch'),'')=''
          AND COALESCE(json_array_length(data,'$.data.refUpdates'),0)=0)`).run(azureDevOpsService);
        bumpActivity();
      },
    ],
    [
      15,
      () => {
        // Branch creations stored before fork checks existed get one, if a sync recorded them: live, or imported by
        // the first sync's 7-day window. An explicit history import stays unchecked, as it does when it runs.
        const insert = q('INSERT OR IGNORE INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?)');
        const rows = q(`${selectEvents} WHERE json_extract(e.data,'$.kind')='branch-created'
          AND json_extract(n.data,'$.forkOrigin') IS NULL`).all();
        for (const row of rows) {
          const event = hydrate(row);
          const job = forkJob(event);
          if (!job) continue;
          if (event.imported) {
            const baseline = Date.parse(String(getSetting(`baseline:${event.repoId}`, '')));
            if (!(Date.parse(event.time) >= baseline - FIRST_SYNC_MS)) continue;
          }
          insert.run(job.id, job.repoId, job.type, job.nextAt || '1970-01-01T00:00:00.000Z', JSON.stringify(job));
        }
      },
    ],
  ];
  const version = /** @type {{ user_version: number }} */ (q('PRAGMA user_version').get()).user_version;
  if (version > migrations[migrations.length - 1][0]) {
    db.close();
    throw new Error('This database was created by a newer Repo Pulse version.');
  }
  db.exec('PRAGMA foreign_keys = ON');
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        time TEXT NOT NULL, observed_at TEXT NOT NULL, seen INTEGER NOT NULL, imported INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(time DESC,observed_at DESC);
      CREATE TABLE IF NOT EXISTS streams (repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repo_id,stream));
      CREATE TABLE IF NOT EXISTS entities (repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repo_id,type,id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_members (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL,kind TEXT NOT NULL,status_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL,observed REAL NOT NULL,time REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_group ON activity_members(group_key);
      CREATE INDEX IF NOT EXISTS activity_kind ON activity_members(kind);
      CREATE TABLE IF NOT EXISTS enrichment (event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,next_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(type,next_at);
      CREATE TABLE IF NOT EXISTS push_tips (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,ref TEXT NOT NULL,
        repo_id TEXT NOT NULL,tip TEXT NOT NULL,PRIMARY KEY(event_id,ref)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS push_tips_lookup ON push_tips(repo_id,ref,tip);
      CREATE INDEX IF NOT EXISTS events_pr_merge ON events(repo_id,json_extract(data,'$.data.targetRefName'),
        lower(json_extract(data,'$.data.mergeCommit'))) WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='completed';
    `);
    if (version < 7) {
      // Databases from before version 7 have no status columns, or the older label and evidence names.
      // This runs before every step because saveMembership in step 2 already writes status_id and evidence_id.
      const columns = q('PRAGMA table_info(activity_members)').all();
      if (columns.some(column => column.name === 'label')) {
        db.exec(
          'ALTER TABLE activity_members RENAME COLUMN label TO status_id; ALTER TABLE activity_members RENAME COLUMN evidence TO evidence_id;',
        );
      } else if (!columns.some(column => column.name === 'status_id')) {
        db.exec(
          "ALTER TABLE activity_members ADD COLUMN status_id TEXT NOT NULL DEFAULT ''; ALTER TABLE activity_members ADD COLUMN evidence_id TEXT NOT NULL DEFAULT '';",
        );
      }
    }
    for (const [target, run] of migrations) {
      if (version >= target) continue;
      run();
      db.exec(`PRAGMA user_version = ${target}`);
    }
  });
  // Returns the space deleted data held to the file system. VACUUM cannot run inside a transaction, and a failure
  // (for example a full disk) must not stop the app, so the pending flag keeps it for the next start.
  const compact = () => {
    if (!q("SELECT 1 FROM settings WHERE key='compactPending'").get()) return;
    try {
      db.exec('VACUUM');
      q("DELETE FROM settings WHERE key='compactPending'").run();
    } catch {
      /* Retried on the next start. */
    }
  };
  compact();
  /** @param {ActivityEvent[]} events */
  function insertEvents(events) {
    const statement = q('INSERT OR IGNORE INTO events(id,repo_id,time,observed_at,seen,imported,data) VALUES(?,?,?,?,?,?,?)');
    let inserted = false;
    for (const event of events) {
      requireRepo(event.repoId);
      if (!event.id || !event.kind) throw badRequest('Event ID and kind are required.');
      const imported = Boolean(event.imported);
      const time = event.time || event.observedAt || new Date().toISOString();
      const observedAt = event.observedAt || time;
      const value = { ...event, time, observedAt };
      const result = statement.run(
        event.id,
        event.repoId,
        time,
        observedAt,
        Number(Boolean(event.seen || imported)),
        Number(imported),
        JSON.stringify(value),
      );
      if (result.changes) {
        saveMembership(value);
        if (value.kind === 'push') indexPush(value);
        else if (value.kind === 'pr') linkPr(value);
        inserted = true;
      }
    }
    if (inserted) bumpActivity();
  }
  /** @param {StreamState} state */
  function saveStream(state) {
    requireRepo(state.repoId);
    q('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?) ON CONFLICT(repo_id,stream) DO UPDATE SET data=excluded.data').run(
      state.repoId,
      state.stream,
      JSON.stringify(state),
    );
  }
  /** @param {string} repoId @param {EntityInput[]} entities */
  function saveEntities(repoId, entities) {
    const upsert = q(
      'INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?) ON CONFLICT(repo_id,type,id) DO UPDATE SET data=excluded.data',
    );
    for (const entity of entities) upsert.run(repoId, entity.type, String(entity.id), JSON.stringify(entity.data));
  }
  /** @param {string} id @param {unknown} data */
  function enrichEvent(id, data) {
    const event = hydrate(q(`${selectEvents} WHERE e.id=?`).get(id));
    if (!event) throw Object.assign(new Error('Event is no longer available.'), { code: 'NOT_FOUND' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('Enrichment must be an object.');
    const old = readEnrichment(q('SELECT data FROM enrichment WHERE event_id=?').get(id)) || {};
    const overlay = { ...old, ...data };
    const serialized = JSON.stringify(overlay);
    if (serialized === JSON.stringify(old)) return event;
    q('INSERT INTO enrichment(event_id,data) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET data=excluded.data').run(id, serialized);
    // Enrichment affects search/details only, never alert identity, timing or acknowledgement.
    indexLabels({ ...event, data: { ...event.data, ...overlay } });
    bumpActivity();
    return { ...event, data: { ...event.data, ...overlay } };
  }
  const queryActivity = createActivityQuery(db, hydrate, requireRepo, activityRevision);
  /** @template [F=undefined] @param {string} key @param {F} [fallback] @returns {SettingValue | F} */
  function getSetting(key, fallback) {
    const row = q('SELECT data FROM settings WHERE key=?').get(key);
    return row ? readSetting(row) : /** @type {F} */ (fallback);
  }

  /** @param {string} key @param {SettingValue} value */
  function setSetting(key, value) {
    q('INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
  }

  const store = {
    activityRevision,
    listRepos: () => q('SELECT data FROM repositories ORDER BY rowid').all().map(readRepo),
    getRepo: requireRepo,
    /** @param {Repository} repo */
    saveRepo(repo) {
      if (!repo.id || !repo.name) throw badRequest('Repository ID and name are required.');
      const old = readRepo(q('SELECT data FROM repositories WHERE id=?').get(repo.id));
      const value = { disabled: false, ...old, ...repo };
      transaction(() => {
        q('INSERT INTO repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(
          value.id,
          JSON.stringify(value),
        );
        if (old?.name !== value.name || Boolean(old?.disabled) !== Boolean(value.disabled)) bumpActivity();
      });
      return value;
    },
    /** @param {string} id */
    removeRepo(id) {
      requireRepo(id);
      transaction(() => {
        q('DELETE FROM repositories WHERE id=?').run(id);
        bumpActivity();
        q('DELETE FROM settings WHERE key IN (?,?,?)').run(`baseline:${id}`, `checkout:${id}`, `checkout-followup:${id}`);
        q('DELETE FROM settings WHERE substr(key,1,length(?))=?').run(`checkout:${id}:`, `checkout:${id}:`);
      });
    },
    /**
     * Deletes everything sync and history import wrote, so the next sync is a first import from a new baseline.
     * Repositories, linked checkouts and app settings stay.
     */
    resetActivity() {
      transaction(() => {
        db.exec(`DELETE FROM push_tips; DELETE FROM enrichment; DELETE FROM activity_members; DELETE FROM events;
          DELETE FROM entities; DELETE FROM streams; DELETE FROM jobs; DELETE FROM settings WHERE key LIKE 'baseline:%';`);
        bumpActivity();
        q("INSERT OR REPLACE INTO settings(key,data) VALUES('compactPending','true')").run();
      });
      compact();
    },
    /** @param {{ repoIds?: string[], limit?: number, unseen?: boolean }} [options] */
    listEvents({ repoIds, limit = 1000, unseen = false } = {}) {
      const capped = Math.max(1, Math.min(Number(limit) || 1000, 5000));
      if (repoIds?.length === 0) return [];
      /** @type {string[]} */
      const where = [],
        /** @type {(string | number)[]} */
        params = [];
      if (repoIds) {
        repoIds.forEach(requireRepo);
        where.push(`e.repo_id IN (${repoIds.map(() => '?').join(',')})`);
        params.push(...repoIds);
      }
      if (unseen) where.push('e.seen=0 AND e.imported=0');
      return q(
        `${selectEvents} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.time DESC,e.observed_at DESC,e.rowid DESC LIMIT ?`,
      )
        .all(...params, capped)
        .map(hydrate);
    },
    queryActivity,
    /** @param {string} id */
    getEvent: id => hydrate(q(`${selectEvents} WHERE e.id=?`).get(id)),
    /** @param {string} id */
    getEventGroup(id) {
      const member = q('SELECT group_key FROM activity_members WHERE event_id=?').get(id);
      return member
        ? q(`${selectEvents} JOIN activity_members m ON m.event_id=e.id WHERE m.group_key=? ORDER BY m.observed DESC,m.time DESC,e.id DESC`)
            .all(member.group_key)
            .map(hydrate)
        : [];
    },
    /** @param {string} repoId @param {string} source */
    completedCheckoutPulls(repoId, source) {
      const rows = q(`SELECT data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.sourceRefName')=?
        ORDER BY time DESC LIMIT 40`).all(repoId, source);
      const candidates = new Map();
      for (const row of rows) {
        const event = readEventWithData(row),
          data = event.data;
        if (candidates.has(data.pullRequestId)) continue;
        candidates.set(data.pullRequestId, {
          id: data.pullRequestId,
          source,
          target: data.targetRefName,
          sourceId: data.sourceRepositoryId,
          targetId: data.targetRepositoryId,
          head: data.sourceCommit,
          result: data.mergeCommit,
          strategy: data.mergeStrategy,
          url: event.url,
        });
      }
      return [...candidates.values()];
    },
    /** @param {string} id @param {unknown} data */
    enrichEvent(id, data) {
      return transaction(() => enrichEvent(id, data));
    },
    /** @param {unknown} ids @param {boolean} [seen] */
    acknowledge(ids, seen = true) {
      if (!Array.isArray(ids) || ids.length > 5000) throw badRequest('An explicit list of up to 5000 event IDs is required.');
      return transaction(() => {
        const value = Number(Boolean(seen));
        const statement = q('UPDATE events SET seen=? WHERE id=? AND imported=0 AND seen<>?');
        const changedIds = ids.filter(id => statement.run(value, id, value).changes);
        if (changedIds.length) bumpActivity();
        return changedIds;
      });
    },
    /** @param {ActivityEvent[]} events */
    insertEvents(events) {
      return transaction(() => insertEvents(events));
    },
    getStreams: () => q('SELECT data FROM streams').all().map(readStream),
    saveStream,
    /** @param {string} repoId @param {string} type @param {string | number} id */
    getEntity: (repoId, type, id) =>
      readEntity(q('SELECT data FROM entities WHERE repo_id=? AND type=? AND id=?').get(repoId, type, String(id))),
    /** @param {string} repoId @param {string} type */
    listEntities: (repoId, type) =>
      q('SELECT id,data FROM entities WHERE repo_id=? AND type=?')
        .all(repoId, type)
        .map(r => ({ id: /** @type {string} */ (r.id), data: readEntity(r) })),
    /**
     * Sync pages carry their stream state; backfill pages carry none.
     * @param {{ repoId: string, events?: ActivityEvent[], entities?: EntityInput[], jobs?: Job[] }
     *   & ({ stream: StreamName, state: StreamState } | { stream?: StreamName, state?: undefined })} page
     */
    commitPage({ repoId, stream, state, events = [], entities = [], jobs = [] }) {
      return transaction(() => {
        requireRepo(repoId);
        insertEvents(events);
        saveEntities(repoId, entities);
        jobs.forEach(saveJob);
        if (state) saveStream({ ...state, repoId, stream });
      });
    },
    /**
     * @template {string} [T=string]
     * @param {{ type?: T, repoId?: string, status?: string, dueBefore?: string }} [filter]
     * @returns {T extends 'backfill' ? import('./backfill.js').HistoryJob[] : Job[]}
     */
    listJobs({ type, repoId, status, dueBefore } = {}) {
      /** @type {string[]} */
      const where = [],
        /** @type {string[]} */
        params = [];
      if (type) {
        where.push('type=?');
        params.push(type);
      }
      if (repoId) {
        requireRepo(repoId);
        where.push('repo_id=?');
        params.push(repoId);
      }
      if (status) {
        where.push("json_extract(data,'$.status')=?");
        params.push(status);
      }
      if (dueBefore) {
        where.push('next_at<=?');
        params.push(dueBefore);
      }
      const jobs = q(`SELECT data FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY next_at,id`)
        .all(...params)
        .map(readJob);
      // Persisted JSON: rows of type 'backfill' are only ever written by server/backfill.js, as a HistoryJob.
      return /** @type {T extends 'backfill' ? import('./backfill.js').HistoryJob[] : Job[]} */ (jobs);
    },
    saveJob,
    /**
     * Replaces the result for this ref and removes the job in one write, so a finished check is never run again.
     * A missing event (its repository was removed) only removes the job.
     * @param {{ eventId: string, jobId: string, rewrite: import('../src/activity.js').RewriteResult }} result
     */
    saveRewriteResult({ eventId, jobId, rewrite }) {
      transaction(() => {
        const event = hydrate(q(`${selectEvents} WHERE e.id=?`).get(eventId));
        if (event) {
          const evidence = /** @type {import('../src/activity.js').MergeEvidenceData} */ (event.data?.mergeEvidence || {});
          const results = [...(evidence.rewrite || []).filter(item => item.ref !== rewrite.ref), rewrite];
          enrichEvent(eventId, { mergeEvidence: { ...evidence, rewrite: results } });
        }
        q('DELETE FROM jobs WHERE id=?').run(jobId);
      });
    },
    /**
     * Replaces the fork origin of a branch creation and removes its job in one write. A missing event (its repository
     * was removed) only removes the job.
     * @param {{ eventId: string, jobId: string, forkOrigin: import('../src/activity.js').ForkOrigin }} result
     */
    saveForkResult({ eventId, jobId, forkOrigin }) {
      transaction(() => {
        if (q('SELECT 1 FROM events WHERE id=?').get(eventId)) enrichEvent(eventId, { forkOrigin });
        q('DELETE FROM jobs WHERE id=?').run(jobId);
      });
    },
    /**
     * The latest tip each branch had in the stored pushes before push `pushId`, by full ref name. A branch whose latest
     * update deleted it is left out. Pushes missing from the store leave older tips in place.
     * @param {string} repoId @param {number} pushId @returns {Map<string, string>}
     */
    branchTipsBefore(repoId, pushId) {
      /** @type {Map<string, string>} */
      const tips = new Map();
      const rows = q(`SELECT json_extract(u.value,'$.name') AS ref,lower(json_extract(u.value,'$.newObjectId')) AS tip
        FROM events e, json_each(e.data,'$.data.refUpdates') u
        WHERE e.repo_id=? AND json_extract(e.data,'$.kind')='push' AND json_extract(e.data,'$.data.pushId')<?
        ORDER BY json_extract(e.data,'$.data.pushId')`).all(repoId, pushId);
      for (const row of rows) {
        const ref = String(row.ref ?? ''),
          tip = String(row.tip ?? '');
        if (!ref.startsWith('refs/heads/')) continue;
        if (/^[0-9a-f]{40}$/.test(tip) && !/^0+$/.test(tip)) tips.set(ref, tip);
        else tips.delete(ref);
      }
      return tips;
    },
    /**
     * Branches worth checking as the origin of `ref`: the targets of its stored pull requests, oldest first, then the
     * repository's most common pull request target. Pull requests from forks are left out.
     * @param {string} repoId @param {string} ref @returns {string[]}
     */
    forkCandidates(repoId, ref) {
      const rows = q(`SELECT json_extract(data,'$.data.sourceRefName') AS source,json_extract(data,'$.data.targetRefName') AS target,
        json_extract(data,'$.data.pullRequestId') AS id FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.fork') IS NULL
        ORDER BY time,observed_at,json_extract(data,'$.data.pullRequestId')`).all(repoId);
      /** Pull request IDs by target. A PR has a row per change, so it is counted once. @type {Map<string, Set<string>>} */
      const targets = new Map();
      /** @type {string[]} */
      const own = [];
      for (const row of rows) {
        const target = String(row.target ?? '');
        if (!target.startsWith('refs/heads/')) continue;
        const ids = targets.get(target) ?? new Set();
        targets.set(target, ids.add(String(row.id)));
        if (row.source === ref && !own.includes(target)) own.push(target);
      }
      const common = [...targets].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0]?.[0];
      return [...new Set([...own, ...(common ? [common] : [])])].filter(target => target !== ref);
    },
    getSetting,
    setSetting,
    close: () => db.close(),
  };
  return store;
}
