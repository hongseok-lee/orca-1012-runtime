// Explicit owned verification transform. It installs nothing, executes no test
// and never mutates the shared dependency cache or live checkout.
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs/promises'
const execution = '/tmp/orca-p121-evidence-execution'
if (process.cwd() !== execution) throw new Error('Use the owned P1-21 execution mirror')
const require = createRequire('/workspace/backend/p1-02-db/tools/package.json')
const esbuild = require('esbuild')
const directory = 'src/main/durable-runtime/resources/evidence'
await fs.mkdir(path.join(execution, 'verification'), { recursive: true })
for (const name of ['evidence.test.mts', 'normalize.test.mts', 'original-provenance.test.mts']) {
  await esbuild.build({ entryPoints: [path.join(directory, name)], outfile: path.join('verification', name.replace('.mts', '.mjs')),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'silent' })
}
console.log(JSON.stringify({ status: 'TRANSFORMED', esbuildVersion: esbuild.version, testEntries: 3, testsExecuted: false }))
