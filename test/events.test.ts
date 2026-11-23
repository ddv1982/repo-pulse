import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAzureUrl } from '../src/events.ts';
test('source URLs reject credentials, script URLs and other hosts', () => {
  for (const url of ['javascript:alert(1)', 'https://evil.example/path', 'https://secret@dev.azure.com/org'])
    assert.equal(safeAzureUrl(url, 'fallback'), 'fallback');
  assert.equal(safeAzureUrl('https://dev.azure.com/org/P/_git/r'), 'https://dev.azure.com/org/P/_git/r');
});
