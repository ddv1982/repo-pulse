import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCheckoutGit } from '../../server/checkout-git.ts';
import type { CheckoutPull } from '../../server/azure-client.ts';
import type {
  ActivitySwitchResult,
  ActivitySwitchReview,
  BranchActionResult,
  CheckoutIntent,
  CheckoutStatus,
  DecoratedCheckout,
  Repository,
  Review,
  SwitchIntent,
} from '../../src/contract.ts';
import { present, stub } from './typed.ts';

// Fixture repositories and the checkout code under test commit; a clean machine or CI runner has no Git identity.
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
})) {
  process.env[key] ??= value;
}

export function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function checkoutFixture(t: TestContext) {
  // The app canonicalises checkout paths; on Windows that expands 8.3 short names in the temp folder.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pulse-checkout-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'repo.git');
  const source = join(root, 'source');
  const local = join(root, 'local');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--no-local', remote, source);
  const commit = (path: string, file: string, contents: string) => {
    writeFileSync(join(path, file), contents);
    git(path, 'add', '--', file);
    git(path, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-m', contents);
    return git(path, 'rev-parse', 'HEAD');
  };
  const original = commit(source, 'feature.txt', 'initial');
  git(source, 'push', 'origin', 'main');
  git(root, 'clone', '--no-local', remote, local);
  const advance = () => {
    const tip = commit(source, 'feature.txt', 'updated');
    git(source, 'push', 'origin', 'main');
    return tip;
  };
  const repo = stub<Repository>({
    id: 'repo',
    name: 'Orders',
    project: 'Testing',
    organization: 'https://dev.azure.com/example',
    localPath: local,
  });
  const checkoutGit = createCheckoutGit({ matchesRemote: url => url === remote });
  return { remote, source, local, original, advance, commit, repo, checkoutGit };
}

export function squashFixture(t: TestContext) {
  const fixture = checkoutFixture(t);
  const { source, remote, local, commit } = fixture;
  git(source, 'switch', '-c', 'topic');
  const head = commit(source, 'topic.txt', 'topic work');
  git(source, 'push', 'origin', 'topic');
  git(local, 'fetch', 'origin', 'topic');
  git(local, 'switch', '--track', 'origin/topic');
  git(source, 'switch', '-c', 'release', 'main');
  commit(source, 'release.txt', 'release base changes');
  git(source, 'merge', '--squash', 'topic');
  const result = commit(source, 'notes.txt', 'squashed result');
  git(source, 'push', 'origin', 'release');
  git(remote, 'update-ref', '-d', 'refs/heads/topic');
  const repo = { ...fixture.repo, azureId: 'azure-repo' };
  const pr: CheckoutPull & { head: string; result: string } = {
    id: 101,
    source: 'refs/heads/topic',
    target: 'refs/heads/release',
    sourceId: repo.azureId,
    targetId: repo.azureId,
    head,
    result,
    strategy: 'squash',
    url: 'https://dev.azure.com/example/Testing/_git/Orders/pullrequest/101',
  };
  return { ...fixture, repo, pr };
}

/** A checkout's diagnostic, after failing the test if it has none. */
export function diagnosticOf(checkout: CheckoutStatus) {
  return present('diagnostic' in checkout ? checkout.diagnostic : undefined, 'the checkout diagnostic');
}

/** The pull request advice in a checkout's diagnostic, after failing the test if it has none. */
export const adviceOf = (checkout: CheckoutStatus) => present(diagnosticOf(checkout).advice, 'the checkout advice');

/** The rewrite comparison in a checkout's diagnostic, after failing the test if it has none. */
export const comparisonOf = (checkout: CheckoutStatus) => present(diagnosticOf(checkout).comparison, 'the rewrite comparison');

/**
 * A checkout reading passed back as the expected state of a check, pull or switch, as these tests do with the whole
 * reading. The page sends only the expected fields, all set; the adapter compares the ones it needs, and a reading's
 * upstream can be null, as for a branch whose upstream is gone, so the reading is not an intent by type.
 */
export const expectedOf = (checkout: CheckoutStatus) => checkout as CheckoutIntent & SwitchIntent;

/** Whether a checkout offers Check and Pull; both are undefined for a checkout that is not linked or cannot be read. */
export function actions(checkout: CheckoutStatus): { canCheck?: boolean; canPull?: boolean } {
  return 'canPull' in checkout ? checkout : {};
}

/** A checkout that is linked and could be read, after failing the test if it is not. */
export function linked(checkout: CheckoutStatus): DecoratedCheckout {
  assert.ok(isLinked(checkout), `the checkout is ${checkout.state}`);
  return checkout;
}
const isLinked = (checkout: CheckoutStatus): checkout is DecoratedCheckout =>
  checkout.state !== 'unavailable' && checkout.state !== 'not-linked';

/** The branch follow-up a checkout names, after failing the test if it names none. */
export const followupOf = (checkout: CheckoutStatus) => present(linked(checkout).followup, 'the branch follow-up');

/**
 * A switch or branch action result read as one shape: each variant leaves out the fields of the others, so a field
 * it does not have reads as undefined, as it does at run time.
 */
export function outcome(result: ActivitySwitchResult | BranchActionResult): {
  checkout: CheckoutStatus;
  message?: string;
  notice?: string;
  nextStep?: string;
  review?: Review;
  switchReview?: ActivitySwitchReview;
} {
  return result;
}

/** The review a switch waits on, after failing the test if it does not wait. */
export const switchReviewOf = (result: ActivitySwitchResult) => present(outcome(result).switchReview, 'the switch review');

/** The review of a branch follow-up action, after failing the test if it has none. */
export const branchReviewOf = (result: BranchActionResult) => present(outcome(result).review, 'the branch review');
