import type { Store } from '../store.ts';
import type { AzureProvider } from '../azure-client.ts';
import type { createAzureCli } from '../azure-cli.ts';
import type { createBackfill } from '../backfill.ts';
import type { createCheckoutGit } from '../checkout-git.ts';
import type { createSavedActivityFilters } from '../saved-activity-filters.ts';
import type { demoProvider } from '../demo.ts';
import type { Discovery, DemoSyncStatus, FoldersResponse, RefreshStatus, SyncEngineStatus } from '../../src/contract.ts';

/** Live mode passes the Azure client; demo mode passes demoProvider, which answers only the routes demo serves. */
export type AppProvider = AzureProvider | typeof demoProvider;

/**
 * Demo mode passes a stub, so the app relies only on the two calls both share with createSync, and reset and forget
 * in live mode.
 */
export type AppSync = {
  status: () => SyncEngineStatus | DemoSyncStatus;
  refresh: (repoIds?: string[], authOnly?: boolean) => RefreshStatus | { demo: true };
  reset?: (clear: () => void) => Promise<void>;
  forget?: (repoId: string) => void;
};

/** Start from scratch: the reset in progress, shared by every request that arrives while it runs. */
export type Reset = { readonly running: boolean; readonly failed: boolean; start(): void };

/** What the route handlers work with. */
export type AppContext = {
  store: Store;
  provider: AppProvider;
  sync: AppSync;
  cli: Pick<ReturnType<typeof createAzureCli>, 'diagnostics'> | null | undefined;
  backfill:
    (Pick<ReturnType<typeof createBackfill>, 'start'> & Partial<Pick<ReturnType<typeof createBackfill>, 'retrySignIn'>>) | undefined;
  demo: boolean;
  discover: (path: unknown) => Promise<Discovery>;
  browse: (input: unknown) => Promise<FoldersResponse>;
  checkoutGit: ReturnType<typeof createCheckoutGit>;
  savedFilters: ReturnType<typeof createSavedActivityFilters>;
  onStateRead: () => void;
  startedAt: number;
  reset: Reset;
};

export function createReset(store: Store, sync: AppSync): Reset {
  let running: Promise<void> | null = null;
  /** Set when the last reset failed, until another starts, so the page can say so instead of looking unchanged. */
  let failed = false;
  return {
    get running() {
      return Boolean(running);
    },
    get failed() {
      return failed;
    },
    start() {
      if (!sync.reset) return;
      // The reset waits for the turn in flight, which can sit behind Azure's Retry-After for minutes, so it runs unawaited.
      if (!running) failed = false;
      running ??= sync
        .reset(() => store.resetActivity())
        .then(() => {
          sync.refresh();
        })
        .catch(error => {
          failed = true;
          console.error('Start from scratch failed:', error.name);
        })
        .finally(() => {
          running = null;
        });
    },
  };
}
