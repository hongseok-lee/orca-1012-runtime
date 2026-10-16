# Prepared binding pin을 실제 transaction 종료까지 보유

`verifyBindingWithPreparedPin(pool,input,authority,owner)`는 외부 trusted owner가 이미 보유한 prepared pin을 동기·원자적으로 인수하고 기존 Store binding verifier를 PR106 단일 transaction engine에 연결합니다. 실제 physical pin issuer는 구현하지 않았으며 반환에도 `physicalPinIssuerImplemented:false`를 명시합니다.

검증 source는 `b64f760cc361d5725083b22b6b4da9de302d7997`, 제품 검토 pin은 `88c7ef424e759c33a61b3a6687682095cc8bd00c`, base는 `bb4796f2cc23e7f7eae48fb590c450ac02705882`입니다. [정확한 파일/hash](source-provenance.json), [전체 diff](source.diff), [Root 작업 계약 전문](contract.md)을 제공합니다. connection.ts·기존 Store/verifier·authority 계약·SQL schema는 변경하지 않았습니다.

입력·authority accessor·owner/lease/borrowed receiver는 첫 await 전에 capture합니다. Frozen만으로 getter를 믿지 않으며 lease의 evidence/release own-data descriptor를 보호해서 읽습니다. 인수 후 capture 실패는 SQL 0·같은 owner/lease RETAINED입니다. 외부 owner는 take 실패 시 원 소유를 유지하고 성공 시 같은 prepared pin을 독점 인계해야 합니다. 실제 그 owner/물리 발급 구현은 후속 범위입니다.

NOT_STARTED·실제 COMMITTED·ROLLED_BACK 뒤에만 SQL 밖에서 release를 한 번 요청합니다. COMMIT/ROLLBACK 대기·callback throw·abort만으로 조기 해제하지 않습니다. UNKNOWN COMMIT 뒤 ROLLBACK ACK는 종료 사실과 UNKNOWN을 함께 보존합니다. UNCONFIRMED는 client.release(true)가 있어도 같은 owner/lease를 RETAINED로 반환합니다. Pin release 실패는 DB의 COMMITTED/cleanupFailed를 바꾸지 않으며 정제 release 오류와 같은 handle을 반환합니다. Engine 자체 reject는 미관측 값을 꾸미지 않고 database:null/고정 engineError/RETAINED로 분리합니다. 자동 release/retry·borrowed Pool.end는 없습니다.

## 실제 검증·원 실패

| 경계 | 실제 결과 |
|---|---|
| 최초 소유 2파일 lint | exit 1 · fixture prefer-template 2건 |
| 동일 문자열 표현 교정 뒤 fixture lint | exit 0 · 제품 lint 반복 0 |
| 최초 callback | exit 1 · fixture observed spread 복사본의 frozen 검사 실패 |
| Root 승인 원 객체 observer 교정 뒤 fixture lint/type | 모두 exit 0 · 소유/외부 type 진단 0 |
| 교정 뒤 focused synthetic callback | 제품 callback 1개 PASS · 부모 포함 TAP 2 PASS / 0 FAIL / 0 SKIP |
| 실제 readset/guard | type source 12개 + external path 210개 / runtime source 8개 · mismatch 0 |
| 실제 PG·물리 pin·NFS·K8s mutation·Provider/UI | 실행 0 |
| 새 PNG·install·whole build·runtime 재시작 | 실행 0 |
| Heavy 최종 점유 | 0 |

첫 callback 실패는 fixture의 타입 observer가 원 결과를 spread 복사해 frozen 검사를 다른 객체에 적용한 원인입니다. Root가 assertion function+8call의 원 객체 보존 교정을 수락했습니다. 제품·기대값은 불변이며 원 실패를 소급해 PASS로 만들지 않습니다. 변경 fixture lint/type·실패 callback만 이어갔고 기존 PR106/PG suite를 반복하지 않았습니다. 실제 runtime PID 41794, 2026-10-16 00:27:10.418 UTC에 교정 callback이 진입했으며 소유 child 모두 종료를 확인했습니다.

[최초 lint](first-lint.log) · [표현 교정](fixture-template-correction.diff) · [원 실패 정제 TAP](first-synthetic.sanitized.tap) · [observer 교정](fixture-observer-correction.diff) · [최종 fixture lint](final-fixture-lint.log) · [최종 원 TAP](final-synthetic.tap) · [실제 입력/wrapper/hash](actual-inputs.json) · [strict 설정](scoped-type.public.json) · [결과 범위](verification.json)

Real Store/verifier/engine과 controllable SQL transport·합성 immutable authority/owner의 interleaving을 확인했습니다. 지연 COMMIT/ROLLBACK·callback failure/abort·NOT_STARTED·UNKNOWN·UNCONFIRMED·release 실패·getter handoff·escaped-engine 예외를 다룹니다. 기존 binding의 VERIFIED 정확 재생으로 wrapper 수명만 좁혔으며 PG seed나 실제 provider/physical pin lifetime 인증은 수행하지 않았습니다. Controller 활성화·writer 허가·HA 합격이 아닙니다.

## 역사 환경 화면 — 이번 수명 검증 화면이 아닙니다

![2026-10-14 13:33:04.734 UTC의 기존 Expo Web Workspace 화면. 이번 pin 수명·mount 결과 화면이 아닙니다.](https://github.com/hongseok-lee/orca-1012-runtime/blob/bb4796f2cc23e7f7eae48fb590c450ac02705882/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

원 SHA256 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`, 390×844의 기존 Root 수락 PNG를 역사 자료로만 참조했습니다. [원 시각·source·한계](historical-environment-provenance.json)를 보존하며 재촬영·앱 접속은 0입니다. 새 usage·credits·stream 오류는 미관측입니다. 최종 수락·merge는 Root가 담당하고 Draft를 유지합니다.
