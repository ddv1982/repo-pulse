import { activityBranch } from '../../src/activity-branch.ts';
import { invalid, notFound } from '../errors.ts';
import { isBranchAction } from '../checkout-branches.ts';
import { isCheckoutIntent, isSwitchIntent } from '../checkout-git.ts';
import type { Handlers } from '../http.ts';
import type { AppContext } from './context.ts';
import type { CheckoutCommand, CheckoutStatus } from '../../src/contract.ts';

/**
 * The checkout command a request names, or a refusal. Each shape is checked here once; the Git identity and ref checks
 * still run when the command does.
 */
function readCheckoutCommand(input: Record<string, unknown>): CheckoutCommand {
  const { operation, expected } = input;
  const confirmation = typeof input.confirmation === 'string' ? input.confirmation : undefined;
  if (operation === 'switch-activity' && isSwitchIntent(expected) && typeof input.eventId === 'string')
    return { operation, expected, eventId: input.eventId, confirmation };
  if (operation === 'switch-branch' && isSwitchIntent(expected) && typeof input.branch === 'string')
    return { operation, expected, branch: input.branch, confirmation };
  if ((operation === 'check' || operation === 'pull') && isCheckoutIntent(expected)) return { operation, expected };
  if (isBranchAction(input) && isCheckoutIntent(expected)) return { ...input, expected };
  throw invalid('Choose a checkout and Git action.');
}

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
    'POST /api/repos/:id/checkout': async ({ params: { id }, body }) => {
      const repo = store.getEnabledRepo(id);
      const command = readCheckoutCommand(body);
      switch (command.operation) {
        case 'switch-activity': {
          const event = store.getEvent(command.eventId);
          if (event?.repoId !== repo.id) throw notFound('Activity not found for this repository.');
          const branch = activityBranch(event);
          if (!branch) throw invalid('This activity does not identify one branch to switch to.');
          const { eventId, confirmation } = command;
          return {
            operation: command.operation,
            ...(await checkoutGit.switchToActivityBranch(repo, branch, command.expected, { eventId, confirmation })),
          };
        }
        case 'switch-branch': {
          // Only a branch the watched repository still lists, like an event, may name the switch target.
          const ref = store.getEntity(repo.id, 'ref', `refs/heads/${command.branch}`);
          if (!ref || ref.active === false) throw invalid('The repository no longer lists this branch.');
          const result = await checkoutGit.switchToActivityBranch(repo, command.branch, command.expected, {
            confirmation: command.confirmation,
          });
          return { operation: command.operation, ...result };
        }
        case 'check':
        case 'pull':
          return { operation: command.operation, ...(await checkoutGit.update(repo, command.operation, command.expected)) };
        default:
          return { operation: command.operation, ...(await checkoutGit.branchAction(repo, command, command.expected)) };
      }
    },
  } satisfies Partial<Handlers>;
}
