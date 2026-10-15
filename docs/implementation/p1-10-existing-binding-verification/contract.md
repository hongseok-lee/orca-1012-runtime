> Root 계약 전문의 공개 일반화 사본입니다. 비공개 운영 판정 링크·운영 DB identity·원자료 경로만 일반화했습니다. private 원본 SHA256: `ec6c7a93b73c53e93ada60b8e786416197a7d26a9e0ac1ec007371e15ff2cc3d`.

# P1-10 — 기존 UNVERIFIED binding의 첫 directory 검증 반영

Root 계약, 2026-10-15 12:34 UTC. 기존 DB Sol6.1/high를 재사용한다. Source 작성·좁은 fixture 준비만 먼저 수행한다. 계획·수용·배분은 Root가 전담한다.

## 실제 공백과 범위

Root가 main687e1cf9의 `catalog/runtime-launch.ts`, `storage/store.ts`, `storage/evidence.ts`, migrations002/007/021을 읽었다. Catalog는 domain lock 아래 canonical tuple의 기존 binding을 재사용하거나 UNVERIFIED row를 만들고 공개 Session의 primary로 연결한다. StorageStore.registerBinding은 새 INSERT만 하므로 그 기존 row에 최초 검증을 결합할 경로가 없다. 새 UUID로 대체하면 primary의 불변성과 공개 객체 연속성이 깨진다.

Root는 Root의 비공개 storage 리뷰 판정의 D2 중 **기존 binding 최초 검증과 그 동일 요청 재생**만 이번 범위로 확정한다. Catalog의 재사용 로직·새 binding 등록·공개 RPC·물리 authority issuer는 변경하지 않는다. 임의 raw 관측으로 VERIFIED를 만들지 않으며 기존 StorageEvidenceAuthority의 준비된 immutable directory evidence/pin만 소비한다. 실제 production owner는 후속 구현이며 fixture authority는 합성으로 표시한다.

## 고정 인터페이스와 변경

`StorageStore.verifyBinding(tx, input)`을 internal 메서드로 추가한다. Input은 기존 StorageScope에 `bindingId`, `expectedBindingRevision`, `directoryEvidenceRef`를 더한 형태이며 반환은 기존 Binding이다. 새로운 row/별도 binding/Session/Unit/Tab이나 migration은 만들지 않는다.

1. 첫 await 전에 input의 사용 필드를 primitive로 복사·검증·freeze한다. 기존 ID/counter/reference 규칙을 사용하고 caller의 후속 객체 변경에 의존하지 않는다. Directory accessor의 실패/부재/ref 불일치·non-frozen candidate/domain·topology pin 부재/invalid는 거절한다. 기존 prepared/local 동기 경계를 유지하며 SQL 안 stat/K8s/Cloud/네트워크는0이다.
2. Session→Unit→storage domain의 기존 순서로 잠근다. Session OPEN, 정확한 Unit revision 및 PR98 관계의 exact Session/Unit/binding 소속을 확인한다. Expected binding을 읽고 evidence의 backend/export/canonicalDirectory가 전부 같은지 확인한다. Domain lock 이후 binding을 SELECT FOR UPDATE로 다시 읽고 pin을 재검사한다. 이 binding row lock을 history 부재 검사·CAS·사건 기록 동안 유지해 concurrent child FK 삽입과도 직렬화한다. 잘못된 소속·다른 tuple·다른 ID를 attach/repoint하거나 기존 primary를 갱신하지 않는다.
3. 최초 mutation은 access_state=UNVERIFIED, identity_proof_ref/identity_verified_at NULL, epoch0, writer_attempt_id/seal_id NULL, grant와 mount 이력0, expectedBindingRevision 일치인 row만 허용한다. 기존 행을 CAS해 proof ref와 clock_timestamp, access_state=VERIFIED, revision+1만 기록한다. Canonical identity·epoch·writer·primary·공개 ID·Unit revision/intent/activity는 그대로다. 마지막 mutation 직전 pin이 여전히 유효해야 한다. 실제 COMMIT/ROLLBACK까지 pin을 유지할 책임은 기존 authority owner에 남으며 이 메서드의 local 검사로 물리 lifetime을 보장한다고 쓰지 않는다.
4. 이미 VERIFIED인 동일 evidenceRef·동일 tuple의 첫 검증 재호출은 epoch0/해당 writer·seal·grant/mount 이력0을 만족할 때만 무변경 반환한다. Expected revision은 현재 값 또는 정확히 현재-1인 첫 적용 전 값만 허용한다. 다른 proof ref/상태/이력/tuple를 바꾸거나 자동 갱신하지 않는다. 오래된 current authority를 되살리는 refresh API가 아니다. 재생에도 현재 prepared evidence/pin·소속/Unit 검사가 필요하다.
5. 최초 성공에만 STORAGE_BINDING_VERIFIED journal/audit/outbox를 같은 caller transaction에 한 번 기록한다. 재생은 새 사건/row/time/revision0이고 outer rollback은 proof 갱신과 모든 사건을 함께 되돌린다. 기존 event payload 의미를 유지하며 원 경로/관측/본문/credential을 로그에 복사하지 않는다. 실패는 안정적인 기존 스타일의 STORAGE_* error로 반환하고 caller input을 메시지에 복사하지 않는다.

Base는 mainc0ccca1735dfd652765e36cb8cd0171bde10d00b다. 소유는 storage/store.ts의 작은 연결, 필요한 새 internal `binding-verification.ts`, 그리고 새 `binding-verification.pg.test.mts`다. 기존 register/attach/활성화/fencing 구현·authority 계약·canonical parser·기존 fixture·SQL001–021·Catalog/RPC는 변경0이다. 작은 helper 분리는 허용하지만 기존 코드를 대대적으로 이동하거나 lint suppression/전면 정리는 하지 않는다. 기존 event·pin validator를 재사용하는 최소 연결을 우선하고 파일 제한과 충돌하면 원 진단과 가장 좁은 source 조정안을 Root에 보고한다.

## 최초 검증 fixture와 제출

Fixture는 단일 top-level callback 안에서 기존 격리 PG ledger21을 사용하도록 작성한다. 실제 Catalog와 같은 UNVERIFIED primary/추가 binding을 새 UUID로 준비하고 첫 검증의 기존 ID/tuple/epoch/primary·Unit/Tab 보존, 같은 proof 재생의 사건0, 다른 proof/tuple/소속·stale revision·closed Session·invalid pin의 거절, lock 대기 중 pin 무효화, outer rollback을 확인한다. 두 실제 transaction의 동일 binding 검증 경합은 성공 mutation1·사건1로 끝나야 한다. 이미 사용된 상태/이력을 최초 검증으로 되돌리지 않는 거절도 다룬다. 기존 전체 storage/PG/canonical/PR98 suite를 복제하지 않는다.

지금은 source/fixture·조기 pin/exactdiff·DraftPR, heavy0이다. PG/lint/type/실제 시험/새 PNG/live migration/NFS/provider/설치/build0이다. Root source 검토 뒤 기존 remote cache의 owned lint/type와 새 focused PG callback 최초1회만 배분한다. Same Pool의 DB/system/OID/dataset·기존 ledger21 identity를 첫 seed 전에 guard하고 실제 기존 row 보존·원 TAP/입력 hash/cleanup을 기록한다. 대상은 기존 격리 Root가 고정한 기존 격리 DB/OID/system이며 liveorca_dev는0이다. 기존 행/schema reset/drop/delete는 허용하지 않는다.

본문에 이 명세 전문과 P1-10/승인 public COMMON·변경·미검증을 담는다. 운영 DB identity·원 경로·UID는 공개 일반화하고 보존 원본은 그대로 둔다. 물리 directory/mount/namespace pin/provider/RW/HA 합격은 아니다. 새 usage/credits/stream 원오류만 실제 시각/문구로 보고한다. 기존9 worker/총11·새fork0·동결template/backup/TTL보호를 유지하고 worker는 계획 MD/메모리를 수정하지 않는다.

## 12:50 Root source 수락·최초 검증 배분

Root가 early25e86fcffe776998469374e78d2569f8e11ceb0d의 helper102줄과 Store 연결, a30d2601587d31f0c35bb761ac2d4ae4394d93d2의 fixture332줄 전문을 읽고 기존 Store/connection/SQL001·006·021과 대조했다. Session→Unit→domain→binding row lock, lock 대기 뒤 별도 history 읽기, initial CAS/동일proof 재생, immutable input/evidence/pin, callerTX 안 사건과 childFK 대기 조건을 source 수준에서 수락한다. SQL001–021·register/attach/authority는 그대로다. 실제 검증 합격은 아직 아니다.

같은 DB worker에 heavy1로 최초 검증을 배분한다. 기존 remote backend cache와 reviewed runner 방식을 재사용하며 소유3파일 lint1, 좁은 strict type1, 새 PG fixture top callback1만 실행한다. Type closure·ESBuild 실행 closure와 actual 입력 hash/원 TAP/exit/시간/job/PID·cleanup을 보존한다. 새 fixture의 module 입력·원 SQL21 checksum은 source pin과 같아야 한다. 새 build/image/install·전체 suite·이전 성공 PR98 시험·새 migration apply는0이다.

PG는 기존 Root가 고정한 기존 격리 DB/OID/system/ledger21/승인된 dataset을 그대로 쓴다. Same Pool identity와 ledger 전체 checksum을 첫 seed 전에 확인하고 불일치 시 seed0에서 멈춘다. 기존18표의 모든 row hash는 보존 확인하고 새 fixture UUID의 상태/역사만 추가한다. DELETE/reset/drop/기존row갱신/liveorca_dev는0이다. Fixture가 검사하는 root 입력 guard와 raw identity는 private에 보존하고 공개본은 일반화한다.

Store의 상속 lint26은 PR98 원 진단과 비교해 동일 진단이면 그대로 기록하고, 새3파일 변경에서 유입된 진단과 분리한다. 상속 진단만으로 성공검증을 반복하거나 기존 코드를 정리하지 않는다. 최초 새 lint/type 실패는 원 로그를 보존하고 소유3파일의 명확한 import/type/fixture 구문 교정만 허용한다. 제품 의미·SQL·테스트 기대값 변경은 Root에 원 실패와 delta를 먼저 보고한다. 이미 통과한 검증은 반복하지 않고 교정 파일 lint와 미완료 단계만 계속한다. PG 실패 뒤 같은 callback 전체를 자동 재실행하지 않는다.

Draft PR 본문은 현재 source/명세/미검증을 먼저 갱신하고 최초 결과를 회수한다. PNG/live/NFS/provider/물리authority 시험은 이 배분에 포함하지 않는다. 결과 뒤 최초 정제 보고 PNG와 최종 공개자료는 별도로 배분한다. 새 usage/credits/stream 오류는 실제 turn/job과 구분해 보고한다.

## 13:01 최초 결과 수락·공개 증거와 PNG

Root가 affc182389e1bce9e433335080b00581ab5621f2의 원 TAP/runner delta/actualtype13·PG8·SQL21/생성wrapper/DB전후/종료기록을 읽고 Git와 대조했다. Control40301은12:55:24.864–30.013 종료, lint40315 exit1(상속26·새0), type40334 exit0/진단0, PG40401/실제40407 callback1 PASS(skip0,부모wrapper포함TAP2)다. SamePool seed전 실제 동일 Pool backend PID의exact DB/system/OID/dataset, ledger21 불변, 원18표181행보존/후256행을 수락한다. Authority는합성이며 실제filesystem/provider/물리수명은미검증이다. Source3는 a30d2601과동일하고SQLapply/live0·knownchild부재/heavy0이다.

Rootaudit121개모두일치: 비공개 Root 원자료 감사 기록, SHA cfc32c2ae7b463440bf81392ffd59cdacc97601f09a2397f39e94a95f900409c. 최초Rootaudit의lint baseLines를현재main기준으로읽었던불일치1은원자료그대로보존했다. 실제classifier의baseline은9339d745이며그bytes와현재main의같은statement/현재줄을별도로대조해해소했다. Publicprovenance에는baselinepin을명시하고전체lint통과로쓰지않는다. Raw TAP SHAace3f500a713e3e27a9e64649b6ec77de9188d69824d2ed5f1d1723fa655e852.

같은DB worker는 제품/fixture를변경하지않고 결과·원hash·sourcepin·수용한명세전문/COMMON·미검증을 PR101 본문과 공개evidence로 정리한다. 기존remote Playwright와정제한오프라인보고화면으로 최초PNG1만캡처한다(heavy1). 앱UI/native/실제physicalproof사진으로표시하지않고raw운영주소/UID/DB identity/credential은공개하지않는다. 원파일을수정하지않으며정제본과원hash를연결한다. CapturePID/시간·실제PNGbytes/차원/cleanup을남긴다. 기존PG/type/lint/성공suite/새설치/build/live/UI제품시험반복0이다.

현재mainc0ccca17을유지한최종head·bodyhash·소유파일목록·검증입력불변·필수Foundation CI 결과를제출한다. 지금선제rebase0이며다른PR의merge에따른정렬은Root가별도로배분한다. 최종필수CI를skip-ci로우회하지않고Root가PNG/최신PR을읽은후수락/merge한다.
