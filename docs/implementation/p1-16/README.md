# P1-16 Catalog source handoff

The [full root assignment](task-spec.md) remains authoritative. This source is an
internal SQL implementation and typed compatibility facade. No public method
registry, live product selection, server or provider is activated.

The implementation imports DB014 row types and P1-03 receipt/transaction/lock
helpers. Reads use one read-only REPEATABLE READ snapshot. Workspace routing is
canonical and retains aliases/tombstones for receipt-first replay. Membership
discovery includes every Session and shared-Unit peer, followed by held-lock and
membership rechecks. Metadata rank6 precedes final projection-head rank10.

`reserveCatalogWorkspace` and `createCatalogTerminal` capture trusted prepared
configuration before the first await, insert unpublished logical rows, acquire
actual Session/Unit/storage locks and compose the owner `recordUnitIntent` in the
same receipt transaction. A new Unit starts ABSENT. Storage verification/proof
and all execution/write grants are left untouched. Initial terminals have pending
logical handles and no native provider, PTY or incarnation identity. Reserved
public ID/path and original create/launch requests are immutable. The incumbent
name generator runs under a namespace lock; stale prepared names fail and roll
back instead of silently changing a reserved identity.

Metadata update, selection/focus, rename and host UI entries do no wake/activity
mutation. UI retains shared state and excludes pairing-local/private-session
credentials. Close composes exact owner same-TX cancel, then tombstones its Tab
and blocks its Session's new input. Other Sessions in a shared Unit stay open.
`ptyKilled:false` and `unverifiable` describe the absent physical-stop evidence.
Sleep delegates all safety decisions to the owner and preserves DEFERRED reasons.
Removal reserves cancellation/tombstones/DELETE intent and retains original
options linked to operation IDs in outbox. Its facade returns `removed:false`
with an explicit physical-cleanup warning; no filesystem operation is performed.

Dependency references: DB014 `521a9ba96393a4d4383e5b6f42ceb234dff15d97`, cancel
`a1f44e80d6a6d90655b765fbbeaad359841dcf18`, lifecycle
`4c516670a0fb8fc7204150a12863e15d758886d7`, corrected sleep
`4db2bff75e9c61bc606f44d07ba2c70d30c94a55`. DB014 DDL/rows are byte-identical to
early `9044549c071e0bb4d9c614d0f577ef39df417cb1`. Cancel API bytes are unchanged
from `ae861915091894e91b66dcb766956205f870c83b`. These are source comparisons,
not SQL/type/PG passes. The branch remains based on the root's
`8edb42e16caf0ddaa840dc16e4e886e6acaca328`; predecessor integration and final PR
rebase remain root decisions. No other owner's files are copied or changed.

Root source-review corrections retain the immutable activity observation while
checking the trusted owner's current synchronous pin at SQL acceptance. A pin
revoked during Pool/SQL wait remains invalid. Fresh PG reservations use the
incumbent PS metadata summary and `hostScope.hostIds=[]`: physical census is
unverified. The wire's nonnullable count/boolean defaults are placeholders;
they do not establish observed physical count0, stopped/idle status or deletion.
Known logical execution hosts remain in `omittedHostIds`; no host is fabricated
or declared physically enumerated.

Current source limitations: production launch/physical-proof issuers are absent;
binding retirement validates a pinned current tuple but BOUND ingestion is not
implemented; full group/layout projection is incomplete; shared-Unit Workspace removal refuses
to delete another Workspace's Unit and awaits its scoped cleanup contract.
Actual controller consumption of preserved removal options is not integrated.
Subscriptions are internal PG readers with local commit hints, not public streams
or tested HA reconnect.

최초 실행 결과와 실패 이력은 [검증 결과](verification-report.md)에 기록했습니다. Node 사례 11개는 서로 다른 입력에서 통과했지만, PG 하위 사례 8개는 등록 오류 때문에 미실행입니다. 전용 타입 검증은 현재 오류 1개가 남았고 configured lint는 교정 소스에서 통과했습니다. 이후 synthetic profile fixture 변경은 아직 실행하지 않았습니다. 실제 화면 캡처와 Expo/native iPhone 결과는 없습니다. 이 결과는 P1-16 완료나 provider·물리 종료·storage fencing·provisioning·HA 합격이 아닙니다.
