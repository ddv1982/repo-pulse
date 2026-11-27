/** Azure's all-zero object ID: the old side of a created ref, or the new side of a deleted one. */
export const ZERO_ID = /^0+$/;

export function branchName(ref: string | null | undefined) {
  const name = String(ref || '');
  // Saved merge enrichment can still carry unchecked provider fields.
  return typeof ref !== 'string' && name === '[object Object]' ? '' : name.replace(/^refs\/heads\//, '');
}
/** A person's display name, else their name, else Unknown. Azure may send any value, which is returned as it is. */
export function actorName(identity: unknown): unknown {
  if (typeof identity !== 'object' || identity === null) return 'Unknown';
  return ('displayName' in identity && identity.displayName) || ('name' in identity && identity.name) || 'Unknown';
}
export function safeAzureUrl(url: unknown, fallback = '') {
  try {
    const parsed = new URL(String(url));
    if (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      (parsed.hostname === 'dev.azure.com' || parsed.hostname.endsWith('.visualstudio.com'))
    )
      return parsed.href;
  } catch {
    /* A missing or invalid source URL is replaced with the known repository link. */
  }
  return fallback;
}
