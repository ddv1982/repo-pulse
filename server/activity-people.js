// @ts-check

import { azureDevOpsService } from '../src/activity-text.js';

/** @param {string} value */
export function parsePeople(value) {
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

/** @param {import('../src/activity.js').ActivityEvent} event @param {string[]} terms */
export function matchesPeople({ kind, actor, data }, terms) {
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
    return normalized && normalized !== 'unknown' && normalized !== 'unknown reviewer' && terms.some(term => normalized.includes(term));
  });
}
