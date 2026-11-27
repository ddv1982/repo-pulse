// How sync and history import report the records Azure returned that they could not read: the running count with
// its fields, and the warning a stream or import shows for it.
import { READS } from './sync-status.ts';
import type { AzureStream as StreamName, StreamWarning, UnreadableRecords } from '../src/contract.ts';

/** Both counts of records left out, with the fields of each. */
export function addUnreadable(sum: UnreadableRecords | undefined, more: UnreadableRecords | undefined): UnreadableRecords | undefined {
  if (!sum || !more) return sum || more;
  return { count: sum.count + more.count, fields: [...new Set([...sum.fields, ...more.fields])] };
}
/** The warning for records a read left out, or undefined when it left none out. */
export function warningOf(stream: StreamName, unreadable: UnreadableRecords | undefined): StreamWarning | undefined {
  if (!unreadable?.count) return undefined;
  const { count, fields } = unreadable;
  return {
    code: 'UNREADABLE_RECORDS',
    count,
    fields,
    message: `Skipped ${count} ${count === 1 ? 'record' : 'records'} in ${READS[stream]} that Azure returned without a readable value for ${fields.join(' or ')}.`,
  };
}
