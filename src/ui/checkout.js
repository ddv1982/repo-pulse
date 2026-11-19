// @ts-check

import { checkAge, renderCheckout } from './checkout-render.js';
import { setHtml } from './dom.js';

/** @typedef {import('../../server/checkout-git.js').CheckoutStatus} CheckoutStatus */
/** @typedef {import('../../server/checkout-git.js').BlockedCheckout} BlockedCheckout */
/** @typedef {import('../../server/checkout-branches.js').Review} Review */
/** @typedef {import('../../server/checkout-branches.js').FollowupSummary} FollowupSummary */
/**
 * One repository's checkout as this page reads it. Every /api/checkouts entry fits: the server adds `followup`
 * when a branch follow-up is open, and the page keeps the `review` and `nextStep` a branch action returned.
 * @typedef {{ state: CheckoutStatus['state'], canPull?: boolean, followup?: FollowupSummary,
 *   review?: Review, nextStep?: string } & Partial<Omit<BlockedCheckout, 'state' | 'canPull'>>} CheckoutSnapshot
 */
/** @typedef {{ checkout: CheckoutSnapshot, updated?: boolean, message?: string, notice?: string,
 *   switchReview?: import('../../server/checkout-git.js').ActivitySwitchReview, review?: Review, nextStep?: string }} CheckoutUpdate */
/** @typedef {'check' | 'pull' | 'switch-activity' | 'switch-update' | 'review' | 'remove' | 'carry'} CheckoutOperation */

/** @param {{ page: HTMLElement, request: typeof import('../api.js').request, isVisible: () => boolean }} options */
export function createCheckoutPanel({ page, request, isVisible }) {
  /** @type {Record<string, CheckoutSnapshot>} */
  let snapshots = {};
  let reading = false,
    mutating = false,
    generation = 0;

  /** @param {string} id @param {CheckoutSnapshot} checkout */
  function retainLocalState(id, checkout) {
    const previous = snapshots[id];
    if (
      previous?.review &&
      previous.followup?.id === checkout.followup?.id &&
      previous.head === checkout.head &&
      previous.state === checkout.state &&
      previous.dirty === checkout.dirty
    ) {
      checkout.review = previous.review;
    }
    if (previous?.nextStep && previous.branch === checkout.branch && previous.head === checkout.head) {
      checkout.nextStep = previous.nextStep;
    }
    return checkout;
  }

  /** @param {Record<string, CheckoutSnapshot>} next */
  function publish(next) {
    const before = snapshots;
    snapshots = next;
    if (!isVisible()) return;
    for (const target of page.querySelectorAll('[data-checkout-part]')) {
      if (!(target instanceof HTMLElement)) continue;
      const { checkoutId = '', checkoutPart } = target.dataset;
      if (JSON.stringify(before[checkoutId]) === JSON.stringify(next[checkoutId])) {
        const time = target.querySelector('[data-branch-check-time]');
        if (time instanceof HTMLTimeElement) {
          const label = checkAge(time.dateTime);
          if (time.textContent !== label) time.textContent = label;
        }
        continue;
      }
      const focused = document.activeElement;
      const focusedId = focused && target.contains(focused) ? focused.id : '';
      const options = target.querySelector('.checkout-update-options');
      const updateOptionsOpen = options instanceof HTMLDetailsElement && options.open;
      setHtml(target, renderCheckout(checkoutId, next[checkoutId], checkoutPart));
      if (updateOptionsOpen) target.querySelector('.checkout-update-options')?.setAttribute('open', '');
      if (focusedId) {
        const replacement =
          document.getElementById(focusedId) ||
          (target.hidden || !target.textContent.trim() ? target.closest('article')?.querySelector('[data-checkout-part=status]') : target);
        if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      }
    }
  }

  return {
    get snapshots() {
      return snapshots;
    },
    /** @param {string} id @returns {Promise<CheckoutSnapshot>} */
    async read(id) {
      const issued = generation;
      const checkout = await request(`/api/repos/${encodeURIComponent(id)}/checkout/status`);
      if (!mutating && issued === generation) publish({ ...snapshots, [id]: retainLocalState(id, checkout) });
      return checkout;
    },
    async refresh() {
      if (!isVisible() || reading || mutating) return;
      const issued = generation;
      reading = true;
      try {
        /** @type {Record<string, CheckoutSnapshot>} */
        const next = await request('/api/checkouts');
        if (!mutating && issued === generation) {
          for (const [id, checkout] of Object.entries(next)) retainLocalState(id, checkout);
          publish(next);
        }
      } catch {
        if (!mutating && issued === generation)
          publish(
            Object.fromEntries(
              [...page.querySelectorAll('[data-checkout-part="status"]')]
                .filter(element => element instanceof HTMLElement)
                .map(element => [element.dataset.checkoutId ?? '', { state: /** @type {const} */ ('unavailable') }]),
            ),
          );
      } finally {
        reading = false;
      }
    },
    /**
     * @param {string} id @param {CheckoutOperation} operation
     * @param {Pick<CheckoutSnapshot, 'branch' | 'head' | 'upstream' | 'identity' | 'switchIdentity'>} expected @param {Record<string, unknown>} [options]
     * @returns {Promise<CheckoutUpdate>}
     */
    async update(id, operation, expected, options = {}) {
      mutating = true;
      generation++;
      try {
        /** @type {CheckoutUpdate} */
        const result = await request(`/api/repos/${encodeURIComponent(id)}/checkout`, {
          method: 'POST',
          body: { ...options, operation, expected },
        });
        publish({
          ...snapshots,
          [id]: {
            ...result.checkout,
            review: result.review ?? (result.nextStep ? snapshots[id]?.review : undefined),
            nextStep: result.nextStep,
          },
        });
        return result;
      } finally {
        mutating = false;
      }
    },
  };
}
