> Root 위임 명세 전문의 공개 사본입니다. 원본 SHA256: `c43b35741e1cb9c8d40f5af62a117516d88c938d567f63b1055bcc0fde9c3568`.

# P1-07/20 — 두 durable 호출 경계의 타입 불일치 교정

Root 결정 · 2026-10-15. 기존 DB Sol6.1/high를 재사용한다. Base110d091538dedea4bfcd2b959e8dbc91c99b51e0. Browser 첫 type 검증의 외부23개 가운데 durable 제품2개의 원진단과 실제 caller/callee를 root가 읽어 범위를 정했다. 다른21개 진단을 이 작업에 포함하거나 전체 type PASS로 표시하지 않는다.

## 지정 변경

1. `src/main/durable-runtime/input/cancel-record.ts`에서 appendAudit의 `runtimeUnitId: unit`만 `runtimeUnitId: unit ?? undefined`로 바꾼다. AuditTransition은 optional string이고 callee가 SQL 인수에서 `input.runtimeUnitId ?? null`을 사용하므로 PG 값과 null 의미는 유지된다. CancelInputRequest/intent/receipt/claim/interrupt 및 공용 AuditTransition 타입은 변경하지 않는다.
2. `src/main/durable-runtime/rpc/structured-history.ts`의 검증 뒤 request를 만드는 `captureCatalogParsed` 호출에 기존 `AgentSessionHistoryRequest` generic을 명시한다. 앞서 검증한 tail/before/after가 generic object inference에서 string으로 넓어지는 것을 막는다. 새 assertion/cast·any·ts-ignore를 쓰지 않고 기존 runtime 검증·capture·request bytes·snapshot/권한/SQL 의미를 유지한다.

소유는 위 두 제품파일과 이 작업의 public 증거/설명 파일뿐이다. 패키지/공용type/helper/기존 fixture·다른 제품파일·live 서버는 바꾸지 않는다. 예상과 다르면 원진단/최소 diff를 root에 반환한다. 새 기획/작업목록 작성0, 과거 PR74/92 queue는 완료다.

## 실행과 수용

위 지정 두 교정의 exact diff를 보존·commit한 뒤 동일 worker가 heavy1에서 변경lint2와 두 파일 entry의 scoped strict type1회만 수행한다. 기존 원격 source/type cache를 재사용한다. 새 value/PG 시험을 작성하거나 기존 성공 suite를 반복하지 않는다. 실제 type readset/소유 진단/외부 진단/전체 exit를 분리하고 다른 오류를 숨기거나 고치지 않는다. 두 TS2322/TS2345 진단이 사라지고 source 문맥의 의미 불변이 root 수용기준이다.

원 PR93 type 실패를 이 PR이 이미 해결한 것으로 소급 변경하지 않는다. 두 source의 검증 pin과 해당 원진단·교정·정확한 결과를 담아 Draft PR을 제출한다. 계약/COMMON 전문, 실제 검증 결과 보고 PNG1개를 포함한다. 기존 Browser 환경에서 정적 결과 보고 화면을 캡처하고 제품 UI·live 검증으로 부르지 않는다. 같은 heavy1 내 순차 실행으로 source type와 PNG를 동시에 돌리지 않는다. 원격 설치/전체build/PG/Cloud/live source sync/Metro·제품 Chrome 재시작0이다.

현재 Backend 보고 캡처1과 이 검증1까지 heavy총2이며 Client 새 heavy 작업과 겹치지 않게 실제 시작/종료를 보고한다. Root가 PR 댓글·최종 수락/merge를 맡는다. 기존 동결/backup 보호·TTL 제외·native9+root/bridge11·최신 계약 우선·새usage 오류 원문 보고·단계 종료 원문/worklist 규칙을 유지한다.
