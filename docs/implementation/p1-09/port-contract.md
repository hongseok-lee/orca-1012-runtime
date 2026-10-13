# P1-09 internal Runtime Port declaration — source facts

This declaration-only change is based on DB-owner contract commit `778aa223d76a5f2d6188c6e8aab025e7f505006c`. It uses the existing shared logical IDs and decimal BIGINT counter types without modifying identity, DB schema, packages, locks, existing RPC or runtime source. The 2026-10-12 design §12 is the contract reference. This change does not establish P1-02 acceptance or complete P1-09/V1-09.

## Declared calls and returns

Controller calls use `CommandRequest<Input>` and return `CommandResult<Result>`: successful method output is the resolved receipt's `result`. `operationId`, `controllerTerm`, `stepRevision`, `executionEpoch`, `intentRevision`, and `expectedPodUid` reside in the envelope, rather than being duplicated in each input. Initial create has an explicit `CREATE_WITHOUT_POD`/null UID branch; existing-Pod commands require a physical `PodUid`.

| §12 method | Input / resolved output |
|---|---|
| ensureAttempt | `EnsureAttemptRequest` / `EnsureAttemptResult`; unit/profile/cold-or-restore input, attempt/phase and explicit assigned-or-not-assigned Pod result |
| reportFailure | `ReportFailureRequest` / `ReportFailureResult`; verified runtime report, incident identity/evidence, classified incident/recovery operation |
| planRecovery | `PlanRecoveryRequest` / `PlanRecoveryResult`; incident/expected intent/policy, profile/reservation/resume/decision |
| fenceAttempt | `FenceAttemptRequest` / `FenceAttemptResult`; attempt, separate compute-stop and storage-revocation evidence |
| bind | `BindRequest` / `BindResult`; attempt/Pod/incarnation/verified identity/restore/challenge, epoch/CLOSED gate/bindings |
| prepareCheckpoint | `PrepareCheckpointRequest` / `PrepareCheckpointResult`; checkpoint/target/capture mode, boundary proof/watermarks/seals/uncertain effects |
| checkpointAndStop | `CheckpointAndStopRequest` / `CheckpointAndStopResult`; checkpoint/manifest digest, snapshot/ready/compute-stop proofs |
| releaseGate | `ReleaseGateRequest` / `ReleaseGateResult`; attempt/manifest decision revision, ready/provider bindings |
| resizeAttempt | `ResizeAttemptRequest` / `ResizeAttemptResult`; attempt/profile, operation/phase/admitted/applied resources/continuity evidence |
| stageInput | `StageInputRequest` / `StageInputResult`; sealed message revision/hash, delivery attempt, context revision/body reference; STAGED only |
| dispatchInput | `DispatchInputRequest` / `DispatchInputResult`; message/delivery attempt, PENDING/ADMITTED/UNKNOWN; ADMITTED requires provider reference and admission evidence |
| cancel | `CancelRequest` / `CancelResult`; fixed message and/or provider-turn target, request acceptance separate from observed target-stop evidence |
| events | `EventsRequest` / `EventsResult`; verified runtime/producer sequence/event batch, CONTIGUOUS_PG_ENQUEUE_PREFIX acknowledgement |

`ensureAttempt`'s required semantics are same operation → same attempt. `SUBMIT`, `LOOKUP`, and `TAKE_OVER` retain the original command/envelope/input hash and distinguish resolved, refused, unresolved and blocked receipts. An unresolved predecessor has no reconciled-success representation. These declarations do not enforce database serialization, repeat identity equality, controller authority, or actual effect execution; future gateway/PG implementation must enforce them.

`reportFailure`/`events` require verified workload identity plus attempt/Pod/incarnation/epoch/producer sequence. Private erased brands have no factory or external-string cast helper. The future authentication boundary must verify bindings; TypeScript declarations alone cannot authenticate a caller. Event ACK means committed continuous PG enqueue, not consumer DONE.

Compute-stop proof and storage-revocation proof carry different identities, epochs and evidence references. No HTTP/lease/absent-Pod-to-physical-proof conversion is provided. Cancellation request and proof both require at least one fixed target; epoch/attempt validation and correlation remain future execution-boundary responsibilities. PTY write/HTTP acknowledgement cannot construct provider ADMITTED through a supplied helper, because none is supplied.

## Identity and unresolved integration boundaries

The predecessor's shared identity module owns all logical/counter brands. `CheckpointId`, incarnation, policy/manifest/checkpoint revisions and reservation ID use its generic `LogicalId`/`Counter`/`RowRevision` families because that commit has no named exports for these roles. Physical Pod/Node IDs, provider references, hashes and evidence references use a separate erased reference brand. No shared identity ownership is duplicated. Named exports and exact lifecycle/policy decision vocabularies remain owner/root integration review points; `phase`/`decision`/classified reason are opaque strings rather than invented state enumerations.

Checkpoint/restore/resize are declarations only. No supported capability, gateway stub, provider success, authentication implementation, resource creation, PG call, runtime wiring, or physical fence implementation is added. `bind` returns CLOSED; a future `releaseGate` requires the centrally committed grant/manifest decision. No declarations are registered in public RPC or advertised to clients.

## Existing G-01 source comparison

The following preserved G-01 anchors were checked against the exact predecessor source. These are existing symbols, not implementations of the new Port.

| Actual source | Existing symbols / lines | SHA-256 |
|---|---|---|
| `src/shared/rpc-contract/structured-agent-session-params.ts` | `export const MutationEnvelope` L39, `export const SendParams` L144, `export const CancelParams` L162, `export const HandoffParams` L192 | `6e91d6f539ac159c6f19ca1208d80ad314b8a4a5aca7946f96280de887d8be6f` |
| `src/main/runtime/rpc/methods/structured-agent-session.ts` | `export const STRUCTURED_AGENT_SESSION_METHODS` L94, `name: 'agentSession.send'` L196, `name: 'agentSession.cancel'` L202 | `71530a96f54472fd5ae7da77cc6734abe6ad99f87faf92c13f49f26c801c0b83` |
| `src/main/native-chat/agent-session-wire/structured-agent-session-host-mutations.ts` | `export function sendStructuredAgentSessionTurn` L65, `export function cancelStructuredAgentSessionTurn` L104 | `ac12496a0f401dd5497c2eec180d3331933c48cc070950e230d09cd7d183708d` |
| `src/main/native-chat/agent-session-wire/structured-agent-session-turns.ts` | `export async function performSend` L88, `export async function performCancel` L182 | `98ce7b45a8cd3c48393c474a28206f02906a7d697ab6b78f7d1254b224cc4c07` |
| `src/main/native-chat/agent-session-wire/structured-agent-session-adapter.ts` | `export type StructuredAgentSessionAdapter` L144 | `852300ef33f9d779a5e195a7874379bf90d7a179cb8bc61bb1c3be457980fdbe` |

Existing structured send/cancel routes use `StructuredAgentSessionAdapter` and its host mutations/turn dispatcher. Their submission journal/provider path and exact turn cancellation are not silently replaced by this new interface. The original strict public mutation envelope remains separate from the internal controller envelope. Existing provider/PTY acceptance is not proof of the new durable ADMITTED contract. Actual gateway, receipt persistence, provider adapter, authentication and event enqueue integration are absent from this change.

## Verification scope

Only isolated remote Node/TypeScript declaration validation is applicable to this early contract. No gateway/runtime/provider execution or UI screenshot is claimed. Existing foundation source/native/API/client-watch evidence is retained as historical environment evidence, not rerun or promoted into P1-09 acceptance.
