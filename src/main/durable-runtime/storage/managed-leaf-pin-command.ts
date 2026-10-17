import { managedLeafInspectCommand } from './managed-leaf-collector-exec.ts'

/** Fixed server-owned argv. Stdin is a release token, never shell source.
 * An FD pins the inode; namespace enforcement separately protects its path. */
export const managedLeafPinCommand = `${managedLeafInspectCommand}
root=/exports/runtime-domains/$4/$5
exec 3<"$root"
printf 'ORCA_MANAGED_LEAF_PIN_HELD %s %s\\n' "$$" "$(stat -Lc '%d %i' /proc/self/fd/3)"
IFS= read -r release
[ "$release" = RELEASE_MANAGED_LEAF_PIN ]
exec 3<&-
printf 'ORCA_MANAGED_LEAF_PIN_RELEASED\\n'
`
