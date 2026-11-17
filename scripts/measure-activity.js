import { createApp } from '../server.js';
import { createStore } from '../server/store.js';

const samples = 20;
const scenarios = [
  { repositories: 2, events: 1100, pendingMergeJobs: 30 },
  { repositories: 12, events: 25000, pendingMergeJobs: 2500 },
];
if (process.argv.includes('--large')) scenarios.push({ repositories: 12, events: 75000, pendingMergeJobs: 2500, mixedRuns: true });

async function measure(scenario) {
  const store = createStore();
  const ids = Array.from({ length: scenario.repositories }, (_, index) => `repo-${index}`);
  for (const id of ids) store.saveRepo({ id, name: id });
  const events = Array.from({ length: scenario.events }, (_, index) => {
    const run = Math.floor(index / 2);
    const isBuild = scenario.mixedRuns && run % 5 === 0;
    return {
      id: `${isBuild ? 'build' : 'push'}-${index}`, repoId: ids[(isBuild ? run : index) % ids.length], kind: isBuild ? 'build' : 'push',
      seen: index % 11 !== 0, branch: `feature/${index % 100}`, title: isBuild ? `Run ${run}` : `Push ${index}`,
      time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      data: isBuild ? { buildId: run + 1, status: index % 2 ? 'completed' : 'inProgress', result: index % 2 ? 'succeeded' : undefined }
        : { pushId: index + 1 },
    };
  });
  store.insertEvents(events);
  for (const event of events.filter(event => event.kind === 'push').slice(0, scenario.pendingMergeJobs)) {
    store.saveJob({ id: `merge:${event.id}`, eventId: event.id, repoId: event.repoId, type: 'merge', status: 'pending' });
  }
  const app = createApp({ store, provider: {}, sync: { status: () => ({}) } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const read = async path => {
    const response = await fetch(base + path);
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
    const result = { ...scenario, samples };
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
      result[name] = { p95Ms: Number(times[Math.ceil(samples * 0.95) - 1].toFixed(1)), bytes };
    }
    console.log(JSON.stringify(result));
  } finally {
    await new Promise(resolve => app.close(resolve));
    store.close();
  }
}

for (const scenario of scenarios) await measure(scenario);
