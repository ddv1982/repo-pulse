export function branchName(ref: unknown) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}
export function actorName(identity: { displayName?: string; name?: string } | null | undefined) {
  return identity?.displayName || identity?.name || 'Unknown';
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
