import { repairAgentNativeCompanion } from './agent-native-companion-repair.ts'
// Only reviewed operator/dev deployment invokes this fixed maintenance entry.
// Its policy contains identity/hash metadata, never auth/env or an executable.
void repairAgentNativeCompanion(JSON.parse(process.argv[2])).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{
  process.stderr.write((error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)?error.message:'NATIVE_REPAIR_FAILED')+'\n');process.exitCode=1
})
