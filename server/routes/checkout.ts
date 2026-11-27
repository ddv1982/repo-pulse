import { activityBranch } from '../../src/activity-branch.ts';
import { invalid, notFound } from '../errors.ts';
import { isBranchAction } from '../checkout-branches.ts';
import { isCheckoutIntent, isSwitchIntent } from '../checkout-git.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';
import type { CheckoutStatus } from '../../src/contract.ts';

/** Linked checkouts: their status, the branch picker, and the Git actions a person confirms. */
export function checkoutRoutes({ store, demo, checkoutGit }: AppContext) {
  return {
    'GET /api/checkouts': async () => {
      const repos = store.listRepos().filter(repo => !repo.disabled);
      const results: [string, CheckoutStatus][] = [];
      if (!demo)
        for (let i = 0; i < repos.length; i += 2) {
          results.push(
            ...(await Promise.all(
              repos.slice(i, i + 2).map(async repo => [repo.id, await checkoutGit.status(repo)] as [string, CheckoutStatus]),
            )),
          );
        }
      return Object.fromEntries(results);
    },
    'GET /api/repos/:id/checkout/branches': async ({ params: { id } }) => {
      const repo = store.getEnabledRepo(id);
      const local = new Set(await checkoutGit.localBranches(repo));
      return { branches: store.listBranches(repo).map(name => ({ name, local: local.has(name) })) };
    },
    'GET /api/repos/:id/checkout/status': async ({ params: { id }, query }) => {
      const repo = store.getEnabledRepo(id);
      return await checkoutGit.status(repo, { fresh: query.get('fresh') === '1' });
    },
    'POST /api/repos/:id/checkout': async ({ params: { id }, body: input }) => {
      const repo = store.getEnabledRepo(id);
      const { operation, expected } = input;
      if (operation === 'switch-activity' && isSwitchIntent(expected) && typeof input.eventId === 'string') {
        const event = store.getEvent(input.eventId);
        if (event?.repoId !== repo.id) throw notFound('Activity not found for this repository.');
        const branch = activityBranch(event);
        if (!branch) throw invalid('This activity does not identify one branch to switch to.');
        return await checkoutGit.switchToActivityBranch(repo, branch, expected, {
          eventId: input.eventId,
          confirmation: typeof input.confirmation === 'string' ? input.confirmation : undefined,
        });
      }
      if (operation === 'switch-branch' && isSwitchIntent(expected) && typeof input.branch === 'string') {
        // Only a branch the watched repository still lists, like an event, may name the switch target.
        const ref = store.getEntity(repo.id, 'ref', `refs/heads/${input.branch}`);
        if (!ref || ref.active === false) throw invalid('The repository no longer lists this branch.');
        return await checkoutGit.switchToActivityBranch(repo, input.branch, expected, {
          confirmation: typeof input.confirmation === 'string' ? input.confirmation : undefined,
        });
      }
      if (isBranchAction(input) && isCheckoutIntent(expected)) return await checkoutGit.branchAction(repo, input, expected);
      if ((operation !== 'check' && operation !== 'pull') || !isCheckoutIntent(expected)) {
        throw invalid('Choose a checkout and Git action.');
      }
      return await checkoutGit.update(repo, operation, expected);
    },
  } satisfies Partial<Handlers>;
}
