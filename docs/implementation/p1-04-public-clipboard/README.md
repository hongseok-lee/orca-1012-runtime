# P1-04 공개 clipboard의 PG handler와 서버 설정 source

Root는 모듈 pin `e7fe71867c83a00b8e340b23b43e90e7d86a377f`의 제품·fixture와 실제 최초 결과를 [6176021991](https://github.com/hongseok-lee/orca-1012-runtime/pull/70#issuecomment-6176021991)로 수락했다. 원 base는 `be454791e2294330033a0af45b30fbdb8eb71fcd`이고 고정 main `e9ae59dc075adc9e3bde624ad00da1c116e71db8` 정렬은 1회였다. 수락한 handler와 module fixture 2개의 bytes/mode를 그대로 유지한다.

기존 다섯 clipboard 이름·schema·응답을 유지하며 실제 store의 start/chunk/commit/save/abort를 SQL transaction 안에서 호출한다. transport가 검증한 `authenticatedCallerFingerprint`를 `fingerprintAttachmentPrincipal`에 전달하므로 structured send와 같은 principal 표현을 사용한다. raw clientId·bearer·요청 principal은 인증 자료가 아니다. 합성 fixture context는 실제 인증 발급이나 기기 pairing 합격이 아니다.

원 factory는 config·host guard·Pool connect의 receiver·서버 aliasRoot를 동기 capture한다. 실제 dataset_metadata와 현재 host를 대조하며 borrowed Pool을 변경하거나 종료하지 않는다. 요청과 context를 첫 await 전에 분리하고 원 store의 chunk replay 및 committed abort 보존을 유지한다. SQL COMMIT 실패를 성공으로 바꾸지 않는다.

## 수락한 최초 모듈 결과와 원 실패

- 소유 lint 3개와 값 callback 1개는 `2026-10-14 18:35:56–18:35:57 UTC`에 exit 0이었다. 값 TAP SHA256은 `c025ab3db884a5e71f0feb7e036e5faab2a0144adf9471fea06f53e75b57c898`이다.
- 격리 `orca_public_clipboard_20261014`의 SQL 19개 최초 적용과 PG callback 1개는 `18:47:10–18:47:14 UTC`에 exit 0이었다. PG system은 `7696101282789175327`, dataset은 `orca-1012-dev-v1`, ledger는 19개였다. PG TAP SHA256은 `11f9fe7807ed888b034a40af04ef67ab4c556da63b2f17eca6b9286f55c3876a`이다. DB reset/delete는 없었다.
- 원 준비 실패는 protocol-version의 runtime leaf 2개 누락이었다. 해당 leaf만 보충한 뒤 actual 입력 19개와 metafile를 보존했다. 다음 lint 설정 plugin 5개 누락과 이후 Node preload `pg-env.cjs` 누락도 원 실패로 보존했다. 고정 plugin 5개와 기존 성공 PG 환경 주입만 승인받아 교정했고 성공한 준비·bundle·lint·값은 반복하지 않았다.
- Type은 미실행이다. 기존 bundle 3개의 사전 SHA 기록이 없다는 한계를 유지한다. 이번 사후 SHA 회수와 metafile 크기 대조로 과거 bytes의 동일성을 소급 증명하지 않는다. 값·PG generated wrapper는 원 bytes로 보존했고, database.generated.cts는 stdin 이름이며 실제 저장 파일이 아니었다.

## 19:02 계약의 서버 설정과 PR69 이후의 공개 배선 source

새 `clipboard-config.ts`는 선택적 서버 `attachments: { aliasRoot }`만 capture한다. own-data·plain 객체와 정확한 필드를 검증하고 getter·foreign prototype·추가 key·잘못된 타입·빈 값·NUL·개행을 거절한다. 기존 UUID 기반 `reserveAttachmentAlias` 절대경로 검증을 재사용한다. 입력이 없으면 기존 capture 결과에 새 필드를 넣지 않는다. Pool·host owner를 freeze하거나 수정하지 않는다.

`rpc/config.ts`와 `orcad-durable-catalog.ts`가 private JSON capture→prepare 재capture→readConfig로 같은 불변 사본을 전달한다. 기존 config file·pgpass 검증과 startup Pool stop 규칙을 유지한다. fallback root·request/env/tmp/과거 NFS 기본값·디렉터리 생성·filesystem materialization은 추가하지 않았으며 live 설정은 변경하지 않았다. 제품 조기 pin은 `1f7a882376470fa5ba27567d2a3e917f200d1e2b`이다.

Root가 PR69 병합 후 단일 소유권을 이전했다. 고정 main `663266d4d67c1a17a3943f05b172fdf5f757227c`에 충돌 없이 1회 정렬하고 `public.ts`·`registry.ts`에 clipboard 추가 배선을 적용했다. adapter constructor의 factory 1회 capture, requireOpen, `CATALOG_CLIPBOARD_NOT_CONFIGURED`, 원 unary 5개와 kind mismatch 거절을 연결한다. 추가 block을 제외한 public/registry bytes는 해당 main과 같으므로 병합된 create·history·send·cleanup을 보존한다. 원 다섯 선언/schema와 PG opt-out의 기존 경로는 변경하지 않았다. query 사전 교정 pin은 `97f0d9f434a585d70949058577c330e71bf49175`, 공개 glue pin은 `98dea7070fb6fbd22dd7275315934521e26c3c2b`이다.

새 wiring 값 callback 1개·PG callback 1개는 검증 pin `8bc8987920910f7cebfe990e0e2cbbcbde83d37a`에서 각각 exit 0으로 통과했다. Root는 [6177172411](https://github.com/hongseok-lee/orca-1012-runtime/pull/70#issuecomment-6177172411)로 원 결과와 actual 입력 1,612개 직접 대조를 수락했다. 값은 설정 capture·미설정·disposed·kind 경계를, PG는 원 선언→RpcDispatcher→adapter→실제 handler와 재생성 뒤 commit replay·committed abort·원 bytes 및 기존 ledger 보존을 정의한다. 새 PG fixture는 기존 격리 DB의 고유 `/synthetic/public-clipboard-wiring/` prefix만 사용하며 migration/reset/delete를 하지 않는다. 변경 소유 lint 7개는 최초 exit 0이었다. 첫 준비의 launch helper manifest pin 누락을 원 로그·metafile·actual 입력으로 보존했고, 620 B가 고정 Git과 같음을 Root가 확인한 뒤 metadata 1건만 추가했다. 기존 value bundle을 재생성하지 않고 재사용했으며 PG bundle만 최초 생성했다. Type과 schema 재적용은 0이다.

공개 등록 source를 연결했지만 실제 runtime 활성화·preview·provider materialization·SSH·device·HA 합격은 아직 아니다. non-null connectionId는 수락한 모듈에서 Save/Start의 PG 쓰기 전에 거절하며 물리 파일/SSH fallback을 만들지 않는다. 논리 alias는 provider 파일 읽기 성공 증거가 아니다. legacy Map 동시 제한·TTL·새 quota·앱 schema·orcad-entry.ts·attachment store/materializer/schema는 변경하지 않았다.

![변경 전 C2 실제 화면, 이번 clipboard handler 성공 증거 아님](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

이미지는 Root가 수락한 PR51의 변경 전 C2 실제 화면이며 immutable provenance를 재사용한다. 이번 clipboard handler·업로드·preview 성공 증거가 아니다. 새 촬영과 이미지 변경은 0이다. 후속 배선·검증 배분·수락·merge는 Root가 결정한다.

## 최종 정렬과 공개 증거의 범위

Root 지시에 따라 검증 ref를 보존하고 main `0da789b920cf43a5d993936e29ff7ceb304fde1d`에 최종 정렬 1회를 수행했다. Owned 10개 bytes/mode는 검증 pin과 같고 소유 밖 source는 지정 main과 같다. 소비 입력 중 PR73의 `projection.ts`·`read.ts`·`subscriptions.ts` 3개만 바뀌었다. [exact delta](evidence/actual-input-delta.diff)를 기록하며 원 성공을 최종 head에 소급하지 않는다. 새 callback·lint·type·schema·build·capture·live 실행을 반복하지 않았다.

Wiring job `28321`은 `2026-10-14 19:57:47.723–19:57:53.095 UTC`에 완료했다. DB OID `80991`·system `7696101282789175327`·ledger 19개와 기존 10개 table의 원 행을 전후 보존했다. Value TAP SHA256은 `0291c32afc53d18c682be4d6e89a6d452ec29752b3415299cb2de6ded159e98c`, PG TAP SHA256은 `4b942c34a26173bd61449fa5823d8caa0ba2a16599141877f02d7a109a387f2c`이다.

[검증 provenance](verification-provenance.json), [실제 입력 manifest](actual-input-manifest.json), [값 TAP](evidence/wiring-value.tap), [PG TAP](evidence/wiring-pg.tap), [원 manifest 누락 발췌](evidence/wiring-missing-manifest.excerpt.log)를 공개한다. 정제된 파일 hash와 비공개 원본 hash를 구분했다. 원 DB 행·private 환경·credential·로그의 운영 경로는 공개하지 않았다. 최종 head의 필수 CI와 Root merge는 별도 절차다.
