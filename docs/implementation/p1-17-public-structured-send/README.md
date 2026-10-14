# 공개 structured send 검증 결과

기존 `agentSession.send`를 PG의 durable input 접수에 연결했습니다. 원 본문과 COMMITTED owner attachment alias를 보존하며 input·pending submission·receipt·wake intent가 commit된 뒤 기존 wire 결과를 반환합니다. Canonical Repo/Worktree host helper로 legacy connection-only와 실제 host 불일치를 거절합니다. Provider dispatch 또는 수락은 이 결과가 아닙니다.

Root가 수락한 검증 source는 `a614538bdeee4627f2d456751c5dcc148203902f`이며, 소유 6개 파일을 그대로 유지한 정렬 source는 `58f80972e4385326fe55ab29c55506039407b91b`입니다. 고정 main은 `8fdb1918ae03eeb96fbdebc47743f728c1c33b05`입니다. 실제 입력 1,609개와 SQL 19개의 blob이 정렬 뒤에도 같고 비소유 실제 입력 delta는 0개입니다. 소유 파일과 hash는 [provenance](verification-provenance.json)에 있습니다.

변경 lint 2개와 host PG callback 1개가 exit 0입니다. [원 host TAP](host-pg.tap)은 tests 1 / pass 1 / fail 0 / skipped 0이며 system identifier·DB OID·ledger 19개는 전후 동일합니다. 지정한 16개 테이블의 기존 36행이 모두 보존됐습니다. 새 등록으로 전진하는 전역 publication head·UI 행을 불변으로 주장하지 않습니다. Attempt·execution grant·storage grant는 각 0개입니다.

최초 lint는 미사용 type import와 호출 없는 비공개 함수로 실패했습니다. [원 실패](first-lint-failure.txt)를 보존하고 Root 승인으로 해당 선언만 제거한 뒤 [변경 fixture lint](corrected-fixture-lint.txt), [첫 value 1개](first-value.tap), SQL 19개 최초 적용과 [첫 PG 1개](first-pg.tap)가 통과했습니다. 첫 PASS는 당시 범위에서 유효하며 누락 host case의 근거로 확대하지 않습니다. Host 교정 후에는 [변경 lint 2개](host-lint.txt)와 PG callback만 실행했습니다. 원 value fixture·assertions·실패·첫 PASS를 보존했고 schema/reset/delete/type/value 재실행은 없습니다.

최초 종료 후 ledger 수집은 supervisor의 PG 환경 전달 누락으로 실패했습니다. 원 오류를 보존하고 기존 private PG 환경에서 읽기 전용 조회만 보완했습니다. 이 수집 교정은 제품 실패나 시험 재실행이 아닙니다.

PG fixture는 실제 registry→adapter→core 경로를 사용하지만 fingerprint와 target scope는 합성입니다. 실제 pairing·앱/provider dispatch·수락·URL 첨부·Browser/native/HA는 미완료입니다. Path는 같은 principal의 COMMITTED attachment alias로만 해석하며 임의 FS·SSH·URL fetch를 수행하지 않습니다. 새 화면 촬영과 live source 갱신은 없습니다.

## 기존 실제 화면과의 관계

[기존 C3 화면과 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/be454791e2294330033a0af45b30fbdb8eb71fcd/docs/implementation/p1-16-c3-first-ui/README.md)를 그대로 참조합니다. Client source 참조는 `8edb42e16caf0ddaa840dc16e4e886e6acaca328`, C3 runtime 참조는 `e8ef0f7664bc8a5828b0c771b4b0bd247083a2ab`이며 실제 전체 checkout SHA 증명과 구분합니다. 원 촬영은 2026-10-14 13:33:04.734 UTC의 Workspace 창과 13:33:05.709 UTC의 Ops Unit 조회입니다.

![기존 C3 Workspace — 이번 send 검증이 아닌 과거 화면](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/be454791e2294330033a0af45b30fbdb8eb71fcd/docs/implementation/p1-16-c3-first-ui/workspace-created-first.png)

원 PNG SHA256은 `53990a5ab41bfafed707ee5a02b7fbdd67fe1a977d994cbce63a07f58f8cf00a`입니다. Expo Web 390 × 844, DPR 1이며 native iPhone이 아닙니다. Workspace/Terminal label 관찰이며 Terminal 실행 0 / Pod 없음의 기존 한계를 유지합니다. 이번 send/이미지/receipt/provider 성공의 화면이 아니며 새 촬영을 하지 않았습니다.


