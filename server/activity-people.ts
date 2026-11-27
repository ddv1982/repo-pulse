import { azureDevOpsService } from '../src/activity-text.ts';
import { matchesPersonName } from '../src/search-terms.ts';

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
    return normalized !== 'unknown' && normalized !== 'unknown reviewer' && matchesPersonName(normalized, terms);
  });
}
