import { ancestry } from './checkout-advice.ts';
import type { GitRunner } from './checkout-git.ts';
import type { Rewrite, CheckoutDiagnostic, PullAdvice } from '../src/contract.d.ts';

export type Observation = {
  identity: string;
  tracking?: string | undefined;
  lastCheck?: { branch: string; at: string; tip: string; gitDirectory: string } | undefined;
  pending?: string[];
  missing?: { head: string; advice?: PullAdvice | undefined };
  rewrite?: Rewrite | undefined;
  failure?: { title: string; suggestion: string };
};
export type Observations = {
  get: (id: string, identity: string) => Observation | undefined;
  save: (id: string, value: Observation) => void;
};

export function memoryObservations(): Observations {
  const values: Map<string, Observation> = new Map();
  return {
    get: (id, identity) => values.get(JSON.stringify([id, identity])),
    save: (id, value) => {
      values.set(JSON.stringify([id, value.identity]), value);
    },
  };
}

export async function compareUpstream(run: GitRunner, path: string, previous: string, tip: string, verified: boolean) {
  const output = await run(path, [
    'log',
    '--no-show-signature',
    '--left-right',
    '--max-count=12',
    '--format=%m%x00%h%x00%s',
    '-z',
    `${previous}...${tip}`,
    '--',
  ]).catch(() => '');
  const parts = output.split('\0');
  const commits: Rewrite['commits'] = [];
  for (let i = 0; i + 2 < parts.length && commits.length < 12; i += 3) {
    // The loop bound leaves three fields, so the defaults never apply.
    const [side, id = '', subject = ''] = parts.slice(i, i + 3);
    if ((side === '<' || side === '>') && /^[0-9a-f]{4,64}$/.test(id)) {
      commits.push({ side: side === '<' ? 'old' : 'new', id, subject: subject.slice(0, 160) });
    }
  }
  return { previous, tip, verified, commits };
}

export async function observedRewrite(run: GitRunner, path: string, baselines: string[], tip: string) {
  const pending = [];
  let rewritten: string | undefined;
  for (const previous of baselines) {
    const fastForwarded = await ancestry(run, path, previous, tip);
    if (fastForwarded === false) rewritten ??= previous;
    if (fastForwarded === null) pending.push(previous);
  }
  const previous = rewritten ?? pending[0];
  return { pending, rewrite: previous ? await compareUpstream(run, path, previous, tip, Boolean(rewritten)) : undefined };
}

export function checkoutDiagnostic(
  state: string,
  status: import('../src/contract.d.ts').GitStatus,
  observed: Observation | undefined,
  operation: string | undefined,
  rewrite: Rewrite | undefined,
): CheckoutDiagnostic | undefined {
  if (state === 'in-progress' && operation)
    return {
      title: `${operation} in progress`,
      suggestion: 'Finish or abort this operation in Git before checking for updates.',
    };
  if (state === 'fetch-failed') return observed?.failure;
  if (state === 'upstream-rewritten' && rewrite)
    return {
      title: rewrite.verified ? 'Upstream history changed' : 'Upstream ancestry could not be verified',
      suggestion: status.dirty
        ? 'Save your local changes and compare the fetched versions in Git before updating.'
        : 'Compare the fetched versions in Git before deciding how to reconcile this branch.',
      comparison: rewrite,
    };
  if (state !== 'upstream-missing') return undefined;
  const localAhead = (status.ahead ?? 0) > 0;
  const related = observed?.missing?.advice;
  const advice = related && { ...related, verified: related.verified && observed?.missing?.head === status.head };
  const message = status.upstream ? `Git could not find ${status.upstream} on the remote.` : undefined;
  if (status.dirty) return { message, advice, suggestion: 'Save your local changes in Git before switching branches.' };
  if (advice?.verified || advice?.targetVerified) {
    if (advice.destination === 'different-upstream')
      return {
        message,
        advice,
        suggestion: `Review the upstream of your local ${advice.branch} branch in Git before updating it.${advice.verified ? '' : ' Keep your local branch.'}`,
      };
    const steps = {
      local: `Switch to ${advice.branch} in Git and check for updates there.`,
      'remote-only': `Fetch and check out ${advice.branch} in Git, then check for updates there.`,
      'other-worktree': `Open the existing worktree for ${advice.branch} and check for updates there.`,
      unknown: `Check where ${advice.branch} is checked out in Git before updating it.`,
    };
    const next = advice.destination || 'unknown';
    if (advice.verified) return { message, advice, suggestion: `${steps[next]} Pull only if that checkout can fast-forward.` };
    if (next !== 'unknown') return { message, advice, suggestion: `To test the merged PR: ${steps[next]} Keep your local branch.` };
  }
  if (localAhead) return { message, advice, suggestion: 'Keep your local branch and review its commits in Git before cleaning it up.' };
  return {
    message,
    advice,
    suggestion: advice
      ? 'Keep your local branch and review the pull request before cleaning it up.'
      : 'Keep your local branch and check the tracked branch in Azure before switching.',
  };
}
