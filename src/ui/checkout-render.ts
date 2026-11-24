import { azureLink, emptyHtml, html, joinHtml } from './format.ts';

export type CheckoutSnapshot = import('./checkout.ts').CheckoutSnapshot;
export type CheckoutDiagnostic = import('../contract.ts').CheckoutDiagnostic;

const statusLabels: Record<string, string | undefined> = {
  'not-linked': 'No local checkout linked',
  unavailable: 'Checkout unavailable',
  detached: 'Detached HEAD',
  unborn: 'No local commits',
  dirty: 'Local changes',
  'no-upstream': 'No tracked branch',
  'different-remote': 'Upstream differs from watched repo',
  'upstream-missing': 'Upstream branch not found',
  'upstream-rewritten': 'Upstream history changed',
  'fetch-failed': 'Check failed',
  'in-progress': 'Git operation in progress',
  current: 'Matches last fetched upstream',
  diverged: 'Branches diverged',
};
const attention: Set<string | undefined> = new Set(['diverged', 'unavailable', 'in-progress', 'different-remote', 'upstream-rewritten']);
const errors: Set<string | undefined> = new Set(['upstream-missing', 'fetch-failed']);
const exactCheckTime = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'medium' });
const relativeCheckTime = new Intl.RelativeTimeFormat([], { numeric: 'always' });
/** States whose ahead and behind counts compare the branch with its upstream. */
const comparableStates: Set<string | undefined> = new Set(['current', 'behind', 'ahead', 'diverged', 'dirty']);

export function checkAge(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  if (minutes === 0) return 'Checked just now';
  const [count, unit]: [number, Intl.RelativeTimeFormatUnit] =
    minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return `Checked ${relativeCheckTime.format(-count, unit)}`;
}

function uncheckedStatus(checkout: CheckoutSnapshot, countsKnown: boolean) {
  const { ahead, behind, lastBranchCheck } = checkout;
  if (lastBranchCheck && !lastBranchCheck.matchesFetchedTip) return 'Remote changed since last check';
  if (checkout.state === 'behind') return `${behind} behind last fetch`;
  if (checkout.state === 'ahead') return `${ahead} ahead of last fetch`;
  if (checkout.state === 'diverged') return 'Diverged from last fetch';
  return checkout.canCheck && countsKnown ? 'Not checked yet' : '';
}

function branchStatus(checkout: CheckoutSnapshot | undefined) {
  if (checkout?.diagnostic?.title) return checkout.diagnostic.title;
  if (checkout?.state === 'upstream-missing' || checkout?.state === 'fetch-failed') return statusLabels[checkout.state];
  const comparable = checkout !== undefined && comparableStates.has(checkout.state);
  if (!comparable) return checkout?.state === 'unknown' ? '' : statusLabels[checkout?.state ?? ''] || 'Reading local checkout…';
  const { ahead, behind, lastBranchCheck } = checkout;
  const countsKnown = Number.isInteger(ahead) && Number.isInteger(behind);
  const checked = lastBranchCheck?.matchesFetchedTip && countsKnown;
  if (!checked) return uncheckedStatus(checkout, countsKnown);
  if (ahead && behind) return 'Branches diverged';
  if (behind) return `${behind} ${behind === 1 ? 'commit' : 'commits'} behind`;
  if (ahead) return `${ahead} ${ahead === 1 ? 'commit' : 'commits'} ahead`;
  return 'Up to date';
}

const strategyNames: Record<string, string | undefined> = {
  rebase: ' via rebase',
  rebaseMerge: ' via rebase and merge',
  squash: ' via squash',
};

function diagnosticMarkup(id: string, diagnostic: CheckoutDiagnostic | undefined, canSwitch: unknown) {
  if (!diagnostic) return emptyHtml;
  const { message, suggestion, advice, comparison } = diagnostic;
  const adviceLink = advice ? azureLink(advice.url, `PR #${advice.id}`) : emptyHtml;
  return html`<div class="checkout-diagnostic help">
    <div>
    ${message && !canSwitch ? html`<p>${message}</p>` : emptyHtml}
    ${
      advice
        ? html`<p>${adviceLink.toString() ? adviceLink : `PR #${advice.id}`} was completed into
      <code>${advice.branch}</code>${strategyNames[String(advice.strategy ?? '')] || ''}.
      ${
        canSwitch && !advice.verified
          ? 'You can review your local commits after switching.'
          : !advice.targetVerified
            ? 'Git could not verify the PR result on the target.'
            : ''
      }</p>`
        : emptyHtml
    }
    ${!canSwitch ? html`<p>${suggestion}</p>` : emptyHtml}
    ${
      comparison
        ? html`<details data-group="checkout-compare-${id}">
      <summary id="checkout-compare-${id}">Compare fetched history</summary>
      <p>Previous <code title="${comparison.previous}">${comparison.previous.slice(0, 12)}</code> ·
        New <code title="${comparison.tip}">${comparison.tip.slice(0, 12)}</code></p>
      ${
        comparison.commits.length
          ? html`<ul>${comparison.commits.map(
              commit => html`<li>${commit.side === 'old' ? 'Previous only' : 'New only'} ·
        <code>${commit.id}</code> ${commit.subject}</li>`,
            )}</ul>`
          : html`<p>Inspect the two revisions in Git to see their changes.</p>`
      }
    </details>`
        : emptyHtml
    }
    </div>
    ${
      canSwitch && advice
        ? html`<button type="button" class="btn primary sm" id="checkout-switch-${id}"
      data-action="switch-checkout-target" data-id="${id}">Switch to ${advice.branch} and update</button>`
        : emptyHtml
    }
  </div>`;
}

const reviewMessages = {
  included: 'The old branch matches the PR source or its commit is in this checkout.',
  'local-followup': 'The old branch has commits after the recorded PR source.',
  unknown: 'Git could not verify whether all of the old branch’s changes are included.',
  changed: 'The old branch changed since you switched. Review it in Git.',
  occupied: 'The old branch is checked out in another worktree.',
};

function reviewMarkup(id: string, checkout: CheckoutSnapshot) {
  const { followup, review } = checkout;
  if (!followup) return emptyHtml;
  const action = (
    name: 'review' | 'carry' | 'remove',
    label: string,
  ) => html`<button class="btn sm" type="button" id="checkout-${name}-${id}"
    data-action="${name}-checkout-branch" data-id="${id}">${label}</button>`;
  const workspace = followup.workspace
    ? html`<p class="checkout-diagnostic help">Follow-up worktree <code>${followup.workspace}</code></p>`
    : emptyHtml;
  if (!review) return html`${workspace}${action('review', 'Review old branch')}`;
  return html`${workspace}<div class="checkout-diagnostic help" data-checkout-review>
    <p><code>${followup.source}</code> · ${reviewMessages[review.kind]}</p>
    ${
      review.commits?.length && checkout.state === 'current' && !followup.workspace
        ? html`<fieldset class="checkout-commits">
      <legend>Commits to carry onto a new branch</legend>
      ${review.commits.map(
        commit => html`<label><input type="checkbox" name="checkout-commit" value="${commit.id}">
        <code>${commit.id.slice(0, 8)}</code> ${commit.subject}</label>`,
      )}
      ${action('carry', 'Carry selected commits')}
    </fieldset>`
        : emptyHtml
    }
    ${review.canRemove ? action('remove', 'Remove old local branch…') : emptyHtml}
  </div>`;
}

function updateOptions(id: string, checkout: CheckoutSnapshot | undefined) {
  if (!checkout?.canPull || !checkout.dirty) return emptyHtml;
  return html`<details class="checkout-update-options help" data-group="checkout-update-${id}">
    <summary id="checkout-update-${id}" aria-label="Update options" aria-describedby="checkout-update-reason-${id}">
      <span id="checkout-update-reason-${id}">Git will check that Pull can keep your local changes.</span>
      <span class="btn sm" aria-hidden="true">Update options</span>
    </summary>
    <p>Try Pull first. If Git reports overlapping changes, stash your edits or save them on a separate branch, then try Pull again. If you used a stash, reapply it after pulling.</p>
  </details>`;
}

function lastCheckMarkup(checkout: CheckoutSnapshot | undefined) {
  const at = checkout?.lastBranchCheck?.at;
  return at ? html`Last successful Git check <time datetime="${at}">${exactCheckTime.format(new Date(at))}</time>` : emptyHtml;
}

function guidanceMarkup(id: string, checkout: CheckoutSnapshot | undefined) {
  return joinHtml([
    updateOptions(id, checkout),
    diagnosticMarkup(
      id,
      checkout?.diagnostic,
      checkout?.state === 'upstream-missing' &&
        !checkout.dirty &&
        checkout.diagnostic?.advice?.destination === 'local' &&
        checkout.diagnostic.advice.receipt,
    ),
    checkout ? reviewMarkup(id, checkout) : emptyHtml,
    checkout?.nextStep ? html`<p class="help" role="status">${checkout.nextStep}</p>` : emptyHtml,
  ]);
}

function statusTone(state: string | undefined, label: string | undefined) {
  if (errors.has(state)) return 'crit';
  if (attention.has(state)) return 'warn';
  if (label === 'Up to date') return 'ok';
  return state === 'behind' ? 'info' : 'neutral';
}

function checkTimeMarkup(checkout: CheckoutSnapshot | undefined) {
  const last = checkout?.lastBranchCheck;
  const showTime =
    last?.matchesFetchedTip &&
    Number.isInteger(checkout?.ahead) &&
    Number.isInteger(checkout?.behind) &&
    comparableStates.has(checkout?.state);
  return showTime
    ? html`<time class="help" datetime="${last.at}" data-branch-check-time title="${exactCheckTime.format(new Date(last.at))}">${checkAge(last.at)}</time>`
    : emptyHtml;
}

/** A switch needs a named branch and a verified Git directory, and no Git operation in progress. */
const canSwitch = (checkout: CheckoutSnapshot | undefined) =>
  Boolean(checkout?.branch && checkout.head && checkout.identity && checkout.switchIdentity && checkout.state !== 'in-progress');

function statusMarkup(id: string, checkout: CheckoutSnapshot | undefined) {
  const branch = checkout?.branch || (checkout?.state === 'detached' ? checkout.head?.slice(0, 8) : '');
  const label = branchStatus(checkout);
  const tone = statusTone(checkout?.state, label);
  return html`<div class="checkout-state">${branch ? html`<code class="subref" title="${branch}">${branch}</code>` : emptyHtml}
    ${label ? html`<span class="chip status-chip ${tone}">${label}</span>` : emptyHtml}
    ${checkout?.dirty ? html`<span class="chip status-chip neutral">Local changes</span>` : emptyHtml}
    ${checkTimeMarkup(checkout)}
    </div>
    ${checkout?.canCheck ? html`<button type="button" class="ghost sm" id="checkout-check-${id}" data-action="check-checkout" data-id="${id}" title="Fetch ${checkout.upstream} and compare it with your current branch">Check for updates</button>` : emptyHtml}
    ${checkout?.canPull ? html`<button type="button" class="btn primary sm" id="checkout-pull-${id}" data-action="pull-checkout" data-id="${id}">Pull</button>` : emptyHtml}
    ${canSwitch(checkout) ? html`<button type="button" class="ghost sm" id="checkout-switch-${id}" data-action="open-branch-picker" data-id="${id}">Switch branch…</button>` : emptyHtml}`;
}

export function renderCheckout(id: string, checkout: CheckoutSnapshot | undefined, part: string | undefined) {
  if (part === 'last-check') return lastCheckMarkup(checkout);
  if (part === 'guidance') return guidanceMarkup(id, checkout);
  return statusMarkup(id, checkout);
}
