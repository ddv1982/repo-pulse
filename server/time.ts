/** An ISO 8601 timestamp for a time in milliseconds. */
export const iso = (ms: number) => new Date(ms).toISOString();

/** A repository's first import, and Start from scratch, read the last seven days. */
export const FIRST_SYNC_MS = 7 * 86400000;
