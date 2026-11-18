import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { activityKey, lifecycleKey, supportingPushKey } from '../src/activity.js';
import { activityStatusId, activityEvidenceId, activitySearchText } from '../src/activity-text.js';
import { createActivityQuery } from './activity-query.js';

const parse = (row) => row ? JSON.parse(row.data) : undefined;
const badRequest = (message) => Object.assign(new Error(message), { code: 'BAD_REQUEST' });
const stamp = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
/** SQLite owns durable events, cursor transactions and indexed view-only activity membership. */
export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  const q = (sql) => db.prepare(sql);
  const activityRevision = () => q("SELECT data FROM settings WHERE key='activityRevision'").get()?.data || '0';
  const bumpActivity = () => q(`INSERT INTO settings(key,data) VALUES('activityRevision','1')
    ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();
  const version = q('PRAGMA user_version').get().user_version;
  if (version > 9) { db.close(); throw new Error('This database was created by a newer Repo Pulse version.'); }
  db.exec('PRAGMA foreign_keys = ON');
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const requireRepo = (id) => {
    const repo = parse(q('SELECT data FROM repositories WHERE id=?').get(id));
    if (!repo) throw Object.assign(new Error('Repository is not watched.'), { code: 'NOT_FOUND' });
    return repo;
  };
  const hydrate = (row) => {
    if (!row) return undefined;
    const event = parse(row);
    const overlay = row.enrichment ? JSON.parse(row.enrichment) : {};
    return { ...event, data: { ...event.data, ...overlay }, seen: Boolean(row.seen), imported: Boolean(row.imported) };
  };
  function indexLabels(event) {
    q(`UPDATE activity_members SET status_id=?, evidence_id=?, search_text=? WHERE event_id=?`)
      .run(activityStatusId(event), activityEvidenceId(event), activitySearchText(event), event.id);
  }
  function saveMembership(event) {
    let key = activityKey(event);
    const candidate = supportingPushKey(event);
    if (candidate && q('SELECT 1 FROM activity_members WHERE group_key=? AND kind=?').get(candidate, 'branch-deleted')) key = candidate;
    q(`INSERT INTO activity_members(event_id,group_key,kind,status_id,evidence_id,search_text,observed,time)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET group_key=excluded.group_key,kind=excluded.kind,
       status_id=excluded.status_id,evidence_id=excluded.evidence_id,search_text=excluded.search_text,observed=excluded.observed,time=excluded.time`)
      .run(event.id, key, event.kind, activityStatusId(event), activityEvidenceId(event), activitySearchText(event), stamp(event.observedAt), stamp(event.time));
    if (event.kind === 'branch-deleted' && lifecycleKey(event)) {
      const siblings = q(`SELECT e.data,e.seen,e.imported FROM events e WHERE e.repo_id=?
        AND json_extract(e.data,'$.kind')='push' AND CAST(json_extract(e.data,'$.data.pushId') AS TEXT)=?`)
        .all(event.repoId, String(event.data.pushId));
      for (const row of siblings) if (supportingPushKey(parse(row)) === key)
        q('UPDATE activity_members SET group_key=? WHERE event_id=?').run(key, parse(row).id);
    }
  }
  function saveJob(job) {
    requireRepo(job.repoId);
    if (typeof job.id !== 'string' || !job.id || typeof job.type !== 'string' || !job.type) throw badRequest('Job ID and type are required.');
    q(`INSERT INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id)
       DO UPDATE SET repo_id=excluded.repo_id,type=excluded.type,next_at=excluded.next_at,data=excluded.data`)
      .run(job.id, job.repoId, job.type, job.nextAt || '1970-01-01T00:00:00.000Z', JSON.stringify(job));
  }
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
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY,data TEXT NOT NULL);
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
    `);
    if (version < 7) {
      // Databases from before version 7 have no status columns, or the older label and evidence names.
      const columns = q('PRAGMA table_info(activity_members)').all();
      if (columns.some(column => column.name === 'label')) {
        db.exec('ALTER TABLE activity_members RENAME COLUMN label TO status_id; ALTER TABLE activity_members RENAME COLUMN evidence TO evidence_id;');
      } else if (!columns.some(column => column.name === 'status_id')) {
        db.exec("ALTER TABLE activity_members ADD COLUMN status_id TEXT NOT NULL DEFAULT ''; ALTER TABLE activity_members ADD COLUMN evidence_id TEXT NOT NULL DEFAULT '';");
      }
    }
    if (version < 2) {
      // Membership and metadata jobs are added without rewriting any existing event or read flag.
      for (const row of q('SELECT data FROM events ORDER BY rowid').all()) saveMembership(parse(row));
      for (const row of q("SELECT data FROM events WHERE json_extract(data,'$.kind')='push'").all()) {
        const event = parse(row);
        saveJob({ id: `merge:${event.id}`, type: 'merge', repoId: event.repoId, eventId: event.id,
          status: 'pending', nextAt: '1970-01-01T00:00:00.000Z' });
      }
    }
    if (version < 4) {
      // Push associations can be empty when refs move to an already-created PR result.
      // Retry those histories once with range enumeration; cached metadata and read flags stay intact.
      for (const row of q("SELECT data FROM events WHERE json_extract(data,'$.kind')='push'").all()) {
        const event = parse(row);
        const eligible = Array.isArray(event.data?.refUpdates) && event.data.refUpdates.some((ref) => ref.name?.startsWith('refs/heads/') &&
          typeof ref.oldObjectId === 'string' && ref.oldObjectId.length && !/^0+$/.test(ref.oldObjectId) &&
          typeof ref.newObjectId === 'string' && ref.newObjectId.length && !/^0+$/.test(ref.newObjectId) && ref.oldObjectId !== ref.newObjectId);
        if (eligible) saveJob({ id: `merge:${event.id}`,type: 'merge',repoId: event.repoId,eventId: event.id,
          status: 'pending',stage: 'commits',cursor: null,nextAt: '1970-01-01T00:00:00.000Z' });
      }
    }
    if (version < 7) {
      for (const row of q('SELECT e.data,e.seen,e.imported,n.data AS enrichment FROM events e LEFT JOIN enrichment n ON n.event_id=e.id').iterate()) indexLabels(hydrate(row));
      db.exec("DROP INDEX IF EXISTS activity_label; DROP INDEX IF EXISTS activity_evidence; PRAGMA user_version = 7;");
    }
    if (version < 8) {
      // Paused repositories kept showing cached activity; disabled ones are hidden everywhere except Repositories.
      db.exec(`UPDATE repositories SET data=json_remove(json_set(data,'$.disabled',
        json(CASE WHEN json_extract(data,'$.paused') THEN 'true' ELSE 'false' END)),'$.paused');
        PRAGMA user_version = 8;`);
    }
    if (version < 9) {
      // Pull now uses git merge --ff-only, so the crash journal for the custom fast-forward is gone.
      db.exec('DROP TABLE IF EXISTS pull_operations; PRAGMA user_version = 9;');
    }
  });
  const selectEvents = 'SELECT e.data,e.seen,e.imported,n.data AS enrichment FROM events e LEFT JOIN enrichment n ON n.event_id=e.id';
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
      const result = statement.run(event.id,event.repoId,time,observedAt,Number(Boolean(event.seen || imported)),Number(imported),JSON.stringify(value));
      if (result.changes) { saveMembership(value); inserted = true; }
    }
    if (inserted) bumpActivity();
  }
  function saveStream(state) {
    requireRepo(state.repoId);
    q('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?) ON CONFLICT(repo_id,stream) DO UPDATE SET data=excluded.data')
      .run(state.repoId,state.stream,JSON.stringify(state));
  }
  function saveEntities(repoId, entities) {
    const upsert = q('INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?) ON CONFLICT(repo_id,type,id) DO UPDATE SET data=excluded.data');
    for (const entity of entities) upsert.run(repoId,entity.type,String(entity.id),JSON.stringify(entity.data));
  }
  function enrichEvent(id, data) {
    const event = hydrate(q(`${selectEvents} WHERE e.id=?`).get(id));
    if (!event) throw Object.assign(new Error('Event is no longer available.'), { code: 'NOT_FOUND' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('Enrichment must be an object.');
    const old = parse(q('SELECT data FROM enrichment WHERE event_id=?').get(id)) || {};
    const overlay = { ...old, ...data };
    const serialized = JSON.stringify(overlay);
    if (serialized === JSON.stringify(old)) return event;
    q('INSERT INTO enrichment(event_id,data) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET data=excluded.data').run(id,serialized);
    // Enrichment affects search/details only, never alert identity, timing or acknowledgement.
    indexLabels({ ...event, data: { ...event.data, ...overlay } });
    bumpActivity();
    return { ...event, data: { ...event.data, ...overlay } };
  }
  const queryActivity = createActivityQuery(db, hydrate, requireRepo);
  function getSetting(key, fallback) {
    const row = q('SELECT data FROM settings WHERE key=?').get(key);
    return row ? parse(row) : fallback;
  }

  function setSetting(key, value) {
    q('INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
  }

  const store = {
    activityRevision,
    listRepos: () => q('SELECT data FROM repositories ORDER BY rowid').all().map(parse),
    getRepo: requireRepo,
    saveRepo(repo) {
      if (!repo.id || !repo.name) throw badRequest('Repository ID and name are required.');
      const old = parse(q('SELECT data FROM repositories WHERE id=?').get(repo.id));
      const value = { disabled: false,...old,...repo };
      transaction(() => {
        q('INSERT INTO repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(value));
        if (old?.name !== value.name || Boolean(old?.disabled) !== Boolean(value.disabled)) bumpActivity();
      });
      return value;
    },
    removeRepo(id) {
      requireRepo(id);
      transaction(() => {
        q('DELETE FROM repositories WHERE id=?').run(id);
        bumpActivity();
        q('DELETE FROM settings WHERE key IN (?,?,?)').run(`baseline:${id}`, `checkout:${id}`, `checkout-followup:${id}`);
        q("DELETE FROM rules WHERE json_extract(data,'$.repoId')=?").run(id);
      });
    },
    listEvents({ repoIds,limit = 1000,unseen = false } = {}) {
      const capped = Math.max(1,Math.min(Number(limit) || 1000,5000));
      if (repoIds?.length === 0) return [];
      const where = [], params = [];
      if (repoIds) { repoIds.forEach(requireRepo); where.push(`e.repo_id IN (${repoIds.map(() => '?').join(',')})`); params.push(...repoIds); }
      if (unseen) where.push('e.seen=0 AND e.imported=0');
      return q(`${selectEvents} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.time DESC,e.observed_at DESC,e.rowid DESC LIMIT ?`)
        .all(...params,capped).map(hydrate);
    },
    queryActivity,
    getEvent: (id) => hydrate(q(`${selectEvents} WHERE e.id=?`).get(id)),
    getEventGroup(id) {
      const member = q('SELECT group_key FROM activity_members WHERE event_id=?').get(id);
      return member ? q(`${selectEvents} JOIN activity_members m ON m.event_id=e.id WHERE m.group_key=? ORDER BY m.observed DESC,m.time DESC,e.id DESC`).all(member.group_key).map(hydrate) : [];
    },
    completedCheckoutPulls(repoId, source) {
      const rows = q(`SELECT data FROM events WHERE repo_id=? AND json_extract(data,'$.kind')='pr'
        AND json_extract(data,'$.data.status')='completed' AND json_extract(data,'$.data.sourceRefName')=?
        ORDER BY time DESC LIMIT 40`).all(repoId, source);
      const candidates = new Map();
      for (const row of rows) {
        const event = parse(row), data = event.data;
        if (candidates.has(data.pullRequestId)) continue;
        candidates.set(data.pullRequestId, { id: data.pullRequestId, source, target: data.targetRefName,
          sourceId: data.sourceRepositoryId, targetId: data.targetRepositoryId, head: data.sourceCommit,
          result: data.mergeCommit, strategy: data.mergeStrategy, url: event.url });
      }
      return [...candidates.values()];
    },
    findPushEventsForCommits(repoId,commitIds,targetRef) {
      requireRepo(repoId);
      const ids = [...new Set(commitIds || [])];
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(',');
      const target = targetRef ? "AND json_extract(ref.value,'$.name')=?" : '';
      const params = targetRef ? [repoId,targetRef,...ids,targetRef,...ids,...ids] : [repoId,...ids,...ids,...ids];
      return q(`${selectEvents} WHERE e.repo_id=? AND json_extract(e.data,'$.kind')='push'
        AND EXISTS (SELECT 1 FROM json_each(e.data,'$.data.refUpdates') ref WHERE 1=1 ${target})
        AND (EXISTS (SELECT 1 FROM json_each(e.data,'$.data.refUpdates') ref
          WHERE json_extract(ref.value,'$.newObjectId') IN (${marks}) ${target})
          OR EXISTS (SELECT 1 FROM json_each(n.data,'$.mergeEvidence.introducedCommitIds') commit_id
            WHERE commit_id.value IN (${marks}))
          OR EXISTS (SELECT 1 FROM json_each(n.data,'$.mergeEvidence.candidateCommitIds') candidate_id
            WHERE candidate_id.value IN (${marks}))) ORDER BY e.observed_at DESC,e.id DESC`).all(...params).map(hydrate);
    },
    enrichEvent(id,data) { return transaction(() => enrichEvent(id,data)); },
    commitEnrichment({ jobId,eventId,data,entities = [],job = null }) {
      return transaction(() => {
        const enriched = enrichEvent(eventId,data);
        saveEntities(enriched.repoId,entities);
        if (jobId) q('DELETE FROM jobs WHERE id=?').run(jobId);
        if (job) saveJob(job);
        return enriched;
      });
    },
    acknowledge(ids,seen = true) {
      if (!Array.isArray(ids) || ids.length > 5000) throw badRequest('An explicit list of up to 5000 event IDs is required.');
      transaction(() => {
        const value = Number(Boolean(seen));
        const statement = q('UPDATE events SET seen=? WHERE id=? AND imported=0 AND seen<>?');
        let changed = false;
        for (const id of ids) if (statement.run(value,id,value).changes) changed = true;
        if (changed) bumpActivity();
      });
    },
    insertEvents(events) { return transaction(() => insertEvents(events)); },
    getStreams: () => q('SELECT data FROM streams').all().map(parse),
    saveStream,
    getEntity: (repoId,type,id) => parse(q('SELECT data FROM entities WHERE repo_id=? AND type=? AND id=?').get(repoId,type,String(id))),
    listEntities: (repoId,type) => q('SELECT id,data FROM entities WHERE repo_id=? AND type=?').all(repoId,type).map((r) => ({ id: r.id,data: parse(r) })),
    commitPage({ repoId,stream,state,events = [],entities = [],jobs = [] }) {
      return transaction(() => { requireRepo(repoId); insertEvents(events); saveEntities(repoId,entities); jobs.forEach(saveJob); if (state) saveStream({ ...state,repoId,stream }); });
    },
    listJobs({ type,repoId,status,dueBefore } = {}) {
      const where = [], params = [];
      if (type) { where.push('type=?'); params.push(type); }
      if (repoId) { requireRepo(repoId); where.push('repo_id=?'); params.push(repoId); }
      if (status) { where.push("json_extract(data,'$.status')=?"); params.push(status); }
      if (dueBefore) { where.push('next_at<=?'); params.push(dueBefore); }
      return q(`SELECT data FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY next_at,id`).all(...params).map(parse);
    },
    mergeQueueSummary() {
      return q(`SELECT COUNT(*) AS pending,
        COUNT(CASE WHEN json_extract(j.data,'$.error') IS NOT NULL THEN 1 END) AS errors
        FROM jobs j JOIN repositories r ON r.id=j.repo_id
        WHERE j.type='merge' AND NOT COALESCE(json_extract(r.data,'$.disabled'),0)`).get();
    },
    saveJob,
    removeJob(id) { q('DELETE FROM jobs WHERE id=?').run(id); },
    getSetting, setSetting,
    close: () => db.close(),
  };
  return store;
}
