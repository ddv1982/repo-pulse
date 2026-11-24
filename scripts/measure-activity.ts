import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type AppProvider, type AppSync } from '../server.ts';
import { createStore } from '../server/store.ts';
import type { ActivityEvent } from '../src/activity.ts';
import type { Repository } from '../src/contract.d.ts';

const samples = 20;
const scenarios: { repositories: number; events: number; mixedRuns?: boolean }[] = [
  { repositories: 2, events: 1100 },
  { repositories: 12, events: 25000 },
];
if (process.argv.includes('--large')) scenarios.push({ repositories: 12, events: 75000, mixedRuns: true });

async function measure(scenario: (typeof scenarios)[number]) {
  const store = createStore();
  const ids = Array.from({ length: scenario.repositories }, (_, index) => `repo-${index}`);
  // The measured reads use only the id and name.
  for (const id of ids) store.saveRepo({ id, name: id } as Repository);
  const events = Array.from({ length: scenario.events }, (_, index): ActivityEvent => {
    const run = Math.floor(index / 2);
    const isBuild = scenario.mixedRuns && run % 5 === 0;
    return {
      id: `${isBuild ? 'build' : 'push'}-${index}`,
      repoId: `repo-${(isBuild ? run : index) % scenario.repositories}`,
      kind: isBuild ? 'build' : 'push',
      seen: index % 11 !== 0,
      branch: `feature/${index % 100}`,
      title: isBuild ? `Run ${run}` : `Push ${index}`,
      time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      data: isBuild
        ? { buildId: run + 1, status: index % 2 ? 'completed' : 'inProgress', result: index % 2 ? 'succeeded' : undefined }
        : { pushId: index + 1 },
    };
  });
  store.insertEvents(events);
  const accessKey = randomBytes(32).toString('base64url');
  // The measured routes never call the provider or refresh, and the state route reports an empty sync status.
  const app = createApp({ store, provider: {} as AppProvider, sync: { status: () => ({}) } as AppSync, accessKey });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const read = async (path: string) => {
    const response = await fetch(base + path, { headers: { 'x-repo-pulse-key': accessKey } });
    if (!response.ok) throw new Error(`Unexpected HTTP status ${response.status}`);
    const body = await response.text();
    return { data: JSON.parse(body), bytes: Buffer.byteLength(body) };
  };
  const workloads = {
    metadata: () => read('/api/state'),
    firstPage: () => read('/api/activity?limit=50'),
    search: () => read('/api/activity?limit=50&search=feature%2F99'),
    loadedWindow: async () => {
      const first = await read('/api/activity?limit=200');
      const next = await read(`/api/activity?limit=50&cursor=${encodeURIComponent(first.data.nextCursor)}`);
      return { bytes: first.bytes + next.bytes };
    },
  };
  try {
    const result: Record<string, unknown> = { ...scenario, samples };
    for (const [name, work] of Object.entries(workloads)) {
      for (let warmup = 0; warmup < 3; warmup++) await work();
      const times = [];
      let bytes;
      for (let sample = 0; sample < samples; sample++) {
        const started = performance.now();
        ({ bytes } = await work());
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      // samples is 20, so the 95th percentile is the 19th time.
      result[name] = { p95Ms: Number(times[Math.ceil(samples * 0.95) - 1]?.toFixed(1)), bytes };
    }
    console.log(JSON.stringify(result));
  } finally {
    await new Promise(resolve => app.close(resolve));
    store.close();
  }
}

for (const scenario of scenarios) await measure(scenario);
