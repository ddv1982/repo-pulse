// @ts-check

/** @typedef {import('./checkout.js').CheckoutSnapshot} CheckoutSnapshot */
/** @typedef {import('./checkout.js').CheckoutOperation} CheckoutOperation */
/** @typedef {(element: HTMLElement) => Promise<void> | void} Action */

/**
 * @param {{
 *   checkoutPanel: ReturnType<typeof import('./checkout.js').createCheckoutPanel>,
 *   confirm: (title: string, description: string, callback: () => Promise<void>, label?: string, options?: { subject?: string, destructive?: boolean }) => void,
 *   toast: (message: string) => void,
 * }} options
 * @returns {Record<string, Action>}
 */
export function createCheckoutActions({ checkoutPanel, confirm, toast }) {
  /** @param {string} id @param {CheckoutOperation} operation @param {CheckoutSnapshot} checkout @param {Record<string, unknown>} [options] */
  async function updateCheckout(id, operation, checkout, options) {
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

  /** @param {HTMLElement} element @param {Exclude<CheckoutOperation, 'check' | 'pull'>} operation */
  function branchAction(element, operation) {
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
    /** @type {{ planId: string, commits?: string[] }} */
    const options = { planId: followup.id };
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

  return {
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
