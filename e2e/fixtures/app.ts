// Shared fixtures for the browser suites. node --test runs each file in its own process, so each file shares one
// Chromium. Every test gets its own browser context, app and data directory. Each resource registers its cleanup as
// soon as it exists, so a failure part-way through setup still stops what was already started.
import { after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page, PageScreenshotOptions } from '@playwright/test';
import { startApp } from '../../server/runtime.ts';
import { portOf, rememberKey, rememberRuntime } from '../../test/fixtures/access.ts';
import { browserPath } from './browser.ts';

/** How long one cleanup step may take before the next one runs anyway. */
const STEP_LIMIT = 10_000;
/** The longest a Playwright action or navigation waits before it fails. */
const ACTION_LIMIT = 10_000;

let shared: Promise<Browser> | undefined;
after(async () => {
  const browser = await shared?.catch(() => undefined);
  await browser?.close();
});

function sharedBrowser() {
  return (shared ??= browserPath().then(executablePath => chromium.launch({ executablePath, headless: true })));
}

type Step = () => unknown;
const cleanups = new WeakMap<TestContext, { gates: Step[]; steps: Step[] }>();

function limited(step: Step) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`A cleanup step took longer than ${STEP_LIMIT} ms.`)), STEP_LIMIT);
  });
  return Promise.race([Promise.resolve().then(step), limit]).finally(() => clearTimeout(timer));
}

function cleanupFor(t: TestContext) {
  let cleanup = cleanups.get(t);
  if (cleanup) return cleanup;
  const created = { gates: [] as Step[], steps: [] as Step[] };
  cleanups.set(t, created);
  t.after(async () => {
    const errors: unknown[] = [];
    // Held responses go first, so closing a page never waits on a route handler that is still parked.
    for (const step of [...created.gates, ...created.steps.reverse()]) {
      try {
        await limited(step);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed.');
  });
  return created;
}

/** Runs a step when the test ends, after steps deferred later and even when an earlier step fails. */
export function defer(t: TestContext, step: Step) {
  cleanupFor(t).steps.push(step);
}

/** An after hook that joins this test's cleanup stack, for helpers that take one, such as the Git checkout fixtures. */
export function cleanupStack(t: TestContext) {
  return { after: (step: Step) => defer(t, step) };
}

/**
 * A response a route handler holds until the test releases it. The test end releases it first. If the test never
 * releases it, it opens on its own after the limit and the test fails, so a missed release cannot hang the suite.
 */
export function gate(t: TestContext, label: string, limit = ACTION_LIMIT) {
  const { promise, resolve } = Promise.withResolvers<void>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resolve();
  }, limit);
  const release = () => {
    clearTimeout(timer);
    resolve();
  };
  cleanupFor(t).gates.push(() => {
    release();
    if (timedOut) throw new Error(`${label} was not released within ${limit} ms.`);
  });
  return { opened: promise, release };
}

type PageOptions = BrowserContextOptions & {
  /** Store this access key before the app loads, as opening the launch link once does. */
  key?: string;
  /** Also fail the test on console errors, not only on uncaught page errors. */
  consoleErrors?: boolean;
};

/** A browser context of its own for this test, closed when the test ends. */
export async function openContext(t: TestContext, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1280, height: 900 }, ...options });
  defer(t, async () => {
    // A route handler still reading a response when the context closes would reject after the test has ended.
    await Promise.all(context.pages().map(page => page.unrouteAll({ behavior: 'ignoreErrors' })));
    await context.close();
  });
  context.setDefaultTimeout(ACTION_LIMIT);
  return context;
}

/** A page in a new context. The test fails on page errors, and a failed test leaves a screenshot. */
export async function openPage(t: TestContext, { key, consoleErrors = false, ...options }: PageOptions = {}) {
  const context = await openContext(t, options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (consoleErrors) {
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
  }
  defer(t, () => assert.deepEqual(errors, [], 'the page reported errors'));
  defer(t, () => saveFailure(t, page, errors.length > 0));
  if (key) await rememberKey(page, key);
  return page;
}

async function saveFailure(t: TestContext, page: Page, pageFailed: boolean) {
  if ((t.passed && !pageFailed) || page.isClosed()) return;
  const name = t.fullName
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  const path = join('test-results', 'failures', `${name}.png`);
  await mkdir(join('test-results', 'failures'), { recursive: true });
  await page.screenshot({ path, fullPage: true, timeout: 5000 });
  t.diagnostic(`Failure screenshot: ${path}`);
}

type Runtime = Awaited<ReturnType<typeof startApp>>;

/** Starts the real app on its own data directory. The demo seed is the default; highlights are off. */
export async function startTestApp(t: TestContext, { demo = true, highlights = false }: { demo?: boolean; highlights?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-pulse-e2e-'));
  defer(t, () => rm(directory, { recursive: true, force: true }));
  const start = async () => rememberRuntime(await startApp({ demo, highlights, port: 0, dataDir: directory }));
  let runtime: Runtime = await start();
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= runtime.close());
  defer(t, stop);
  return {
    directory,
    get runtime() {
      return runtime;
    },
    stop,
    async restart() {
      await stop();
      runtime = await start();
      stopping = undefined;
      return runtime;
    },
  };
}

/** Listens on a free local port and stops listening when the test ends. */
export async function listen(t: TestContext, server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  defer(t, () => {
    if (!server.listening) return;
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${portOf(server)}`;
}

/**
 * Starts the page's refresh now, as returning to the window does, instead of waiting for the five second poll, and
 * waits for its state read. A focus while a refresh runs joins that refresh, so this repeats until a new one starts;
 * a refresh that starts after the call also proves the one before it finished.
 */
export async function refreshNow(page: Page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const started = page
      .waitForRequest(request => new URL(request.url()).pathname === '/api/state', { timeout: 250 })
      .catch(() => undefined);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const request = await started;
    if (request) {
      await request.response();
      return;
    }
  }
  throw new Error('No refresh started within 10 s.');
}

/** Saves a documentation screenshot under test-results, only when SCREENSHOTS=1. */
export async function capture(target: Page | Locator, name: string, options: PageScreenshotOptions = {}) {
  if (process.env.SCREENSHOTS !== '1') return;
  await mkdir('test-results', { recursive: true });
  await target.screenshot({ animations: 'disabled', ...options, path: join('test-results', name) });
}
