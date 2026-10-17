# 기존 Session tab close의 metadata adapter 연결

제품 pin은 `7701474fdadfa841854fd6ee9b486696a0ec7598`, fixture 교정 pin은 `7f2fce82347439a6a5e06f9cc8dbe1f0300b0cab`다. 제품 수정은 `rpc/metadata.ts`의 method allowlist, prepared close의 빈 inputAuthorities, Facade entry 세 곳뿐이다. 기존 setTabProps 교정과 공개 선언/schema/registry/close/cancel 코어는 보존한다.

원 정상 close 요청은 `CATALOG_METHOD_NOT_CONNECTED`로 거절됐다. 입력 Message가 없는 Session을 정상 공개 close 경로에 연결한 범위다. pending Message가 있으면 `CATALOG_CANCEL_AUTHORITY_REQUIRED`로 거절하고 전체 transaction을 원복한다. 새로운 InputAuthority를 합성하지 않으며 일반 pending 취소/전체 close/물리 stop 완료를 광고하지 않는다.

소유 2개 파일 lint는 PASS였다. 첫 bundle은 cache의 후속 Client read dependency 때문에 준비 오류였으며 source pin에 맞는 실제 필요 파일만 owned 검증 stage에 준비했다. 실제 bundle 입력의 불일치를 숨기거나 공유 cache 원본을 바꾸지 않았다. 첫 PG callback은 fixture의 id-only project group payload가 원 parser의 필수 필드를 누락해 close mutation 전에 실패했다. 원 TAP를 보존했다. 기존 정상 fixture의 group payload와 workspace head 초기화 관례로 fixture만 교정하고 변경 fixture lint 및 미진입 adapter callback을 실행해 PASS였다. 기존 close 코어 suite는 반복하지 않았다.

새 adapter registry binding은 원 공개 이름과 CloseTab schema를 사용한 합성 sentinel 선언으로 확인했다. 합성 auth context에서 빈 Session의 Tab CLOSED/Session CLOSING/fence +1과 pending 취소 권한 부재의 rollback을 확인했다. 실제 공개 서버 선언은 수정하지 않았으며 실제 E2EE close 결과는 Backend 합류 뒤 별도로 기록한다. Provider/PTY/삭제 IO는 없었다.

전용 DB OID 80991/system 7696101282789175327/ledger 19를 유지했다. 기존 행은 정상 close의 전역 Catalog head revision +1만 명시적으로 허용하고 그 외 bytes를 보존했다. 실제 입력 361개와 bundle/metafile hash를 대조하고, fixture-only 교정에서는 같은 입력 pin을 재사용했다. 타입/설치/전체 build/schema/기존 성공 시험/새 촬영은 실행하지 않았다. 이번 결과의 usage limit/credits/stream 오류는 미관측이다.

실제 개발 반영은 Backend 단일 writer가 generation 8/runtime 27597로 수행했다. 같은 원 대상의 정상 인증 close는 2026-10-17 06:12:16.673 UTC/caller PID 27779에서 `closed:true`로 ACK됐으며 원 응답을 직접 회수했다. 후속 소유 scope 관측은 `actual-empty-session-close.json`에 정제했다. 원 `CATALOG_METHOD_NOT_CONNECTED` 거절을 보존하고 같은 실제 close를 중복 실행하지 않았다. 이는 입력 Message 없는 Session의 논리 close이며 provider/물리 stop 또는 일반 pending 취소 합격이 아니다.
