import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const toolManifest = process.env.ORCA_CANCEL_TOOL_PACKAGE_JSON
if (!toolManifest) throw new Error('existing_dependency_cache_required')
if (process.cwd() !== process.env.ORCA_CANCEL_EXECUTION_ROOT) throw new Error('owned_execution_required')
const require = createRequire(toolManifest)
const { build } = require('esbuild')
await mkdir('verifiers', { recursive: true })
for (const entry of ['prepare-cancel-interrupted', 'cancel-interrupted.test']) {
  await build({ entryPoints: [`src/main/durable-runtime/input/${entry}.mts`],
    outfile: `verifiers/${entry}.mjs`, bundle: true, platform: 'node', target: 'node24',
    format: 'esm', packages: 'external', logLevel: 'silent' })
}
console.log(JSON.stringify({tool: require('esbuild/package.json').version, entries: 2,
  mode: 'focused cancellation verifier only; installed packages external'}))
