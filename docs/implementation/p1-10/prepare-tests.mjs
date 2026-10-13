// Run in the approved remote dev container, using its existing esbuild cache.
// No install/build image or global loader mutation. Output stays in role /tmp.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const [sourceRoot, cachePackageJson, outputDirectory] = process.argv.slice(2);
if (!sourceRoot || !cachePackageJson || !outputDirectory) throw new Error('source/cache/output arguments required');
const require = createRequire(resolve(cachePackageJson));
const { build } = require('esbuild');
await mkdir(outputDirectory, { recursive: true });
for (const name of ['canonical','postgres']) {
  await build({ entryPoints: [resolve(sourceRoot, `src/main/durable-runtime/storage/${name}.test.mts`)],
    outfile: resolve(outputDirectory, `${name}.test.mjs`), bundle: true,
    platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
}
