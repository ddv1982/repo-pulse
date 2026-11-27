import type { CheckoutSnapshot } from './checkout.ts';
import type { BranchAction } from '../contract.ts';

import type { Actions } from './actions.ts';
export type ActivityCheckout = { repoId: string; localPath: string; eventId: string; branch: string; isCurrent: () => boolean };

export function createCheckoutActions({
  checkoutPanel,
  getActivityCheckout,
  confirm,
  toast,
  closeBranchPicker,
  currentView,
}: {
  checkoutPanel: ReturnType<typeof import('./checkout.ts').createCheckoutPanel>;
  getActivityCheckout: () => ActivityCheckout | null;
  confirm: (
    title: string,
    description: string,
    callback: () => Promise<void>,
    label?: string,
    options?: { subject?: string; destructive?: boolean },
  ) => void;
  toast: (message: string) => void;
  closeBranchPicker: () => void;
  currentView: () => () => boolean;
}): Actions<
  | 'switch-activity-branch'
  | 'switch-checkout-branch'
  | 'check-checkout'
  | 'pull-checkout'
  | 'switch-checkout-target'
  | 'review-checkout-branch'
  | 'remove-checkout-branch'
  | 'carry-checkout-branch'
> {
  /** A check, a pull or a branch follow-up action on the checkout the page shows. */
  async function updateCheckout(id: string, command: { operation: 'check' | 'pull' } | BranchAction, checkout: CheckoutSnapshot) {
    const { branch, head, upstream, identity } = checkout;
    try {
      const result = await checkoutPanel.update(id, { ...command, expected: { branch, head, upstream, identity } });
      switch (result.operation) {
        case 'check':
        case 'pull': {
          const shown: CheckoutSnapshot = result.checkout;
          if (shown.diagnostic && !result.updated) return;
          if (result.operation === 'check') {
            const { ahead, behind, lastBranchCheck } = shown;
            const upToDate = lastBranchCheck?.matchesFetchedTip && ahead === 0 && behind === 0;
            return toast(upToDate ? `${branch} is up to date.` : `Checked ${branch} for updates.`);
          }
          return toast(result.updated ? `Updated ${branch}.` : 'The checkout is already at the fetched upstream.');
        }
        default:
          // A follow-up action answers with a message, a review the page now shows, or both.
          if (result.message) toast(result.message);
      }
    } catch (error) {
      void checkoutPanel.read(id, true);
      throw error;
    }
  }

  function branchAction(element: HTMLElement, operation: BranchAction['operation']) {
    const id = element.dataset.id ?? '';
    const checkout = checkoutPanel.snapshots[id];
    if (!checkout) return;
    if (operation === 'switch-update') {
      const advice = checkout.diagnostic?.advice;
      const receipt = advice?.receipt;
      if (!advice || !receipt) return;
      return confirm(
        `Switch to ${advice.branch} and update?`,
        `Git will switch this checkout to ${advice.branch} and fast-forward it if possible. You can review the old local branch afterward.`,
        () => updateCheckout(id, { operation, prId: advice.id, result: receipt.result }, checkout),
        'Switch and update',
      );
    }
    const followup = checkout.followup;
    if (!followup) return;
    const planId = followup.id;
    if (operation === 'remove') {
      return confirm(
        'Remove local branch?',
        'Repo Pulse keeps a local Git reference to the branch’s last commit before deleting the branch.',
        () => updateCheckout(id, { operation, planId }, checkout),
        'Remove local branch',
        { subject: followup.source, destructive: true },
      );
    }
    if (operation === 'carry') {
      const reviewPanel = element.closest('[data-checkout-review]');
      if (!reviewPanel) throw new Error('Repo Pulse: missing required element [data-checkout-review]');
      const commits = [...reviewPanel.querySelectorAll('input:checked')]
        .filter(input => input instanceof HTMLInputElement)
        .map(input => input.value);
      if (!commits.length) return toast('Select at least one commit to carry.');
      return confirm(
        `Apply selected commits to ${checkout.review?.branch}?`,
        'Git will apply your selection on a new local branch in its original order, then switch to it. If Git stops, the follow-up stays in a separate worktree.',
        () => updateCheckout(id, { operation, planId, commits }, checkout),
        'Create branch and apply',
      );
    }
    return updateCheckout(id, { operation, planId }, checkout);
  }

  /**
   * Confirms and runs a branch switch, with a second review when the branch's remote history was rewritten or has
   * diverged from the local branch. Activity and Repositories share it so both ask the same questions.
   * @param done runs after a verified switch, and when the checkout is already on the branch
   */
  async function switchCheckout(
    { repoId, localPath, branch, isCurrent }: { repoId: string; localPath: string; branch: string; isCurrent: () => boolean },
    command: { operation: 'switch-activity'; eventId: string } | { operation: 'switch-branch'; branch: string },
    done: () => void,
  ) {
    const checkout = await checkoutPanel.read(repoId, true);
    if (!isCurrent()) return;
    if (checkout.branch === branch) return done();
    if (checkout.state === 'unavailable' || checkout.state === 'not-linked')
      throw new Error(checkout.diagnostic?.title || 'The linked checkout is unavailable.');
    if (checkout.state === 'in-progress') throw new Error('Finish the Git operation before switching branches.');
    const { branch: current, head, upstream, identity, switchIdentity } = checkout;
    if (!current || !head || !identity) throw new Error('Switching requires an existing branch checked out in Git.');
    if (!switchIdentity) throw new Error('Repo Pulse could not verify the local Git directory.');
    const switchBranch = async (confirmation?: string) => {
      if (!isCurrent()) return;
      const result = await checkoutPanel
        .update(repoId, { ...command, confirmation, expected: { branch: current, head, upstream, identity, switchIdentity } })
        .catch(error => {
          void checkoutPanel.read(repoId, true);
          throw error;
        });
      if (!isCurrent()) return;
      if (result.switchReview) {
        const review = result.switchReview;
        const rewrite = review.previous
          ? `The history of ${review.upstream} changed from ${review.previous.slice(0, 12)} to ${review.tip.slice(0, 12)}. Repo Pulse will save the previous tip before refreshing it. `
          : '';
        const divergence =
          review.ahead && review.behind
            ? `Your local ${branch} is ${review.ahead} ahead and ${review.behind} behind the verified remote. Switching keeps its commits. `
            : '';
        confirm(
          `Review switch to ${branch}`,
          `${rewrite}${divergence}Git will stop if switching would overwrite local changes.`,
          () => switchBranch(review.token),
          'Confirm switch',
          { subject: localPath },
        );
        return;
      }
      if (result.message) throw new Error(result.message);
      const switched: CheckoutSnapshot = result.checkout;
      if (switched.branch !== branch)
        throw new Error('Git finished switching, but the new checkout status could not be verified. Review it in Repositories.');
      toast(`Switched to ${branch}.${result.notice ? ` ${result.notice}` : ''}`);
      done();
    };
    confirm(
      `Switch to ${branch}?`,
      `Switch the local checkout from ${current} to ${branch}. Git will stop if switching would overwrite local changes. You can pull afterward if an update is available.`,
      () => switchBranch(),
      'Switch branch',
      { subject: localPath },
    );
  }

  function checkShownCheckout(shown: CheckoutSnapshot | undefined, current: CheckoutSnapshot) {
    if (
      !shown ||
      shown.branch !== current.branch ||
      shown.head !== current.head ||
      shown.identity !== current.identity ||
      shown.switchIdentity !== current.switchIdentity ||
      shown.upstream !== current.upstream
    )
      throw new Error('The checkout changed. Review the current branch and try again.');
  }

  return {
    'switch-activity-branch': async () => {
      const context = getActivityCheckout();
      if (!context) return;
      const { repoId, localPath, eventId, branch, isCurrent } = context;
      await switchCheckout({ repoId, localPath, branch, isCurrent }, { operation: 'switch-activity', eventId }, () => {
        document.getElementById(`checkout-state-${repoId}`)?.focus({ preventScroll: true });
      });
    },
    'switch-checkout-branch': async element => {
      const { id: repoId = '', branch = '', path: localPath = '' } = element.dataset;
      closeBranchPicker();
      if (!repoId || !branch) return;
      const focus = () => document.getElementById(`checkout-state-${repoId}`)?.focus();
      const isCurrent = currentView();
      await switchCheckout({ repoId, localPath, branch, isCurrent }, { operation: 'switch-branch', branch }, focus);
    },
    'check-checkout': async element => {
      const id = element.dataset.id ?? '';
      const isCurrent = currentView();
      const shown = checkoutPanel.snapshots[id];
      const checkout = await checkoutPanel.read(id, true);
      if (!isCurrent()) return;
      checkShownCheckout(shown, checkout);
      if (!checkout.canCheck) throw new Error('This checkout can no longer check for updates. Review its Git status.');
      return updateCheckout(id, { operation: 'check' }, checkout);
    },
    'pull-checkout': async element => {
      const id = element.dataset.id ?? '';
      const isCurrent = currentView();
      const shown = checkoutPanel.snapshots[id];
      const checkout = await checkoutPanel.read(id, true);
      if (!isCurrent()) return;
      checkShownCheckout(shown, checkout);
      if (!checkout.canPull) throw new Error('This checkout can no longer pull. Review its Git status.');
      confirm(
        `Update ${checkout.branch}?`,
        `Pull the latest commits from ${checkout.upstream} into this local checkout. Git will only fast-forward the branch and will check that it can keep your local changes.`,
        async () => {
          if (isCurrent()) await updateCheckout(id, { operation: 'pull' }, checkout);
        },
        'Pull',
      );
    },
    'switch-checkout-target': element => branchAction(element, 'switch-update'),
    'review-checkout-branch': element => branchAction(element, 'review'),
    'remove-checkout-branch': element => branchAction(element, 'remove'),
    'carry-checkout-branch': element => branchAction(element, 'carry'),
  };
}
