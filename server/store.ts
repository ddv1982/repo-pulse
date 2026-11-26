import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { activityKey, lifecycleKey, supportingPushKey } from '../src/activity.ts';
import {
  activityStatusId,
  activityEvidenceId,
  activitySearchText,
  azureDevOpsService,
  SEARCH_INDEX_VERSION,
} from '../src/activity-text.ts';
import { createActivityQuery } from './activity-query.ts';
import { localPrLink, mergeUpdates } from './merge-evidence.ts';
import { forkJob } from './fork-origin.ts';
import { isRecord } from './azure-records.ts';
import {
  corruptRow,
  readActivityRevision,
  readAnyJob,
  readEntity,
  readEvent,
  readJob,
  readOverlay,
  readRepository,
  readSetting,
  readStream,
} from './store-records.ts';
import type { SQLOutputValue as SqlValue } from 'node:sqlite';
import type { ActivityEvent } from '../src/activity.ts';
import type { StreamState, StreamName } from './sync.ts';
import type { StoredEvent, HydratedEvent, Repository } from '../src/contract.d.ts';
import type { Job, JobType, JobOf, Settings, SettingKey } from './store-records.ts';
import type { Entity, EntityData, EntityType } from './normalize.ts';

export type {
  SqlValue,
  ActivityEvent,
  StreamState,
  StreamName,
  StoredEvent,
  HydratedEvent,
  Repository,
  Job,
  JobType,
  JobOf,
  Settings,
  SettingKey,
  Entity,
  EntityData,
  EntityType,
};
export type SqlRow = Record<string, SqlValue>;

export type { EventData } from '../src/activity.ts';

type JobQuery = { repoId?: string; status?: string; dueBefore?: string };
type JobFilter = JobQuery & { type?: JobType };
/** The first sync imports this far back from its baseline (server/sync.ts, the first window's `since`). */
const FIRST_SYNC_MS = 7 * 86400000;
const badRequest = (message: string) => Object.assign(new Error(message), { code: 'BAD_REQUEST' });
const stamp = (value: string | number) => {
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
};
/**
 * Writes a copy of a database about to be upgraded from `version` next to it, as `<name>.pre-v<version>`, and removes
 * older copies. The copy goes to a temporary name first: if another opener upgraded the file since `version` was read,
 * the copy is not at `version`, so it is dropped and the copy that opener made stays.
 */
export function copyBeforeUpgrade(db: DatabaseSync, path: string, version: number) {
  const name = `${basename(path)}.pre-v${version}`;
  const copy = join(dirname(path), name);
  const temporary = `${copy}.tmp-${process.pid}`;
  try {
    rmSync(temporary, { force: true });
    db.prepare('VACUUM INTO ?').run(temporary);
    const check = new DatabaseSync(temporary, { readOnly: true });
    const copied = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    if (copied !== version) return;
    chmodSync(temporary, 0o600);
    renameSync(temporary, copy);
  } finally {
    rmSync(temporary, { force: true });
  }
  const prefix = `${basename(path)}.pre-v`;
  for (const entry of readdirSync(dirname(path)))
    if (entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)) && entry !== name)
      rmSync(join(dirname(path), entry), { force: true });
}

/** SQLite owns durable events, cursor transactions and indexed view-only activity membership. */
export function createStore(path = ':memory:', { highlights = false } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  // Another process reading or writing the file, such as a probe script, makes a write wait briefly instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');
  const statements: Map<string, import('node:sqlite').StatementSync> = new Map();
  /** Prepares and caches static SQL statements for the lifetime of this connection. */
  const q = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  // `settings.data` is a TEXT column, so the incremented counter reads back as a string.
  const activityRevision = () => {
    const row = q("SELECT data FROM settings WHERE key='activityRevision'").get();
    return row ? readActivityRevision(row.data) : '0';
  };
  const bumpActivity = () =>
    q(`INSERT INTO settings(key,data) VALUES('activityRevision','1')
    ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();
  const transaction = <T>(fn: () => T): T => {
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
  const requireRepo = (id: string) => {
    const row = q('SELECT id,data FROM repositories WHERE id=?').get(id);
    const repo = row && readRepository(row);
    if (!repo) throw Object.assign(new Error('Repository is not watched.'), { code: 'NOT_FOUND' });
    return repo;
  };
  /**
   * The boundary for event rows: `enrichment` is the JSON overlay column joined from the enrichment table.
   */
  const hydrate = (row: SqlRow): HydratedEvent => {
    const event = readEvent(row);
    const overlay = row.enrichment == null ? {} : readOverlay(event.id, row.enrichment);
    return { ...event, data: { ...event.data, ...overlay }, seen: Boolean(row.seen), imported: Boolean(row.imported) };
  };
  /** The event a lookup by ID found, or undefined. */
  const hydrateFound = (row: SqlRow | undefined) => (row ? hydrate(row) : undefined);
  function indexLabels(event: ActivityEvent) {
    q(`UPDATE activity_members SET status_id=?, evidence_id=?, search_text=? WHERE event_id=?`).run(
      activityStatusId(event),
      activityEvidenceId(event),
      activitySearchText(event),
      event.id,
    );
  }
  function saveMembership(event: StoredEvent) {
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
      const siblings = q(`SELECT e.id,e.data,e.seen,e.imported FROM events e WHERE e.repo_id=?
        AND json_extract(e.data,'$.kind')='push' AND CAST(json_extract(e.data,'$.data.pushId') AS TEXT)=?`).all(
        event.repoId,
        // lifecycleKey returned a key, so `data` is present; `?.` only satisfies the compiler.
        String(event.data?.pushId),
      );
      for (const row of siblings) {
        const sibling = readEvent(row);
        if (supportingPushKey(sibling) === key) q('UPDATE activity_members SET group_key=? WHERE event_id=?').run(key, sibling.id);
      }
    }
  }
  function saveJob(job: Job) {
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
  const selectEvents = 'SELECT e.id,e.data,e.seen,e.imported,n.data AS enrichment FROM events e LEFT JOIN enrichment n ON n.event_id=e.id';
  /**
   * Adds each stored completed PR whose merge commit is the new tip of the PR's target ref in this push. An absent match
   * writes nothing.
   */
  function linkPush(id: string) {
    const push = hydrateFound(q(`${selectEvents} WHERE e.id=?`).get(id));
    if (!push) return;
    const evidence = (push.data?.mergeEvidence || {}) as import('../src/activity.ts').MergeEvidenceData;
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
    if (changed) enrichEvent(id, { mergeEvidence: { ...evidence, prs } });
  }
  function indexPush(push: StoredEvent) {
    const insert = q('INSERT OR IGNORE INTO push_tips(event_id,ref,repo_id,tip) VALUES(?,?,?,?)');
    for (const ref of mergeUpdates(push)) insert.run(push.id, ref.name, push.repoId, ref.newObjectId.toLowerCase());
    linkPush(push.id);
  }
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
  // Each step upgrades a database below its version and is recorded in user_version once it has run.
  // A fresh database runs every step against empty tables and ends at the last version.
  const migrations: [number, () => void][] = [
    [
      2,
      () => {
        // Membership is added without rewriting any existing event or read flag.
        for (const row of q('SELECT id,data FROM events ORDER BY rowid').all()) saveMembership(readEvent(row));
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
        for (const row of q("SELECT id,data FROM events WHERE json_extract(data,'$.kind')='push'").all()) indexPush(readEvent(row));
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
        const settled = (text: string) => text.replace(/\s*Retrying later\.$/, '');
        for (const row of rows) {
          const id = String(row.event_id);
          const evidence = readOverlay(id, row.data).mergeEvidence;
          if (!isRecord(evidence) || evidence.status === 'complete' || evidence.status === 'not-applicable') continue;
          const listed = evidence.limitations || [];
          if (!Array.isArray(listed) || !listed.every(item => typeof item === 'string'))
            throw corruptRow('enrichment', id, 'mergeEvidence.limitations');
          const limitations = listed.filter(item => item !== 'Merge enrichment is still in progress.').map(settled);
          const stored = evidence.error;
          const error =
            stored && typeof stored === 'object'
              ? { ...stored, message: settled('message' in stored && typeof stored.message === 'string' ? stored.message : '') }
              : // JSON values other than objects have no default object representation.
                // oxlint-disable-next-line typescript/no-base-to-string
                stored && settled(String(stored));
          enrichEvent(id, {
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
        // A history import can store rows inside that window too, and they cannot be told apart, so a repository that
        // ran one keeps all its imported rows unchecked.
        const insert = q('INSERT OR IGNORE INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?)');
        const histories = new Set(
          q("SELECT DISTINCT repo_id FROM jobs WHERE type='backfill'")
            .all()
            .map(row => String(row.repo_id)),
        );
        const rows = q(`${selectEvents} WHERE json_extract(e.data,'$.kind')='branch-created'`).all();
        for (const row of rows) {
          const event = hydrate(row);
          const job = event.data?.forkOrigin ? null : forkJob(event);
          if (!job) continue;
          if (event.imported) {
            if (histories.has(event.repoId)) continue;
            const baseline = Date.parse(getSetting(`baseline:${event.repoId}`, ''));
            if (!(Date.parse(String(event.time)) >= baseline - FIRST_SYNC_MS)) continue;
          }
          insert.run(job.id, job.repoId, job.type, job.nextAt || '1970-01-01T00:00:00.000Z', JSON.stringify(job));
        }
      },
    ],
  ];
  const version = (q('PRAGMA user_version').get() as { user_version: number }).user_version;
  // The list above is never empty.
  const latest = migrations.at(-1)?.[0] ?? 0;
  if (version > latest) {
    db.close();
    throw new Error('This database was created by a newer Repo Pulse version.');
  }
  // Some migrations delete rows and commit even when their logic is wrong, so a database with data is copied first.
  // Only the copy from the latest upgrade is kept.
  if (path !== ':memory:' && version < latest && q('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
    try {
      copyBeforeUpgrade(db, path, version);
    } catch (error) {
      db.close();
      // Upgrading without the copy would leave nothing to recover rows a faulty migration deletes.
      throw new Error(
        `Could not copy the database before upgrading it, so it was left unchanged. Free disk space and start again. (${String((error as Error)?.message || error)})`,
      );
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
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
      CREATE INDEX IF NOT EXISTS events_pr_source ON events(repo_id,json_extract(data,'$.data.sourceRefName'),time DESC)
        WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='completed';
      CREATE INDEX IF NOT EXISTS events_open_pr_source ON events(repo_id,json_extract(data,'$.data.sourceRefName'))
        WHERE json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.status')='active';
      CREATE INDEX IF NOT EXISTS events_pr_id ON events(repo_id,CAST(json_extract(data,'$.data.pullRequestId') AS TEXT))
        WHERE json_extract(data,'$.kind')='pr';
      CREATE INDEX IF NOT EXISTS events_push_id ON events(repo_id,json_extract(data,'$.data.pushId'))
        WHERE json_extract(data,'$.kind')='push';
      CREATE INDEX IF NOT EXISTS events_branch_boundary ON events(repo_id,json_extract(data,'$.data.name'),julianday(time) DESC)
        WHERE json_extract(data,'$.kind') IN ('branch-created','branch-deleted') AND json_extract(data,'$.data.evidence')='push';
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
    // Search text is computed when a row is saved, so rows saved under older terms are rebuilt as migration 13 did.
    // A new database has no rows to rebuild.
    if (getSetting('searchIndexVersion', null) !== SEARCH_INDEX_VERSION) {
      if (version > 0) for (const row of q(selectEvents).iterate()) indexLabels(hydrate(row));
      setSetting('searchIndexVersion', SEARCH_INDEX_VERSION);
    }
  });
  // Returns the space deleted data held to the file system. VACUUM cannot run inside a transaction, and a failure
  // (for example a full disk) must not stop the app, so the pending flag keeps it for the next start.
  const compact = () => {
    if (!q("SELECT 1 FROM settings WHERE key='compactPending'").get()) return;
    try {
      db.exec('VACUUM');
      // In WAL mode the space returns only once the checkpoint copies the vacuumed pages back; a reader can block it.
      if (path !== ':memory:' && db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy) return;
      q("DELETE FROM settings WHERE key='compactPending'").run();
    } catch {
      /* Retried on the next start. */
    }
  };
  compact();
  function insertEvents(events: ActivityEvent[]) {
    const statement = q('INSERT OR IGNORE INTO events(id,repo_id,time,observed_at,seen,imported,data) VALUES(?,?,?,?,?,?,?)');
    let inserted = false;
    for (const event of events) {
      requireRepo(event.repoId);
      if (!event.id || !event.kind) throw badRequest('Event ID and kind are required.');
      const imported = Boolean(event.imported);
      const time = event.time || event.observedAt || new Date().toISOString();
      const observedAt = event.observedAt || String(time);
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
  function saveStream(state: StreamState) {
    requireRepo(state.repoId);
    q('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?) ON CONFLICT(repo_id,stream) DO UPDATE SET data=excluded.data').run(
      state.repoId,
      state.stream,
      JSON.stringify(state),
    );
  }
  function saveEntities(repoId: string, entities: Entity[]) {
    const upsert = q(
      'INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?) ON CONFLICT(repo_id,type,id) DO UPDATE SET data=excluded.data',
    );
    for (const entity of entities) upsert.run(repoId, entity.type, String(entity.id), JSON.stringify(entity.data));
  }
  function enrichEvent(id: string, data: unknown) {
    const event = hydrateFound(q(`${selectEvents} WHERE e.id=?`).get(id));
    if (!event) throw Object.assign(new Error('Event is no longer available.'), { code: 'NOT_FOUND' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('Enrichment must be an object.');
    const stored = q('SELECT data FROM enrichment WHERE event_id=?').get(id);
    const old = stored ? readOverlay(id, stored.data) : {};
    const overlay = { ...old, ...data };
    const serialized = JSON.stringify(overlay);
    if (serialized === JSON.stringify(old)) return event;
    q('INSERT INTO enrichment(event_id,data) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET data=excluded.data').run(id, serialized);
    // Enrichment affects search/details only, never alert identity, timing or acknowledgement.
    indexLabels({ ...event, data: { ...event.data, ...overlay } });
    bumpActivity();
    return { ...event, data: { ...event.data, ...overlay } };
  }
  const queryActivity = createActivityQuery(
    db,
    hydrate,
    requireRepo,
    activityRevision,
    () => String(q("SELECT data FROM settings WHERE key='ciSeenRevision'").get()?.data ?? '0'),
    highlights,
  );
  function getSetting<K extends SettingKey>(key: K): Settings[K] | undefined;
  function getSetting<K extends SettingKey, F>(key: K, fallback: F): Settings[K] | F;
  function getSetting<K extends SettingKey, F>(key: K, fallback?: F): Settings[K] | F | undefined {
    const row = q('SELECT data FROM settings WHERE key=?').get(key);
    return row ? readSetting(key, row.data) : fallback;
  }

  /** The jobs that match, oldest due first. */
  function jobRows({ type, repoId, status, dueBefore }: JobFilter) {
    const where: string[] = [],
      params: string[] = [];
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
      // Let the reader report invalid JSON with a job ID, even when the caller filters by status.
      where.push("CASE WHEN json_valid(data) THEN json_extract(data,'$.status')=? ELSE 1 END");
      params.push(status);
    }
    if (dueBefore) {
      where.push('next_at<=?');
      params.push(dueBefore);
    }
    return q(`SELECT id,repo_id,type,data FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY next_at,id`).all(
      ...params,
    );
  }
  /** Jobs of one type are read as that type; without a type, each row is read as the type its column names. */
  function listJobs<T extends JobType>(filter: JobQuery & { type: T }): JobOf<T>[];
  function listJobs(filter?: JobFilter): Job[];
  function listJobs(filter: JobFilter = {}): Job[] {
    const { type } = filter;
    return type ? jobRows(filter).map(row => readJob(type, row)) : jobRows(filter).map(readAnyJob);
  }

  function setSetting<K extends SettingKey>(key: K, value: Settings[K]) {
    q('INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
  }

  const store = {
    activityRevision,
    listRepos: () => q('SELECT id,data FROM repositories ORDER BY rowid').all().map(readRepository),
    getRepo: requireRepo,
    saveRepo(repo: Repository) {
      if (!repo.id || !repo.name) throw badRequest('Repository ID and name are required.');
      const row = q('SELECT id,data FROM repositories WHERE id=?').get(repo.id);
      const old = row && readRepository(row);
      const value = { disabled: false, ...old, ...repo };
      transaction(() => {
        q('INSERT INTO repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(
          value.id,
          JSON.stringify(value),
        );
        if (old?.name !== value.name || old?.defaultBranch !== value.defaultBranch || Boolean(old?.disabled) !== Boolean(value.disabled))
          bumpActivity();
      });
      return value;
    },
    removeRepo(id: string) {
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
    listEvents({ repoIds, limit = 1000, unseen = false }: { repoIds?: string[]; limit?: number; unseen?: boolean } = {}) {
      const capped = Math.max(1, Math.min(Number(limit) || 1000, 5000));
      if (repoIds?.length === 0) return [];
      const where: string[] = [],
        params: (string | number)[] = [];
      if (repoIds) {
        repoIds.forEach(requireRepo);
        where.push(`e.repo_id IN (${repoIds.map(() => '?').join(',')})`);
        params.push(...repoIds);
      }
      if (unseen) where.push('e.seen=0 AND e.imported=0');
      return db
        .prepare(
          `${selectEvents} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.time DESC,e.observed_at DESC,e.rowid DESC LIMIT ?`,
        )
        .all(...params, capped)
        .map(hydrate);
    },
    queryActivity,
    commitActivity(repoId: string, commits: string[]) {
      if (!commits.length) return [];
      const ids = commits.map(() => '?').join(',');
      return q(`WITH matching AS (
        SELECT e.id,e.data,m.kind,m.observed,m.time,
          CASE m.kind WHEN 'build' THEN lower(json_extract(e.data,'$.data.sourceVersion'))
            ELSE lower(json_extract(e.data,'$.data.mergeCommit')) END AS sha
        FROM events e JOIN activity_members m ON m.event_id=e.id
        WHERE e.repo_id=? AND ((m.kind='build' AND lower(json_extract(e.data,'$.data.sourceVersion')) IN (${ids}))
          OR (m.kind='pr' AND json_extract(e.data,'$.data.status')='completed'
            AND lower(json_extract(e.data,'$.data.mergeCommit')) IN (${ids})))
      ), ranked AS (
        SELECT *,ROW_NUMBER() OVER (PARTITION BY sha,kind,
          COALESCE(json_extract(data,'$.data.buildId'),json_extract(data,'$.data.pullRequestId'),id)
          ORDER BY observed DESC,time DESC,id DESC) AS position
        FROM matching
      )
      SELECT id,data,sha FROM ranked WHERE position=1 ORDER BY time DESC,observed DESC,id DESC`)
        .all(repoId, ...commits, ...commits)
        .map(row => ({ sha: String(row.sha), event: readEvent(row) }));
    },
    getEvent: (id: string) => hydrateFound(q(`${selectEvents} WHERE e.id=?`).get(id)),
    getEventGroup(id: string) {
      // The row has the one selected column.
      const member = q('SELECT group_key FROM activity_members WHERE event_id=?').get(id) as { group_key: string } | undefined;
      return member
        ? q(`${selectEvents} JOIN activity_members m ON m.event_id=e.id WHERE m.group_key=? ORDER BY m.observed DESC,m.time DESC,e.id DESC`)
            .all(member.group_key)
            .map(hydrate)
        : [];
    },
    relatedActivity(event: ActivityEvent) {
      const { repoId, data } = event;
      const pr = event.kind === 'pr' ? data?.pullRequestId : /^refs\/pull\/(\d+)\/merge$/.exec(data?.sourceBranch ?? '')?.[1];
      if (!pr) return [];
      const ref = `refs/pull/${pr}/merge`;
      const rows = q(`WITH pr AS MATERIALIZED (
        SELECT id,data,time FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
          AND CAST(json_extract(data,'$.data.pullRequestId') AS TEXT)=?
      ), related AS (
        SELECT id FROM pr
        UNION
        SELECT e.id FROM events e JOIN activity_members m ON m.event_id=e.id
        WHERE e.repo_id=? AND m.kind='build' AND json_extract(e.data,'$.data.sourceBranch')=?
        UNION
        SELECT e.id FROM pr JOIN events e ON e.repo_id=? AND json_extract(e.data,'$.kind')='build'
          AND json_extract(e.data,'$.data.sourceBranch')=json_extract(pr.data,'$.data.targetRefName')
          AND lower(json_extract(e.data,'$.data.sourceVersion'))=lower(json_extract(pr.data,'$.data.mergeCommit'))
        WHERE ? AND json_extract(pr.data,'$.data.status')='completed'
        UNION
        SELECT e.id FROM pr JOIN events e ON e.repo_id=? AND json_extract(e.data,'$.kind')='push'
          AND json_extract(pr.data,'$.data.fork') IS NULL
          AND (json_extract(pr.data,'$.data.sourceRepositoryId') IS NULL OR json_extract(pr.data,'$.data.targetRepositoryId') IS NULL
            OR lower(json_extract(pr.data,'$.data.sourceRepositoryId'))=lower(json_extract(pr.data,'$.data.targetRepositoryId')))
          JOIN json_each(e.data,'$.data.refUpdates') ref
        WHERE ? AND json_extract(ref.value,'$.name')=json_extract(pr.data,'$.data.sourceRefName')
          AND lower(json_extract(ref.value,'$.newObjectId'))=lower(json_extract(pr.data,'$.data.sourceCommit'))
          AND ltrim(json_extract(ref.value,'$.oldObjectId'),'0')=''
        UNION
        SELECT tip.event_id FROM pr JOIN push_tips tip ON tip.repo_id=?
          AND ((tip.ref=json_extract(pr.data,'$.data.sourceRefName') AND json_extract(pr.data,'$.data.fork') IS NULL
              AND (json_extract(pr.data,'$.data.sourceRepositoryId') IS NULL OR json_extract(pr.data,'$.data.targetRepositoryId') IS NULL
                OR lower(json_extract(pr.data,'$.data.sourceRepositoryId'))=lower(json_extract(pr.data,'$.data.targetRepositoryId')))
              AND tip.tip=lower(json_extract(pr.data,'$.data.sourceCommit')))
            OR (tip.ref=json_extract(pr.data,'$.data.targetRefName') AND tip.tip=lower(json_extract(pr.data,'$.data.mergeCommit'))
              AND json_extract(pr.data,'$.data.status')='completed'
              AND EXISTS (SELECT 1 FROM events push WHERE push.id=tip.event_id
                AND ABS((julianday(push.time)-julianday(pr.time))*86400)<=600)))
        WHERE ?
      )${selectEvents} JOIN activity_members m ON m.event_id=e.id
      WHERE e.id IN (SELECT id FROM related) AND e.id<>?
        AND (m.kind<>'build' OR e.id=(SELECT candidate.event_id FROM activity_members candidate
          WHERE candidate.group_key=m.group_key ORDER BY candidate.observed DESC,candidate.time DESC,candidate.event_id DESC LIMIT 1))
      ORDER BY m.time DESC,m.observed DESC,e.id DESC LIMIT 100`).all(
        repoId,
        String(pr),
        repoId,
        ref,
        repoId,
        Number(event.kind === 'pr'),
        repoId,
        Number(event.kind === 'pr'),
        repoId,
        Number(event.kind === 'pr'),
        event.id,
      );
      return rows.map(hydrate);
    },
    completedCheckoutPulls(this: void, repoId: string, source: string) {
      const rows = q(`SELECT id,data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.sourceRefName')=?
        ORDER BY time DESC LIMIT 40`).all(repoId, source);
      const candidates = new Map();
      for (const row of rows) {
        const event = readEvent(row),
          // The query matched `data.status`, so `data` is present.
          data = event.data ?? {};
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
    enrichEvent(id: string, data: unknown) {
      return transaction(() => enrichEvent(id, data));
    },
    acknowledge(ids: unknown, seen: boolean = true) {
      if (!Array.isArray(ids) || ids.length > 5000) throw badRequest('An explicit list of up to 5000 event IDs is required.');
      return transaction(() => {
        const value = Number(Boolean(seen));
        const statement = q('UPDATE events SET seen=? WHERE id=? AND imported=0 AND seen<>?');
        const changedIds = ids.filter(id => statement.run(value, id, value).changes);
        if (changedIds.length) {
          bumpActivity();
          q(`INSERT INTO settings(key,data) VALUES('ciSeenRevision','1')
            ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();
        }
        return changedIds;
      });
    },
    insertEvents(events: ActivityEvent[]) {
      return transaction(() => insertEvents(events));
    },
    getStreams: () => q('SELECT repo_id,stream,data FROM streams').all().map(readStream),
    saveStream,
    getEntity<T extends EntityType>(repoId: string, type: T, id: string | number): EntityData[T] | undefined {
      const row = q('SELECT repo_id,id,data FROM entities WHERE repo_id=? AND type=? AND id=?').get(repoId, type, String(id));
      return row && readEntity(type, row);
    },
    listEntities: <T extends EntityType>(repoId: string, type: T) =>
      q('SELECT repo_id,id,data FROM entities WHERE repo_id=? AND type=?')
        .all(repoId, type)
        .map(row => ({ id: String(row.id), data: readEntity(type, row) })),
    /**
     * Sync pages carry their stream state; backfill pages carry none.
     */
    commitPage(
      this: void,
      {
        repoId,
        stream,
        state,
        events = [],
        entities = [],
        jobs = [],
      }: { repoId: string; events?: ActivityEvent[]; entities?: Entity[]; jobs?: Job[] } & (
        { stream: StreamName; state: StreamState } | { stream?: StreamName; state?: undefined }
      ),
    ) {
      return transaction(() => {
        requireRepo(repoId);
        insertEvents(events);
        saveEntities(repoId, entities);
        jobs.forEach(saveJob);
        if (state) saveStream({ ...state, repoId, stream });
      });
    },
    listJobs,
    saveJob,
    /**
     * Replaces the result for this ref and removes the job in one write, so a finished check is never run again.
     * A missing event (its repository was removed) only removes the job.
     */
    saveRewriteResult({
      eventId,
      jobId,
      rewrite,
    }: {
      eventId: string;
      jobId: string;
      rewrite: import('../src/activity.ts').RewriteResult;
    }) {
      transaction(() => {
        const event = hydrateFound(q(`${selectEvents} WHERE e.id=?`).get(eventId));
        if (event) {
          const evidence = (event.data?.mergeEvidence || {}) as import('../src/activity.ts').MergeEvidenceData;
          const results = [...(evidence.rewrite || []).filter(item => item.ref !== rewrite.ref), rewrite];
          enrichEvent(eventId, { mergeEvidence: { ...evidence, rewrite: results } });
        }
        q('DELETE FROM jobs WHERE id=?').run(jobId);
      });
    },
    /**
     * Replaces the fork origin of a branch creation and removes its job in one write. A missing event (its repository
     * was removed) only removes the job.
     */
    saveForkResult({
      eventId,
      jobId,
      forkOrigin,
    }: {
      eventId: string;
      jobId: string;
      forkOrigin: import('../src/activity.ts').ForkOrigin;
    }) {
      transaction(() => {
        if (q('SELECT 1 FROM events WHERE id=?').get(eventId)) enrichEvent(eventId, { forkOrigin });
        q('DELETE FROM jobs WHERE id=?').run(jobId);
      });
    },
    /**
     * The latest tip each branch had in the stored pushes before push `pushId`, by full ref name. A branch whose latest
     * update deleted it is left out. Pushes missing from the store leave older tips in place.
     */
    branchTipsBefore(repoId: string, pushId: number): Map<string, string> {
      const tips: Map<string, string> = new Map();
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
     */
    forkCandidates(repoId: string, ref: string): string[] {
      const rows = q(`SELECT json_extract(data,'$.data.sourceRefName') AS source,json_extract(data,'$.data.targetRefName') AS target,
        json_extract(data,'$.data.pullRequestId') AS id FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr' AND json_extract(data,'$.data.fork') IS NULL
        ORDER BY time,observed_at,json_extract(data,'$.data.pullRequestId')`).all(repoId);
      /** Pull request IDs by target. A PR has a row per change, so it is counted once. */
      const targets: Map<string, Set<string>> = new Map();
      const own: string[] = [];
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
    close() {
      statements.clear();
      db.close();
    },
  };
  return store;
}
