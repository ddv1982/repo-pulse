// @ts-check

import { azureLink, escape as e } from './format.js';

/** @typedef {import('./checkout.js').CheckoutSnapshot} CheckoutSnapshot */
/** @typedef {import('../../server/checkout-observations.js').CheckoutDiagnostic} CheckoutDiagnostic */

/** @type {Record<string, string | undefined>} */
const statusLabels = {
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
/** @type {Set<string | undefined>} */
const attention = new Set(['diverged', 'unavailable', 'in-progress', 'different-remote', 'upstream-rewritten']);
/** @type {Set<string | undefined>} */
const errors = new Set(['upstream-missing', 'fetch-failed']);
const exactCheckTime = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'medium' });
const relativeCheckTime = new Intl.RelativeTimeFormat([], { numeric: 'always' });
/** States whose ahead and behind counts compare the branch with its upstream. @type {Set<string | undefined>} */
const comparableStates = new Set(['current', 'behind', 'ahead', 'diverged', 'dirty']);

/** @param {string} at */
export function checkAge(at) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  if (minutes === 0) return 'Checked just now';
  /** @type {[number, Intl.RelativeTimeFormatUnit]} */
  const [count, unit] =
    minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return `Checked ${relativeCheckTime.format(-count, unit)}`;
}

/** @param {CheckoutSnapshot} checkout @param {boolean} countsKnown */
function uncheckedStatus(checkout, countsKnown) {
  const { ahead, behind, lastBranchCheck } = checkout;
  if (lastBranchCheck && !lastBranchCheck.matchesFetchedTip) return 'Remote changed since last check';
  if (checkout.state === 'behind') return `${behind} behind last fetch`;
  if (checkout.state === 'ahead') return `${ahead} ahead of last fetch`;
  if (checkout.state === 'diverged') return 'Diverged from last fetch';
  return checkout.canCheck && countsKnown ? 'Not checked yet' : '';
}

/** @param {CheckoutSnapshot | undefined} checkout */
function branchStatus(checkout) {
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

/** @type {Record<string, string | undefined>} */
const strategyNames = { rebase: ' via rebase', rebaseMerge: ' via rebase and merge', squash: ' via squash' };

/** @param {string} id @param {CheckoutDiagnostic | undefined} diagnostic @param {unknown} canSwitch */
function diagnosticMarkup(id, diagnostic, canSwitch) {
  if (!diagnostic) return '';
  const { message, suggestion, advice, comparison } = diagnostic;
  return `<div class="checkout-diagnostic help">
    <div>
    ${message && !canSwitch ? `<p>${e(message)}</p>` : ''}
    ${
      advice
        ? `<p>${azureLink(advice.url, `PR #${advice.id}`) || `PR #${e(advice.id)}`} was completed into
      <code>${e(advice.branch)}</code>${e(strategyNames[advice.strategy ?? ''] || '')}.
      ${
        canSwitch && !advice.verified
          ? 'You can review your local commits after switching.'
          : !advice.targetVerified
            ? 'Git could not verify the PR result on the target.'
            : ''
      }</p>`
        : ''
    }
    ${!canSwitch ? `<p>${e(suggestion)}</p>` : ''}
    ${
      comparison
        ? `<details data-group="checkout-compare-${e(id)}">
      <summary id="checkout-compare-${e(id)}">Compare fetched history</summary>
      <p>Previous <code title="${e(comparison.previous)}">${e(comparison.previous.slice(0, 12))}</code> ·
        New <code title="${e(comparison.tip)}">${e(comparison.tip.slice(0, 12))}</code></p>
      ${
        comparison.commits.length
          ? `<ul>${comparison.commits
              .map(
                commit => `<li>${commit.side === 'old' ? 'Previous only' : 'New only'} ·
        <code>${e(commit.id)}</code> ${e(commit.subject)}</li>`,
              )
              .join('')}</ul>`
          : '<p>Inspect the two revisions in Git to see their changes.</p>'
      }
    </details>`
        : ''
    }
    </div>
    ${
      canSwitch && advice
        ? `<button type="button" class="btn primary sm" id="checkout-switch-${e(id)}"
      data-action="switch-checkout-target" data-id="${e(id)}">Switch to ${e(advice.branch)} and update</button>`
        : ''
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

/** @param {string} id @param {CheckoutSnapshot} checkout */
function reviewMarkup(id, checkout) {
  const { followup, review } = checkout;
  if (!followup) return '';
  /** @param {'review' | 'carry' | 'remove'} name @param {string} label */
  const action = (name, label) => `<button class="btn sm" type="button" id="checkout-${name}-${e(id)}"
    data-action="${name}-checkout-branch" data-id="${e(id)}">${label}</button>`;
  const workspace = followup.workspace
    ? `<p class="checkout-diagnostic help">Follow-up worktree <code>${e(followup.workspace)}</code></p>`
    : '';
  if (!review) return workspace + action('review', 'Review old branch');
  return (
    workspace +
    `<div class="checkout-diagnostic help" data-checkout-review>
    <p><code>${e(followup.source)}</code> · ${e(reviewMessages[review.kind])}</p>
    ${
      review.commits?.length && checkout.state === 'current' && !followup.workspace
        ? `<fieldset class="checkout-commits">
      <legend>Commits to carry onto a new branch</legend>
      ${review.commits
        .map(
          commit => `<label><input type="checkbox" name="checkout-commit" value="${e(commit.id)}">
        <code>${e(commit.id.slice(0, 8))}</code> ${e(commit.subject)}</label>`,
        )
        .join('')}
      ${action('carry', 'Carry selected commits')}
    </fieldset>`
        : ''
    }
    ${review.canRemove ? action('remove', 'Remove old local branch…') : ''}
  </div>`
  );
}

/** @param {string} id @param {CheckoutSnapshot | undefined} checkout */
function updateOptions(id, checkout) {
  if (!checkout?.canPull || !checkout.dirty) return '';
  return `<details class="checkout-update-options help" data-group="checkout-update-${e(id)}">
    <summary id="checkout-update-${e(id)}" aria-label="Update options" aria-describedby="checkout-update-reason-${e(id)}">
      <span id="checkout-update-reason-${e(id)}">Git will check that Pull can keep your local changes.</span>
      <span class="btn sm" aria-hidden="true">Update options</span>
    </summary>
    <p>Try Pull first. If Git reports overlapping changes, stash your edits or save them on a separate branch, then try Pull again. If you used a stash, reapply it after pulling.</p>
  </details>`;
}

/** @param {CheckoutSnapshot | undefined} checkout */
function lastCheckMarkup(checkout) {
  const at = checkout?.lastBranchCheck?.at;
  return at ? `Last successful Git check <time datetime="${e(at)}">${e(exactCheckTime.format(new Date(at)))}</time>` : '';
}

/** @param {string} id @param {CheckoutSnapshot | undefined} checkout */
function guidanceMarkup(id, checkout) {
  return [
    updateOptions(id, checkout),
    diagnosticMarkup(
      id,
      checkout?.diagnostic,
      checkout?.state === 'upstream-missing' &&
        !checkout.dirty &&
        checkout.diagnostic?.advice?.destination === 'local' &&
        checkout.diagnostic.advice.receipt,
    ),
    checkout ? reviewMarkup(id, checkout) : '',
    checkout?.nextStep ? `<p class="help" role="status">${e(checkout.nextStep)}</p>` : '',
  ].join('');
}

/** @param {string | undefined} state @param {string | undefined} label */
function statusTone(state, label) {
  if (errors.has(state)) return 'crit';
  if (attention.has(state)) return 'warn';
  if (label === 'Up to date') return 'ok';
  return state === 'behind' ? 'info' : 'neutral';
}

/** @param {CheckoutSnapshot | undefined} checkout */
function checkTimeMarkup(checkout) {
  const last = checkout?.lastBranchCheck;
  const showTime =
    last?.matchesFetchedTip &&
    Number.isInteger(checkout?.ahead) &&
    Number.isInteger(checkout?.behind) &&
    comparableStates.has(checkout?.state);
  return showTime
    ? `<time class="help" datetime="${e(last.at)}" data-branch-check-time title="${e(exactCheckTime.format(new Date(last.at)))}">${e(checkAge(last.at))}</time>`
    : '';
}

/** @param {string} id @param {CheckoutSnapshot | undefined} checkout */
function statusMarkup(id, checkout) {
  const branch = checkout?.branch || (checkout?.state === 'detached' ? checkout.head?.slice(0, 8) : '');
  const label = branchStatus(checkout);
  const tone = statusTone(checkout?.state, label);
  return `<div class="checkout-state">${branch ? `<code class="subref" title="${e(branch)}">${e(branch)}</code>` : ''}
    ${label ? `<span class="chip status-chip ${tone}">${e(label)}</span>` : ''}
    ${checkout?.dirty ? '<span class="chip status-chip neutral">Local changes</span>' : ''}
    ${checkTimeMarkup(checkout)}
    </div>
    ${checkout?.canCheck ? `<button type="button" class="ghost sm" id="checkout-check-${e(id)}" data-action="check-checkout" data-id="${e(id)}" title="Fetch ${e(checkout.upstream)} and compare it with your current branch">Check for updates</button>` : ''}
    ${checkout?.canPull ? `<button type="button" class="btn primary sm" id="checkout-pull-${e(id)}" data-action="pull-checkout" data-id="${e(id)}">Pull</button>` : ''}`;
}

/** @param {string} id @param {CheckoutSnapshot | undefined} checkout @param {string | undefined} part */
export function renderCheckout(id, checkout, part) {
  if (part === 'last-check') return lastCheckMarkup(checkout);
  if (part === 'guidance') return guidanceMarkup(id, checkout);
  return statusMarkup(id, checkout);
}
