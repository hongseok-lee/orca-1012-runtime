# P1-04 공개 clipboard의 PG handler source

고정 main `be454791e2294330033a0af45b30fbdb8eb71fcd` 위에서 독립 `createCatalogClipboardRpc` factory와 값 callback 1개·격리 PG callback 1개를 작성했다. 제품 조기 pin은 `17258cb65b0061e2d1faea51d273b1e77c130732`이며 fixture pin은 `3cbc3dce`다. 이 단계의 실제 시험·type·lint·PG·원격·filesystem 실증·build·설치·live 실행과 heavy 점유는 모두 0이다.

기존 다섯 clipboard 이름·schema·응답을 유지하며 실제 store의 start/chunk/commit/save/abort를 SQL transaction 안에서 호출한다. 검증된 transport context의 `authenticatedCallerFingerprint`를 `fingerprintAttachmentPrincipal`에 전달하므로 structured send와 같은 principal 표현을 사용한다. raw clientId·bearer·요청 principal을 인증 자료로 사용하지 않는다. 합성 fixture context는 실제 인증 발급이나 기기 pairing 합격이 아니다.

factory는 원 config 값·host guard의 receiver·Pool connect의 receiver·서버 aliasRoot를 동기 capture한다. 실제 dataset_metadata와 현재 host를 store 호출 전에 대조하며 borrowed Pool을 변경하거나 종료하지 않는다. handler는 요청과 context를 첫 await 전에 분리하고 원 store의 chunk replay 경계 및 committed abort 보존을 유지한다. SQL COMMIT 실패를 성공 결과로 바꾸지 않는다.

값 fixture는 schema 오류·인증 부재·SSH target을 첫 connect 전에 거절하는 경계와 첫 await 중 request/context/options/config/connect 변경 capture를 정의한다. 격리 PG fixture는 handler의 start→ordered chunks→새 adapter→commit replay, duplicate chunk의 원 boundary와 conflict, 작은 Save, wrong principal, incomplete/aborted, committed 후 abort에도 실제 blob 및 input_attachments 참조 보존을 정의한다. fixture는 root가 제공한 기존 19개 migration의 별도 소유 DB만 사용하며 migration/reset/delete를 수행하지 않는다. 정의를 작성한 것이며 PASS 결과는 아직 없다.

`public.ts`·`registry.ts`·`config.ts`·`orcad-entry.ts`와 legacy clipboard·attachment store/materializer/schema는 수정하지 않았다. 실제 서버 등록과 stable aliasRoot의 startup 공급은 미연결이다. 논리 alias는 provider가 읽을 수 있는 물리 파일 증거가 아니며 preview·provider materialization·SSH 경로도 미연결이다. non-null connectionId는 Save/Start의 PG 쓰기 전에 거절하고 기존 다른 경로의 non-null target도 Commit 성공으로 반환하지 않는다. filesystem/SSH fallback·legacy Map 동시 제한·TTL·새 quota를 추가하지 않았다.

![변경 전 C2 실제 화면, 이번 clipboard handler 성공 증거 아님](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

이 이미지는 root가 수락한 PR51의 변경 전 C2 실제 화면이며 immutable 촬영 provenance를 재사용한다. 이번 factory·clipboard 업로드·preview·새 PG fixture의 성공 증거가 아니다. 새 촬영과 이미지 변경은 0이다. 후속 최초 검증 배분·서버 배선·수락·merge는 root가 결정한다.
