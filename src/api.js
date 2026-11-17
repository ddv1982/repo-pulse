let csrfToken;

export async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-Repo-Pulse-Token': csrfToken || '' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  let value;
  try { value = await response.json(); } catch { throw new Error(`The local app returned an unreadable response (${response.status}).`); }
  if (!response.ok) throw new Error(value.message || value.error?.message || (typeof value.error === 'string' ? value.error : `Request failed (${response.status}).`));
  if (value.csrfToken) csrfToken = value.csrfToken;
  return value;
}
