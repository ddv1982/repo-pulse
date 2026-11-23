import { repositoryHref } from './navigation.ts';

export type CheckoutSnapshot = import('./checkout.ts').CheckoutSnapshot;
export type CheckoutOperation = import('./checkout.ts').CheckoutOperation;
export type Action = (element: HTMLElement) => Promise<void> | void;
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
}): Record<string, Action> {
  async function updateCheckout(id: string, operation: CheckoutOperation, checkout: CheckoutSnapshot, options?: Record<string, unknown>) {
    const { branch, head, upstream, identity } = checkout;
    try {
      const result = await checkoutPanel.update(id, operation, { branch, head, upstream, identity }, options);
      if (result.message) return toast(result.message);
      if (result.review) return;
      if (result.checkout.diagnostic && !result.updated) return;
      if (operation === 'check') {
        const { ahead, behind, lastBranchCheck } = result.checkout;
        const upToDate = lastBranchCheck?.matchesFetchedTip && ahead === 0 && behind === 0;
        return toast(upToDate ? `${branch} is up to date.` : `Checked ${branch} for updates.`);
      }
      toast(result.updated ? `Updated ${branch}.` : 'The checkout is already at the fetched upstream.');
    } catch (error) {
      void checkoutPanel.refresh();
      throw error;
    }
  }

  function branchAction(
    element: HTMLElement,
    operation: Exclude<CheckoutOperation, 'check' | 'pull' | 'switch-activity' | 'switch-branch'>,
  ) {
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
        () => updateCheckout(id, operation, checkout, { prId: advice.id, result: receipt.result }),
        'Switch and update',
      );
    }
    const followup = checkout.followup;
    if (!followup) return;
    const options: { planId: string; commits?: string[] } = { planId: followup.id };
    const perform = () => updateCheckout(id, operation, checkout, options);
    if (operation === 'remove') {
      return confirm(
        'Remove local branch?',
        'Repo Pulse keeps a local Git reference to the branch’s last commit before deleting the branch.',
        perform,
        'Remove local branch',
        { subject: followup.source, destructive: true },
      );
    }
    if (operation === 'carry') {
      const reviewPanel = element.closest('[data-checkout-review]');
      if (!reviewPanel) throw new Error('Repo Pulse: missing required element [data-checkout-review]');
      options.commits = [...reviewPanel.querySelectorAll('input:checked')]
        .filter(input => input instanceof HTMLInputElement)
        .map(input => input.value);
      if (!options.commits.length) return toast('Select at least one commit to carry.');
      return confirm(
        `Apply selected commits to ${checkout.review?.branch}?`,
        'Git will apply your selection on a new local branch in its original order, then switch to it. If Git stops, the follow-up stays in a separate worktree.',
        perform,
        'Create branch and apply',
      );
    }
    return perform();
  }

  /**
   * Confirms and runs a branch switch, with a second review when the branch's remote history was rewritten or has
   * diverged from the local branch. Activity and Repositories share it so both ask the same questions.
   * @param done runs after a verified switch, and when the checkout is already on the branch
   */
  async function switchCheckout(
    { repoId, localPath, branch, isCurrent }: { repoId: string; localPath: string; branch: string; isCurrent: () => boolean },
    operation: 'switch-activity' | 'switch-branch',
    request: Record<string, unknown>,
    done: () => void,
  ) {
    const checkout = await checkoutPanel.read(repoId);
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
      const result = await checkoutPanel.update(
        repoId,
        operation,
        { branch: current, head, upstream, identity, switchIdentity },
        { ...request, confirmation },
      );
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
      if (result.checkout.branch !== branch)
        throw new Error('Git finished switching, but the new checkout status could not be verified. Review it in Repositories.');
      toast(`Switched to ${branch}.${result.notice ? ` ${result.notice}` : ''}`);
      done();
    };
    confirm(
      `Switch to ${branch}?`,
      `Switch the local checkout from ${current} to ${branch}. Git will stop if switching would overwrite local changes. You can check for updates or pull from Repositories afterward.`,
      () => switchBranch(),
      'Switch branch',
      { subject: localPath },
    );
  }

  return {
    'switch-activity-branch': async () => {
      const context = getActivityCheckout();
      if (!context) return;
      const { repoId, localPath, eventId, branch, isCurrent } = context;
      await switchCheckout({ repoId, localPath, branch, isCurrent }, 'switch-activity', { eventId }, () => {
        location.hash = repositoryHref(repoId);
      });
    },
    'switch-checkout-branch': async element => {
      const { id: repoId = '', branch = '', path: localPath = '' } = element.dataset;
      closeBranchPicker();
      if (!repoId || !branch) return;
      const focus = () => document.getElementById(`checkout-state-${repoId}`)?.focus();
      const isCurrent = currentView();
      await switchCheckout({ repoId, localPath, branch, isCurrent }, 'switch-branch', { branch }, focus);
    },
    'check-checkout': element => {
      const id = element.dataset.id ?? '';
      const checkout = checkoutPanel.snapshots[id];
      if (checkout?.canCheck) return updateCheckout(id, 'check', checkout);
    },
    'pull-checkout': element => {
      const id = element.dataset.id ?? '';
      const checkout = checkoutPanel.snapshots[id];
      if (!checkout?.canPull) return;
      confirm(
        `Update ${checkout.branch}?`,
        `Pull the latest commits from ${checkout.upstream} into this local checkout. Git will only fast-forward the branch and will check that it can keep your local changes.`,
        () => updateCheckout(id, 'pull', checkout),
        'Pull',
      );
    },
    'switch-checkout-target': element => branchAction(element, 'switch-update'),
    'review-checkout-branch': element => branchAction(element, 'review'),
    'remove-checkout-branch': element => branchAction(element, 'remove'),
    'carry-checkout-branch': element => branchAction(element, 'carry'),
  };
}
