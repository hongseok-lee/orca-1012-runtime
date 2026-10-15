#!/bin/sh
# Raw namespace metadata only; this helper does not issue authority or writer permits.
set -eu
umask 077

fail() {
    printf 'managed_storage: %s\n' "$1" >&2
    exit 1
}

valid_dataset() {
    [ "${#1}" -ge 1 ] && [ "${#1}" -le 63 ] || return 1
    case "$1" in
        *[!a-z0-9-]*|-*|*-) return 1 ;;
    esac
}

valid_uuid() {
    [ "${#1}" -eq 36 ] || return 1
    case "$1" in
        *[!0-9a-f-]*) return 1 ;;
    esac
    printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

directory_record() {
    local path="$1" expected_uid="$2" expected_gid="$3" expected_mode="$4" expected_device="$5"
    local resolved record
    [ ! -L "$path" ] && [ -d "$path" ] || fail 'Expected a non-symlink directory'
    resolved=$(realpath "$path") || fail 'Directory realpath unavailable'
    [ "$resolved" = "$path" ] || fail 'Directory realpath changed'
    record=$(stat -c '%d %i %u %g %a' "$path") || fail 'Directory stat unavailable'
    set -- $record
    [ "$#" -eq 5 ] || fail 'Unexpected directory metadata'
    [ "$3" = "$expected_uid" ] && [ "$4" = "$expected_gid" ] && [ "$5" = "$expected_mode" ] || fail 'Directory owner or mode mismatch'
    [ -z "$expected_device" ] || [ "$1" = "$expected_device" ] || fail 'Directory device mismatch'
    printf '{"path":"%s","device":"%s","inode":"%s","uid":%s,"gid":%s,"mode":"0%s"}' "$path" "$1" "$2" "$3" "$4" "$5"
}

exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

remember_creation() {
    created=true
    if [ -n "$created_paths" ]; then
        created_paths="$created_paths,"
    fi
    created_paths="$created_paths\"$1\""
}

ensure_directory() {
    local path="$1" uid="$2" gid="$3" mode="$4" parent="$5" parent_mode="$6"
    directory_record "$parent" 0 0 "$parent_mode" "$backing_device" >/dev/null
    if exists "$path"; then
        directory_record "$path" "$uid" "$gid" "$mode" "$backing_device" >/dev/null
        return
    fi
    if mkdir -m 0700 "$path"; then
        chown "$uid:$gid" "$path" || fail 'New directory ownership failed; partial state retained'
        chmod "$mode" "$path" || fail 'New directory mode failed; partial state retained'
        remember_creation "$path"
    fi
    # A mkdir loser only observes the winner once; it never repairs or retries.
    directory_record "$path" "$uid" "$gid" "$mode" "$backing_device" >/dev/null
}

check_existing() {
    if exists "$1"; then
        directory_record "$1" "$2" "$3" "$4" "$backing_device" >/dev/null
    fi
}

bootstrap_legacy() {
    local path
    if exists /exports/x; then
        directory_record /exports/x 1000 1000 755 "$backing_device" >/dev/null
        for path in /exports/x/agents /exports/x/dev /exports/x/test-homes; do
            # An existing workload-owned parent cannot protect root path-based initialization.
            directory_record "$path" 1000 1000 755 "$backing_device" >/dev/null
        done
        return
    fi
    if mkdir -m 0700 /exports/x; then
        remember_creation /exports/x
        directory_record /exports/x 0 0 700 "$backing_device" >/dev/null
        for path in /exports/x/agents /exports/x/dev /exports/x/test-homes; do
            ensure_directory "$path" 1000 1000 755 /exports/x 700
        done
        # Publish the new legacy parent only after its children are initialized.
        chmod 0755 /exports/x || fail 'New legacy root mode failed; partial state retained'
        chown 1000:1000 /exports/x || fail 'New legacy root ownership failed; partial state retained'
    fi
    directory_record /exports/x 1000 1000 755 "$backing_device" >/dev/null
    for path in /exports/x/agents /exports/x/dev /exports/x/test-homes; do
        directory_record "$path" 1000 1000 755 "$backing_device" >/dev/null
    done
}

[ "$#" -ge 1 ] || fail 'Missing operation'
operation="$1"
shift
leaf_id=
case "$operation" in
    bootstrap)
        [ "$#" -eq 1 ] || fail 'Invalid bootstrap argument count'
        dataset="$1"
        ;;
    ensure-leaf|inspect-leaf)
        [ "$#" -eq 3 ] || fail 'Invalid leaf argument count'
        expected_pod_uid="$1"
        dataset="$2"
        leaf_id="$3"
        valid_uuid "$expected_pod_uid" || fail 'Invalid expected Pod UID'
        valid_uuid "$leaf_id" || fail 'Invalid leaf UUID'
        ;;
    *) fail 'Unsupported operation' ;;
esac
valid_dataset "$dataset" || fail 'Invalid dataset label'
[ "$(id -u)" = 0 ] || fail 'Root execution UID required'
pod_uid="${ORCA_NFS_POD_UID-}"
valid_uuid "$pod_uid" || fail 'Valid Downward API Pod UID required'
if [ "$operation" != bootstrap ]; then
    [ "$expected_pod_uid" = "$pod_uid" ] || fail 'Pod UID guard mismatch'
fi

backing_root=/exports
managed_root=/exports/runtime-domains
dataset_root="$managed_root/$dataset"
created=false
created_paths=
directory_record "$backing_root" 0 0 755 '' >/dev/null
backing_device=$(stat -c '%d' "$backing_root") || fail 'Backing device unavailable'

if [ "$operation" = bootstrap ]; then
    check_existing "$managed_root" 0 0 755
    check_existing "$dataset_root" 0 0 755
    shared_root="$backing_root/shared"
    shared_dataset_root="$shared_root/$dataset"
    check_existing "$shared_root" 0 0 755
    check_existing "$shared_dataset_root" 0 1000 2770
    check_existing /exports/x 1000 1000 755
    for path in /exports/x/agents /exports/x/dev /exports/x/test-homes; do
        check_existing "$path" 1000 1000 755
    done
    if exists /exports/x; then
        for path in /exports/x/agents /exports/x/dev /exports/x/test-homes; do
            directory_record "$path" 1000 1000 755 "$backing_device" >/dev/null
        done
    fi
    ensure_directory "$managed_root" 0 0 755 "$backing_root" 755
    ensure_directory "$dataset_root" 0 0 755 "$managed_root" 755
    bootstrap_legacy
    ensure_directory "$shared_root" 0 0 755 "$backing_root" 755
    # Only initialize the dataset root; never traverse its mutable collaboration data.
    ensure_directory "$shared_dataset_root" 0 1000 2770 "$shared_root" 755
else
    directory_record "$managed_root" 0 0 755 "$backing_device" >/dev/null
    directory_record "$dataset_root" 0 0 755 "$backing_device" >/dev/null
    leaf_path="$dataset_root/$leaf_id"
    if [ "$operation" = ensure-leaf ]; then
        ensure_directory "$leaf_path" 1000 1000 700 "$dataset_root" 755
    else
        directory_record "$leaf_path" 1000 1000 700 "$backing_device" >/dev/null
    fi
fi

if [ "$created" = true ]; then
    /bin/busybox sync -f "$backing_root" || fail 'Filesystem sync failed; partial state retained'
fi
backing_json=$(directory_record "$backing_root" 0 0 755 "$backing_device")
managed_json=$(directory_record "$managed_root" 0 0 755 "$backing_device")
parent_json=$(directory_record "$dataset_root" 0 0 755 "$backing_device")
leaf_json=null
leaf_id_json=null
if [ "$operation" != bootstrap ]; then
    leaf_json=$(directory_record "$leaf_path" 1000 1000 700 "$backing_device")
    leaf_id_json="\"$leaf_id\""
fi
printf '{"schemaVersion":1,"kind":"managed-nfs-namespace-raw","operation":"%s","dataset":"%s","leafId":%s,"podUid":"%s","created":%s,"createdPaths":[%s],"backingRoot":%s,"managedRoot":%s,"parent":%s,"leaf":%s}\n' "$operation" "$dataset" "$leaf_id_json" "$pod_uid" "$created" "$created_paths" "$backing_json" "$managed_json" "$parent_json" "$leaf_json"
