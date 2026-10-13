# Root013 context delivery schema handoff

Separate implementation/p1-07-08-context-schema branch on012 predecessor. New013-context-deliveries.sql and ProviderContextDeliveryRow; SessionRow adds existing context_revision/provider_binding_revision projections.001–012 bytes unchanged; no new identity/package APIs or provider binding registry.

provider_context_deliveries fields match root minimum: UUID id, Session FK, nonnegative context/provider binding/execution revisions, SHA256 context hash, unit/attempt/Pod tuple, nonempty provider/native Session/evidence/source, nullable nonempty native turn, caller-supplied actual observed_at. Existing attempt four-column FK binds unit/epoch/Pod. Unique Session/binding/attempt/context revision/hash/evidence makes exact proof retries resolve to the original immutable row.

Session FK and original attempt tuple are retained independently of current membership/binding, so a late old-binding proof can be stored historically. The upper context module/verifier authenticates its Session ownership and decides current binding/context satisfaction; SQL stored refs are not actual provider proof and do not grant execution. No binding registry is invented.

Existing session_context_records becomes append-only including legacy provider_delivery_evidence: original identity/session/revision/kind/target/body/time cannot mutate/delete, and new delivery evidence goes to the new table. Queue insert remains compatible. Session context_revision cannot decrease; no automatic increment/wake, provider submission, transcript mutation or cancel target policy change.

This early handoff precedes owned-DB013 validation and does not claim cancellation/claim/context/provider module acceptance. No dev013 apply, shared fault/runtime/source synchronization or install. Consumer follows root P1-07/08 module contract.
