import { checkAge, renderCheckout } from './checkout-render.ts';
import { setHtml } from './dom.ts';
import type {
  CheckoutStatus,
  BlockedCheckout,
  CheckoutOperation,
  CheckoutRequest,
  CheckoutUpdateResponse,
  Review,
  FollowupSummary,
} from '../contract.ts';

/**
 * One repository's checkout as this page reads it. Every /api/checkouts entry fits: the server adds `followup`
 * when a branch follow-up is open, and the page keeps the `review` and `nextStep` a branch action returned, and the
 * review commits a person ticked (`carry`).
 */
export type CheckoutSnapshot = {
  state: CheckoutStatus['state'];
  canPull?: boolean;
  followup?: FollowupSummary;
  review?: Review | undefined;
  carry?: string[] | undefined;
  nextStep?: string | undefined;
} & Partial<Omit<BlockedCheckout, 'state' | 'canPull'>>;
/** The answer to a checkout command, narrowed to the operation the command names. */
export type CheckoutAnswer<O extends CheckoutOperation> = CheckoutUpdateResponse extends infer R
  ? R extends { operation: infer P }
    ? O extends P
      ? R
      : never
    : never
  : never;

/** The review and next step a branch follow-up action answered with; the other operations answer neither. */
function branchOutcome(result: CheckoutUpdateResponse) {
  switch (result.operation) {
    case 'switch-update':
    case 'review':
    case 'remove':
    case 'carry':
      return { review: result.review, nextStep: result.nextStep };
    default:
      return { review: undefined, nextStep: undefined };
  }
}

export function createCheckoutPanel({
  page,
  request,
  isVisible,
  onChange,
  onMutation,
  groups,
}: {
  page: HTMLElement;
  /** Which disclosures the reader opened, such as Update options. */
  groups: import('./groups.ts').Groups;
  request: typeof import('../api.ts').request;
  isVisible: () => boolean;
  onChange: (before: Record<string, CheckoutSnapshot>) => void;
  onMutation: (id: string) => void;
}) {
  let snapshots: Record<string, CheckoutSnapshot> = {};
  const singleReads = new Map<string, symbol>();
  let reading = false,
    mutating = false,
    generation = 0,
    refreshGeneration = 0;

  function retainLocalState(id: string, checkout: CheckoutSnapshot) {
    const previous = snapshots[id];
    if (
      previous?.review &&
      previous.followup?.id === checkout.followup?.id &&
      previous.head === checkout.head &&
      previous.state === checkout.state &&
      previous.dirty === checkout.dirty
    ) {
      checkout.review = previous.review;
      checkout.carry = previous.carry;
    }
    if (previous?.nextStep && previous.branch === checkout.branch && previous.head === checkout.head) {
      checkout.nextStep = previous.nextStep;
    }
    return checkout;
  }

  function publish(next: Record<string, CheckoutSnapshot>) {
    const before = snapshots;
    snapshots = next;
    onChange(before);
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
      setHtml(target, renderCheckout(checkoutId, next[checkoutId], checkoutPart, groups));
      if (focusedId) {
        const replacement =
          document.getElementById(focusedId) ||
          (target.hidden || !target.textContent.trim() ? target.closest('article')?.querySelector('[data-checkout-part=status]') : target);
        if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      }
    }
  }

  // Ticked review commits live on the snapshot, so a render after a poll keeps them.
  page.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'checkout-commit') return;
    const checkout = snapshots[input.dataset.id ?? ''];
    if (!checkout?.review) return;
    const carry = new Set(checkout.carry);
    if (input.checked) carry.add(input.value);
    else carry.delete(input.value);
    checkout.carry = [...carry];
  });

  return {
    get snapshots() {
      return snapshots;
    },
    async read(id: string, fresh = false): Promise<CheckoutSnapshot> {
      const issued = generation;
      refreshGeneration++;
      const read = Symbol(id);
      singleReads.set(id, read);
      const checkout = await request('GET /api/repos/:id/checkout/status', {
        params: { id },
        query: { fresh: fresh ? '1' : undefined },
      }).catch(() => ({ state: 'unavailable' as const }));
      if (singleReads.get(id) === read) {
        singleReads.delete(id);
        if (!mutating && issued === generation) publish({ ...snapshots, [id]: retainLocalState(id, checkout) });
      }
      return checkout;
    },
    async refresh() {
      if (!isVisible() || reading || mutating) return;
      const issued = generation;
      const issuedRefresh = refreshGeneration;
      const current = () => isVisible() && !mutating && issued === generation && issuedRefresh === refreshGeneration;
      reading = true;
      try {
        const next: Record<string, CheckoutSnapshot> = await request('GET /api/checkouts');
        if (current()) {
          for (const [id, checkout] of Object.entries(next)) retainLocalState(id, checkout);
          publish(next);
        }
      } catch {
        if (current())
          publish(
            Object.fromEntries(
              [...page.querySelectorAll('[data-checkout-part="status"]')]
                .filter(element => element instanceof HTMLElement)
                .map(element => [element.dataset.checkoutId ?? '', { state: 'unavailable' as const }]),
            ),
          );
      } finally {
        reading = false;
      }
    },
    /** Runs one command. `expected` is sent as JSON, which leaves out a field holding undefined. */
    async update<C extends CheckoutRequest>(id: string, command: C): Promise<CheckoutAnswer<C['operation']>> {
      mutating = true;
      generation++;
      try {
        // The route answers with the operation the command named, so the answer narrows to it.
        const result = (await request('POST /api/repos/:id/checkout', { params: { id }, body: command })) as CheckoutAnswer<C['operation']>;
        const { review, nextStep } = branchOutcome(result);
        publish({ ...snapshots, [id]: { ...result.checkout, review: review ?? (nextStep ? snapshots[id]?.review : undefined), nextStep } });
        return result;
      } finally {
        generation++;
        mutating = false;
        if (command.operation !== 'review') onMutation(id);
      }
    },
  };
}
