import type { GitRunner, Upstream } from './git.ts';
import type { Observation, Observations } from './checkout-observations.ts';
import type {
  ActiveCheckout,
  CheckoutReading,
  CheckoutStatus,
  DecoratedCheckout,
  PullAdvice,
  Repository as LinkedRepo,
} from '../src/contract.ts';

export type ReadCheckoutStatus = (
  path: string,
  repo: LinkedRepo,
) => Promise<{ snapshot: ActiveCheckout; target: Upstream | null; gitDirectory: string | null }>;

/**
 * What the checkout workflows (Check and Pull, PR branch follow-ups, the Activity branch switch) share: the Git runner
 * and hooks path, the clock, saved observations, the status reader, and the upstream steps bound to that runner.
 * createCheckoutGit (server/checkout-git.ts) builds one per checkout adapter and passes it to each workflow.
 */
export type CheckoutContext = {
  run: GitRunner;
  hooks: string;
  now: () => number;
  observations: Observations;
  statusAt: ReadCheckoutStatus;
  /** The decorated status of a checkout, or `unavailable` when it cannot be read. */
  inspect: (path: string, repo: LinkedRepo) => Promise<CheckoutStatus>;
  decorate: (repo: LinkedRepo, path: string, snapshot: ActiveCheckout) => Promise<DecoratedCheckout>;
  remoteTarget: (path: string, repo: LinkedRepo, remote: string, source: string) => Promise<{ target: Upstream | null }>;
  upstreamFor: (path: string, repo: LinkedRepo, branch: string | null) => Promise<{ target: Upstream | null }>;
  validateUpstream: (path: string, target: Upstream) => Promise<void>;
  fetchUpstream: (path: string, target: Upstream, destination?: string | null) => Promise<void>;
  trackingTip: (path: string, tracking: string, before?: boolean) => Promise<string | null>;
  fetchFailure: (error: unknown) => 'missing-ref' | { title: string; suggestion: string };
  observedAt: (repo: LinkedRepo, path: string, target: Upstream | null, gitDirectory: string | null) => Observation | undefined;
  upstreamIdentity: (path: string, target: Upstream | null, gitDirectory?: string | null) => string;
  readMissing: (path: string, repo: LinkedRepo, target: Upstream, snapshot: ActiveCheckout) => Promise<PullAdvice | undefined>;
  matchesIntent: (snapshot: CheckoutReading, expected: Pick<CheckoutReading, 'branch' | 'head' | 'upstream' | 'identity'>) => boolean;
  verifyCheckoutDirectory: (path: string, expected: string | null) => Promise<void>;
};
