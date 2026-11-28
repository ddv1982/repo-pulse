import { createApp } from '../../server/runtime.ts';
import type { AppOptions } from '../../server/runtime.ts';
import { idleSyncStatus } from '../../server/demo.ts';
import type { AppProvider, AppSync } from '../../server/routes/context.ts';
import { TEST_KEY } from './access.ts';

/** A sync with nothing to do: idle, and a refresh that schedules nothing. */
export const idleSync: AppSync = {
  status: idleSyncStatus,
  refresh: () => ({ scheduled: false }),
};

const notInThisTest = (name: string) => () => Promise.reject(new Error(`This test's Azure provider does not answer ${name}.`));

/** An installed Azure CLI that answers only the connection check; a test that needs another read passes its own. */
export const availableProvider: AppProvider = {
  checkConnection: async () => ({ available: true, message: 'Azure CLI is available.' }),
  prReview: notInThisTest('prReview'),
  pushCommits: notInThisTest('pushCommits'),
  resolveRepository: notInThisTest('resolveRepository'),
  completedCheckoutPulls: notInThisTest('completedCheckoutPulls'),
};

/** The app over a test's store, with an idle sync, an available Azure CLI and the test access key unless it passes others. */
export function testApp(options: Pick<AppOptions, 'store'> & Partial<AppOptions>) {
  return createApp({ provider: availableProvider, sync: idleSync, accessKey: TEST_KEY, ...options });
}
