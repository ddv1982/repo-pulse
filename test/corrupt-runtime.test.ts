import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, startApp } from '../server/runtime.ts';
import type { AzureProvider } from '../server/azure-client.ts';
import { createBackfill } from '../server/backfill.ts';
import { demoProvider } from '../server/demo.ts';
import { createRewriteCheck } from '../server/rewrite-check.ts';
import { createStore } from '../server/store.ts';
import { createNormalizer } from '../server/normalize.ts';
import { createSync } from '../server/sync.ts';
import type { StateResponse } from '../src/contract.ts';
import { keyedFetch, portOf, TEST_KEY } from './fixtures/access.ts';
import { historyJob, rewriteJob } from './fixtures/jobs.ts';
import { present, watchedIdOf } from './fixtures/typed.ts';

const repo = {
  id: 'one',
  name: 'One',
  azureId: 'a',
  organization: 'https://dev.azure.com/org',
  project: 'P',
  webUrl: 'https://dev.azure.com/org/P/_git/One',
};
const now = Date.parse('2026-11-17T10:00:00Z');
const streamError = {
  code: 'CORRUPT_ROW',
  message: 'The stored streams row "one/pushes" cannot be read: initialized is missing or malformed.',
};

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-corrupt-runtime-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path);
  store.saveRepo(repo);
  return { directory, path, store, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

function corruptStream(path: string) {
  using db = new DatabaseSync(path);
  db.prepare('INSERT INTO streams(repo_id,stream,data) VALUES(?,?,?)').run(
    repo.id,
    'pushes',
    JSON.stringify({ repoId: repo.id, stream: 'pushes', nextAt: new Date(now).toISOString(), error: null }),
  );
}

async function stateReader(t: TestContext, store: ReturnType<typeof createStore>, sync: ReturnType<typeof createSync>, remove: () => void) {
  const app = createApp({ store, provider: demoProvider, sync, accessKey: TEST_KEY });
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    store.close();
    remove();
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${portOf(app)}/api/state`;
  return () => keyedFetch()(url);
}

const jobTypes: ('rewrite' | 'backfill')[] = ['rewrite', 'backfill'];
for (const type of jobTypes) {
  test(`a corrupt ${type} job reports a problem and leaves live reads running`, async t => {
    const { path, store, remove } = database();
    store.saveRepo({ ...repo, id: 'two', name: 'Two' });
    const job = type === 'rewrite' ? rewriteJob(repo.id, 'push-1') : historyJob(repo.id);
    const field = type === 'rewrite' ? 'ref' : 'days';
    store.saveJob(job);
    using db = new DatabaseSync(path);
    db.prepare('UPDATE jobs SET data=json_remove(data,?) WHERE id=?').run(`$.${field}`, job.id);

    const reads: string[] = [];
    let otherTurns = 0;
    let time = now;
    const provider: Pick<AzureProvider, 'read' | 'droppedCommits'> = {
      read: async current => {
        reads.push(present(watchedIdOf(current)));
        return { items: [], nextCursor: null };
      },
      droppedCommits: async () => assert.fail('the corrupt job should fail before reading Azure'),
    };
    const clock = () => time;
    const rewrite = createRewriteCheck({ store, provider, now: clock });
    const other = () => {
      otherTurns++;
      return false;
    };
    const normalizer = createNormalizer({ store, now: clock });
    const sync = createSync({
      store,
      provider,
      now: clock,
      normalizer,
      background: {
        rewrite: type === 'rewrite' ? rewrite.tick : other,
        history: type === 'backfill' ? () => backfill.tick() : other,
      },
    });
    const backfill = createBackfill({ store, provider, normalize: normalizer.normalize, now: clock });
    const getState = await stateReader(t, store, sync, remove);
    const failedTicks: number[] = [];
    for (let tick = 1; tick <= 14; tick++) {
      await sync.tick().catch(() => {
        failedTicks.push(tick);
      });
      time += 600001;
    }
    assert.deepEqual(failedTicks, [], `${reads.length} live reads in 14 ticks`);
    assert.equal(reads.length, 14);
    assert.deepEqual([...new Set(reads)].sort(), ['one', 'two']);
    assert.equal(otherTurns, type === 'rewrite' ? 1 : 2);
    assert.equal(sync.status().errors, 2);

    const response = await getState();
    assert.equal(response.status, 200, 'the state endpoint remains available while the queue is corrupt');
    const state: StateResponse = await response.json();
    assert.deepEqual(state.syncStatus.overall, {
      state: 'problem',
      reason: `The stored jobs row "${job.id}" cannot be read: ${field} is missing or malformed.`,
    });

    db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
    for (let tick = 0; tick < 7; tick++) {
      await sync.tick();
      time += 600001;
    }
    const recovered: StateResponse = await (await getState()).json();
    assert.notEqual(recovered.syncStatus.overall.state, 'problem', 'the queue problem clears when it reads successfully again');
  });
}

test('a corrupt stream during startup leaves the port free for a same-process retry', async t => {
  const { directory, path, store, remove } = database();
  store.close();
  corruptStream(path);

  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = portOf(reservation);
  await new Promise(resolve => reservation.close(resolve));

  // Keep the regression test able to close a listener leaked by a failed start.
  const listeners = new Set<Server>();
  // The wrapper below forwards the original receiver through Reflect.apply.
  // oxlint-disable-next-line typescript/unbound-method
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    if (args[0] === port) listeners.add(this);
    Reflect.apply(listen, this, args);
    return this;
  });
  t.after(async () => {
    for (const app of listeners) if (app.listening) await new Promise(resolve => app.close(resolve));
    remove();
  });

  await assert.rejects(startApp({ port, dataDir: directory }), streamError);
  {
    using db = new DatabaseSync(path);
    db.prepare("UPDATE streams SET data=json_set(data,'$.initialized',json('false'))").run();
  }
  const runtime = await startApp({ port, dataDir: directory });
  try {
    assert.equal(portOf(runtime.app), port);
  } finally {
    await runtime.close();
  }
});

test('an API request that cannot read a corrupt stream logs a 500 and reports the row', async t => {
  const { path, store, remove } = database();
  const sync = createSync({ store, provider: { read: async () => assert.fail('state does not read Azure') } });
  const getState = await stateReader(t, store, sync, remove);
  corruptStream(path);
  const log = t.mock.method(console, 'error', () => {});
  const response = await getState();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), streamError);
  assert.deepEqual(
    log.mock.calls.map(call => call.arguments),
    [['Request failed:', 'Error']],
  );
});
