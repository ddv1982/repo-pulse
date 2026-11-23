import { azureDevOpsService } from '../src/activity-text.ts';

export function foldSearchText(text: string) {
  const lower = text.toLowerCase();
  if (!/\P{ASCII}/u.test(lower)) return lower;
  return lower.replace(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu, span =>
    span.normalize('NFD').replace(/[\p{M}&&\p{Diacritic}&&[\p{Script_Extensions=Latin}\p{Script=Inherited}]]+/gv, ''),
  );
}

export function parsePeople(value: string) {
  const names = [
    ...new Set(
      value
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  if (value.length > 300 || names.length > 12) {
    throw Object.assign(new Error('Enter up to 12 names and 300 characters in People.'), { code: 'BAD_REQUEST' });
  }
  return names;
}

function matchesName(name: string, term: string) {
  if (name.includes(term)) return true;
  if (!/\s/u.test(term)) return false;
  const wordPattern = /[\p{L}\p{M}\p{N}]+/gu;
  const parts = term.match(wordPattern);
  if (!parts || parts.length < 2) return false;
  const words = name.match(wordPattern) || [];
  let previous = -1;
  return parts.every(part => {
    previous = words.findIndex((word, index) => index > previous && word.startsWith(part));
    return previous !== -1;
  });
}

export function matchesPeople({ kind, actor, data }: import('../src/activity.ts').ActivityEvent, terms: string[]) {
  const names = [actor];
  if (kind === 'pr') names.push(data?.closedBy, ...(data?.voteChanges || []).map(change => change.name));
  if (kind === 'push') {
    for (const pr of data?.mergeEvidence?.prs || []) {
      names.push(typeof pr.closedBy === 'string' ? pr.closedBy : pr.closedBy?.displayName);
    }
  }
  return names.some(name => {
    if (typeof name !== 'string' || name === azureDevOpsService) return false;
    const normalized = name.trim().toLowerCase();
    if (!normalized || normalized === 'unknown' || normalized === 'unknown reviewer') return false;
    if (terms.some(term => normalized.includes(term))) return true;
    const folded = foldSearchText(normalized);
    return terms.some(term => matchesName(folded, foldSearchText(term)));
  });
}
