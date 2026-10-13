import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const manifest=process.env.ORCA_CONTEXT_TOOL_PACKAGE_JSON
if(!manifest)throw new Error('existing_dependency_cache_required')
if(process.cwd()!==process.env.ORCA_CONTEXT_EXECUTION_ROOT)throw new Error('owned_execution_required')
const require=createRequire(manifest),{build}=require('esbuild')
await mkdir('verifiers',{recursive:true})
for(const entry of ['prepare-execution-verification','execution.test']) {
  await build({entryPoints:[`src/main/durable-runtime/input/${entry}.mts`],outfile:`verifiers/${entry}.mjs`,
    bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'silent'})
}
console.log(JSON.stringify({tool:require('esbuild/package.json').version,entries:2,scope:'isolated P107/08 verifier only'}))
