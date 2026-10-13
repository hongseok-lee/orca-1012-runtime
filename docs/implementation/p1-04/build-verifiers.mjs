import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const require = createRequire('/workspace/backend/checkout/package.json')
const { build } = require('esbuild')
if (process.cwd() !== '/tmp/orca-p104-execution') {
  throw new Error('owned_execution_required')
}
await mkdir('verifiers', { recursive: true })
for (const [input, output] of [
  ['materializer.test.mts', 'materializer.test.mjs'],
  ['store.test.mts', 'store.test.mjs'],
  ['chunk-crash-writer.ts', 'chunk-crash-writer.mjs'],
  ['prepare-verification.mts', 'prepare-verification.mjs']
]) {
  await build({
    entryPoints: [`src/main/durable-runtime/attachments/${input}`],
    outfile: `verifiers/${output}`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
}
console.log(
  JSON.stringify({
    transformed: 4,
    tool: require('esbuild/package.json').version,
    format: 'esm',
    target: 'node24',
    packages: 'external'
  })
)
