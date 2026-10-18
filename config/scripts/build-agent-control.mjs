#!/usr/bin/env node
// Builds the Agent Pod control bundle (Codex and Claude) that the backend
// transfers into /tmp/orca-agent-control.cjs and runs with the fixed bootstrap.
// Usage: node config/scripts/build-agent-control.mjs <out-directory>
// Prints {"file", "sha256", "bytes"}; the file is named agent-control-<sha256>.cjs.
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const out = resolve(process.argv[2] ?? join(root, 'out', 'agent-control'))
mkdirSync(out, { recursive: true })
const staged = join(out, 'agent-control.partial.cjs')
await build({
  entryPoints: [join(root, 'src/main/durable-runtime/runtime/agent-codex-control-entry.ts')],
  outfile: staged, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning',
  // The Claude Agent SDK is ESM and reads import.meta.url; the bootstrap runs
  // this CJS bundle with a real __filename.
  define: { 'import.meta.url': '__orcaImportMetaUrl' },
  banner: { js: "const __orcaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
})
const bytes = readFileSync(staged), sha256 = createHash('sha256').update(bytes).digest('hex')
const file = join(out, `agent-control-${sha256}.cjs`)
renameSync(staged, file)
console.log(JSON.stringify({ file, sha256, bytes: bytes.length }))
