# 최초 managed binding owner

이 서버 내부 모듈은 처음 확정 취득한 namespace hold, 원 credential reader와 managed leaf collector, 원 관측 준비 감사, `verifyBindingWithPreparedPin`을 연결합니다. 공개 RPC를 등록하지 않습니다.

배포 설정은 Root가 수락한 qualification 기록 bytes와 별도로 고정한 기대 digest를 공급합니다. Caller가 준 bytes에서 기대 digest를 계산하는 것만으로는 신뢰가 생기지 않습니다. JSON shape와 digest 검사는 filesystem을 qualify하지 않습니다. 실제 private 기록과 배포 자격은 저장소에 포함하지 않습니다.

`FirstManagedBindingProfileRecord`는 `schemaVersion`, `qualificationRef`, `profile`의 ID·dataset·backend·export·namespace generation, `leafId`, `apiOrigin`, `caSha256`, credential ServiceAccount identity, PVC/PV/CSI identity, collector image/helper/exports identity를 담습니다. `references`에는 정책·권한·접근 관측·앞선 소유 mutation 종료의 reference/hash 배열을 넣습니다. 기록 bytes의 digest가 namespace profile/version digest입니다. Profile은 사전에 존재해야 하며 이 owner가 등록하거나 qualify하지 않습니다.

`createFirstManagedBindingOwner`에는 borrowed Pool과 신뢰된 profile·credential·collector 설정을 넣습니다. `verifyFirstBinding` 입력은 Session/Unit/binding/revisions/actor, 서버 소유 pin ID·owner token, 고정 leaf입니다. 수집은 원 factory를 사용합니다. 선택적 dependencies는 기존 trusted transport 경계이며 caller가 관측 객체나 collector callback을 공급하는 입력은 없습니다.

처음 `ACQUIRED` hold의 COMMIT/ACK와 정상 cleanup이 확인돼야 수집합니다. 원 관측은 고정 whole leaf와 storage identity에 정확히 대응해야 합니다. 감사 COMMIT/ACK와 정상 cleanup 뒤에만 private immutable directory evidence를 구성합니다. Prepared owner는 같은 evidence를 기존 transaction wrapper에 한 번 인수합니다. 동기 getter는 local prepared state만 읽습니다. Mount·execution-target·compute-stop getter는 null이고 해당 validity는 false입니다.

Wrapper는 실제 transaction settlement까지 pin을 보유합니다. Retained owner와 lease는 내부에 보존합니다. 결과에는 취득·감사·binding·release settlement와 참조만 넣고 credential·owner token·authority·evidence·lease를 노출하지 않습니다. Release COMMIT을 확인한 뒤 client cleanup이 실패하면 알려진 release 결과를 유지하면서 reconciliation 필요를 표시합니다. 불명 settlement·engine reject·process loss·기존 hold에서 자동 해제나 재취득을 하지 않습니다.

Binding을 시작하기 전 수집이 명확히 실패하거나 감사가 명확히 rollback된 경우에는 같은 owner가 `releaseFailedPreparation`을 명시 호출할 수 있습니다. Release를 재시도하지 않습니다. Caller는 실행 전에 private pin identity와 owner token을 보존해야 합니다. 이 모듈은 secret 저장·TTL cleanup·crash recovery를 추가하지 않습니다.

새 value·격리 PG fixture는 이 연결과 단계 경계만 확인하도록 준비했습니다. 기존 collector transport fixture를 재사용하고 기존 행과 migration ledger를 보존합니다. Qualification 기록과 credential은 합성이며 live 물리 수락에 사용할 수 없습니다. 최초 source 납품 시 fixture는 실행하지 않았습니다. DB의 prepared-observation 모듈은 읽기 의존이며 owner 검증 전에 먼저 병합해야 합니다.

이 최초 미사용 binding 소비는 원 server Pod·generation·device·inode를 보존합니다. `sameDirectory`와 역사 tuple 비교, 기존 legacy binding을 변경하지 않습니다. Writer 권한·Agent mount·execution target·oldwriter fencing·native·HA 완료를 발급하지 않습니다.
