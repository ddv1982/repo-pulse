import { readActivityRevision, readAnyJob, readEntity, readJob, readRepository, readSetting, readStream } from './store-records.ts';
import type { Repository, StreamState } from '../src/contract.ts';
import type { Entity, EntityData, EntityType, Job, JobType, JobOf, Settings, SettingKey } from './store-records.ts';
import type { StoreDb } from './store-db.ts';
import { invalid, notFound } from './errors.ts';

type JobQuery = { repoId?: string; status?: string; dueBefore?: string };
type JobFilter = JobQuery & { type?: JobType };

/**
 * The state rows around events: repositories, sync streams, entities, jobs, and settings, including the activity and
 * CI-seen revision counters kept in `settings`. None of these writes opens a transaction; the facade owns them.
 */
export function createStoreState({ q }: StoreDb) {
  // `settings.data` is a TEXT column, so the incremented counter reads back as a string.
  const activityRevision = () => {
    const row = q("SELECT data FROM settings WHERE key='activityRevision'").get();
    return row ? readActivityRevision(row.data) : '0';
  };
  const bumpActivity = () =>
    q(`INSERT INTO settings(key,data) VALUES('activityRevision','1')
    ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();
  const ciSeenRevision = () => String(q("SELECT data FROM settings WHERE key='ciSeenRevision'").get()?.data ?? '0');
  const bumpCiSeen = () =>
    q(`INSERT INTO settings(key,data) VALUES('ciSeenRevision','1')
            ON CONFLICT(key) DO UPDATE SET data=CAST(data AS INTEGER)+1`).run();

  function getSetting<K extends SettingKey>(key: K): Settings[K] | undefined;
  function getSetting<K extends SettingKey, F>(key: K, fallback: F): Settings[K] | F;
  function getSetting<K extends SettingKey, F>(key: K, fallback?: F): Settings[K] | F | undefined {
    const row = q('SELECT data FROM settings WHERE key=?').get(key);
    return row ? readSetting(key, row.data) : fallback;
  }
  function setSetting<K extends SettingKey>(key: K, value: Settings[K]) {
    q('INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
  }
  const compactPending = () => Boolean(q("SELECT 1 FROM settings WHERE key='compactPending'").get());
  const requestCompact = () => q("INSERT OR REPLACE INTO settings(key,data) VALUES('compactPending','true')").run();
  const clearCompact = () => q("DELETE FROM settings WHERE key='compactPending'").run();

  const listRepos = () => q('SELECT id,data FROM repositories ORDER BY rowid').all().map(readRepository);
  /** The stored repository, or undefined. */
  const findRepo = (id: string) => {
    const row = q('SELECT id,data FROM repositories WHERE id=?').get(id);
    return row && readRepository(row);
  };
  const requireRepo = (id: string) => {
    const repo = findRepo(id);
    if (!repo) throw notFound('Repository is not watched.', 'NOT_FOUND');
    return repo;
  };
  const writeRepo = (repo: Repository) =>
    q('INSERT INTO repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(repo.id, JSON.stringify(repo));
  const deleteRepo = (id: string) => q('DELETE FROM repositories WHERE id=?').run(id);

  function saveStream(state: StreamState) {
    requireRepo(state.repoId);
    q('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?) ON CONFLICT(repo_id,stream) DO UPDATE SET data=excluded.data').run(
      state.repoId,
      state.stream,
      JSON.stringify(state),
    );
  }
  const getStreams = () => q('SELECT repo_id,stream,data FROM streams').all().map(readStream);

  function saveEntities(repoId: string, entities: Entity[]) {
    const upsert = q(
      'INSERT INTO entities(repo_id,type,id,data) VALUES(?,?,?,?) ON CONFLICT(repo_id,type,id) DO UPDATE SET data=excluded.data',
    );
    for (const entity of entities) upsert.run(repoId, entity.type, String(entity.id), JSON.stringify(entity.data));
  }
  function getEntity<T extends EntityType>(repoId: string, type: T, id: string | number): EntityData[T] | undefined {
    const row = q('SELECT repo_id,id,data FROM entities WHERE repo_id=? AND type=? AND id=?').get(repoId, type, String(id));
    return row && readEntity(type, row);
  }
  const listEntities = <T extends EntityType>(repoId: string, type: T) =>
    q('SELECT repo_id,id,data FROM entities WHERE repo_id=? AND type=?')
      .all(repoId, type)
      .map(row => ({ id: String(row.id), data: readEntity(type, row) }));

  function saveJob(job: Job) {
    requireRepo(job.repoId);
    if (typeof job.id !== 'string' || !job.id || typeof job.type !== 'string' || !job.type) throw invalid('Job ID and type are required.');
    q(`INSERT INTO jobs(id,repo_id,type,next_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id)
       DO UPDATE SET repo_id=excluded.repo_id,type=excluded.type,next_at=excluded.next_at,data=excluded.data`).run(
      job.id,
      job.repoId,
      job.type,
      job.nextAt || '1970-01-01T00:00:00.000Z',
      JSON.stringify(job),
    );
  }
  const deleteJob = (id: string) => q('DELETE FROM jobs WHERE id=?').run(id);
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

  return {
    activityRevision,
    bumpActivity,
    ciSeenRevision,
    bumpCiSeen,
    getSetting,
    setSetting,
    compactPending,
    requestCompact,
    clearCompact,
    listRepos,
    findRepo,
    requireRepo,
    writeRepo,
    deleteRepo,
    saveStream,
    getStreams,
    saveEntities,
    getEntity,
    listEntities,
    saveJob,
    deleteJob,
    listJobs,
  };
}

export type StoreState = ReturnType<typeof createStoreState>;
