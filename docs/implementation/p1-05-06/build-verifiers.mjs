import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const toolManifest = process.env.ORCA_INPUT_TOOL_PACKAGE_JSON
if (!toolManifest) {
  throw new Error('existing_dependency_cache_required')
}
const require = createRequire(toolManifest)
const { build } = require('esbuild')
if (process.cwd() !== process.env.ORCA_INPUT_EXECUTION_ROOT) {
  throw new Error('owned_execution_required')
}
await mkdir('verifiers', { recursive: true })
for (const entry of ['prepare-verification', 'intake.test', 'attachments.test']) {
  await build({
    entryPoints: [`src/main/durable-runtime/input/${entry}.mts`],
    outfile: `verifiers/${entry}.mjs`,
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
    tool: require('esbuild/package.json').version,
    mode: 'Node24 ESM verifiers only, packages external',
    entries: 3
  })
)
