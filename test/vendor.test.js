import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Vendored files stay byte-identical to the published package, so a hash check proves nobody edited them in place.
// To update one, follow "Vendored browser code" in docs/MAINTAINING.md and change its hash here in the same commit.
const vendored = {
  // idiomorph 0.8.0, https://registry.npmjs.org/idiomorph/-/idiomorph-0.8.0.tgz, package/dist/idiomorph.esm.js
  'web/vendor/idiomorph.esm.js': 'e1e2c7dbd606233d302bac48074fd1307c15609b77ea485c18f1b13d6be67c14',
};

test('vendored browser code matches the published release it was copied from', async () => {
  for (const [path, expected] of Object.entries(vendored)) {
    const actual = createHash('sha256')
      .update(await readFile(new URL(`../${path}`, import.meta.url)))
      .digest('hex');
    assert.equal(actual, expected, path);
  }
});
