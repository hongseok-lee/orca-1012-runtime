# §5 table correspondence

Every §5 table family is represented as an actual relation. Names below are in `durable_runtime`; common PK/FK, counter bounds and owner relationships are executable SQL, not JSON substitutes for table families. This map reports implementation, not policy activation.

| §5 family | Actual relation(s) | Core fields / relationships |
|---|---|---|
| workspaces | workspaces | logical/public IDs, name, provisioning, revision, tombstone |
| workspace aliases | workspace_aliases | unique alias, workspace FK, origin |
| tabs | tabs | workspace/Session FK, kind, unique terminal handle, pane/order, lifecycle/close/revision |
| sessions | sessions | Agent/workspace FK, fence, lifecycle, input/message/event seq, journal/provider/context revisions |
| runtime units | runtime_units | desired/phase, intent, execution epoch, attempt, deadlines, revision |
| runtime members | runtime_members | unit/Session/storage FK; composite owner relations |
| attempts | attempts | unit/epoch, Pod/incarnation, COLD/RESTORE, resources/profile, snapshot, times/reason/status |
| resource profiles | resource_profiles | unit/revision, admitted resources, learned floor/protection, previous good/policy |
| rightsizing | memory_rightsizing_state | profile/window, resize/block times, failed targets, pending operation/revision |
| failure incidents | failure_incidents | attempt/unit/Pod/container, restart identity, unique evidence key, classification/evidence/recovery |
| recovery episodes | recovery_episodes | unit/trigger, state, growth/replacement counts, times |
| reservations | resource_reservations | unique operation, unit/profile/delta/state/expiry |
| messages | messages | Session seq unique, revision/seal/hash/body, intake/cancel/accepted fields; retained identity and sealed payload |
| original inputs | input_components; input_attachments | message+Session FK, Session input_seq unique, sender/operation/hash/original body; immutable attachment refs |
| context records | session_context_records | Session/revision/kind, same-Session target message/event, body/time/provider evidence |
| cancel intents | cancel_intents | fixed message/revision/attempt/unit/epoch/turn target, requester/time/cancel revision, interrupt state/evidence |
| delivery attempts | delivery_attempts | same-Session message/member/attempt FKs, epoch/state/provider/effect/admit/complete/failure |
| RPC receipts | rpc_receipts | non-null principal/scope/method/key PK, hash/response/commit time; immutable |
| legacy drafts | legacy_drafts | terminal FK, paired device/floor key, draft/body/attachment/lifecycle/time |
| session events | session_events | Session/journal/seq PK, event/source unique, body/time; immutable |
| outbox events | outbox_events | ID/aggregate/revision/event/published time; original event preserved |
| operations | operations | unit/kind/intent/execution/controller scope+owner+term, step/revision, expected Pod/resource/deadline/retry/result |
| controller leases | controller_leases | scope PK, owner/term/expiry |
| observations | observation_episodes | unit/attempt/epoch, watermark/start/deadline/resolved |
| producer event queue | runtime_event_queue; runtime_event_targets; runtime_event_attempt_history; runtime_event_failure_contexts | canonical event and producer/incarnation/seq unique; payload retained; attempts append-only; FAILED terminal/context with NULL successful processed_at |
| notifications | notifications | unique incident, target/reason/state, first/last/retry/read/resolved/action |
| replay heads | replay_stream_heads | stream PK, epoch/published offset |
| replay events | replay_events | stream/epoch/offset PK, unique event, payload/times |
| snapshot manifests | snapshot_manifests; snapshot_session_watermarks | unit/checkpoint/resource/status/seals/watermarks/digest/compatibility/closed revision/times |
| storage bindings | storage_bindings; storage_domains; storage_seals | unique actual backend/export/canonical path, epoch/seal/writer/access/proof; domain serialization; immutable identity |
| storage mounts | storage_mounts; storage_write_grants | binding/attempt/Pod/RO-or-RW/state/epoch/times/evidence; one held writer and boundary overlap guard |
| audit | runtime_audit_events | actor/device/unit/Session/operation/attempt/Pod/node/profile, kind/reason/state/times/producer/evidence/payload/commit |
| required execution invariant | execution_grants | one held unit grant; attempt/epoch relations and proof-bearing revoke |
| dataset and migration metadata | agents; dataset_metadata; schema_migrations | stable Agent identity, dataset name/epoch, applied version/checksum/time |

Migration split: 001 catalog, 002 execution/storage, 003 resource/operation, 004 input/context, 005 event/replay/audit, 006 future snapshot/seal representation, 007 storage epoch race and fixed cancel ref guards plus audit-unit FK. Original seven applied files remain immutable.
