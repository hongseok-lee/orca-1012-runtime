# Lifecycle core 구현 사실

P113 내부 SQL·transport core를 작성하고 소유 PG와 결정적 fixture에서 최초 검증했습니다. 실제 controller, Catalog handler, provider, Kubernetes actuator 또는 공개 RPC는 활성화하지 않았습니다. 전체 P113·V1-08·HA·G04 수용은 root가 판단합니다.

## 실제 API

- `requestUnitIntent`는 인증된 authority의 값, 정책, 대상, revision과 operation key를 첫 await 전에 복사·고정합니다. 기존 `inputPayloadHash`와 P103의 receipt-first commit/replay/uncertainty를 사용합니다. 새 인증을 만드는 함수는 없습니다.
- 같은 transaction의 `recordUnitIntent`는 전체 Session→Unit의 공용 lock과 membership 재확인 뒤 현재 expected revision과 intent를 검사합니다.
- `reserveSleep(tx, request)`의 Catalog signature는 유지합니다. CLOSED membership도 lock과 현재 writer·dispatch 검사에 포함합니다. CLOSED 자체는 영구 busy가 아니며 CLOSING은 미완료 cleanup으로 보류합니다. 실제 current activity/pin을 모르면 예약하지 않습니다.
- `joinPendingUnitIntent`는 실제 P105 pending row를 현재 RUNNING intent에 합류합니다. 입력이나 receipt를 다시 접수하지 않습니다. 수락한 command가 없는 오래된 sleep만 취소하며 idle 기한은 저장된 실제 업무 시각과 명시 정책에서 계산합니다.
- `readUnitProjection`과 `listDueReconciliations`는 읽기 전용 SQL입니다. 조회가 활동 시각·receipt·wake를 변경하지 않습니다.
- `prepareReconcileStep`는 실제 P103과 gateway authority·command·claim API를 사용합니다. 원 불확정 command의 이름과 deadline을 보존하고 재조회·인수합니다. 새 COMMITTED claim만 실행 disposition으로 반환하며 여기서 외부 I/O를 수행하지 않습니다.
- `recordReconcileObservation`은 원 Unit·operation·step·attempt·UID·epoch·term·watermark를 대조합니다. Raw STOPPED는 canonical status/stopped_at을 쓰지 않습니다. PRESENT/STOPPED는 기존 phase·관측 손실·binding·업무 사실을 보존합니다. 현재 missing/read failure만 관측 손실을 시작하거나 유지합니다.
- `recoverListWatch`는 initial LIST와 WATCH에 같은 event sink를 사용하고 단절/410에 한 번 LIST→WATCH를 복구합니다. ADDED/MODIFIED/DELETED/BOOKMARK를 명시하며 exact UID 삭제만 현재 목록에 반영합니다. 삭제 이력과 같은 이름의 다른 UID는 분리·보존합니다.
- `resolveCreateObservation`은 원 identity 전체를 첫 await 전에 검증·고정하고 원 namespace/name으로만 GET합니다. 응답 유실·caller 변경이 새 이름이나 다른 spec의 채택을 허용하지 않습니다.

## 실제 검증과 선행

검증 입력은 main `8edb42e16caf0ddaa840dc16e4e886e6acaca328`의 공용 source·schema 001–012와 정확한 소유 P113 source입니다. 공용 DB·input·queue·storage·provider·identity·package·lock을 수정하지 않았습니다. Shared source와 기존 cache를 읽기 재사용했습니다.

최초 source `4c516670`에서 22개 중 20개가 통과하고 입력 fixture 2개가 INVALID_PRINCIPAL로 실패했습니다. 교정 source `5964ee18`에서 두 사례만 재실행해 통과했습니다. 교정 scoped typecheck와 configured lint는 각각 exit 0입니다. 통과한 20개, 과거 gateway 13개 및 P103 장애 suite를 반복하지 않았습니다. [원 실패·교정·소스 관계와 선별 결과](evidence/first-verification.md)를 함께 읽습니다.

## 남은 실제 합류

검증 fixture의 authority와 activity 값은 production 인증이나 physical fence proof가 아닙니다. 실제 provider 사건의 업무 활동 검증, context/cancel 경계, 영구 writer fencing, READY verifier 및 actuator·controller scheduling·공개 handler·HA 합류는 아직 수용하지 않았습니다. 가짜 proof 생성기나 capability 광고는 없습니다.
