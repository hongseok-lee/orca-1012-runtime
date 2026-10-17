# 같은 namespace의 새 leaf qualification 집중 검증

Qualification 파일 전체 digest는 leaf별 수락 bytes와 원 evidenceRef 계산에 사용하고, 선택적 `namespaceDigest`는 기존 namespace 등록·hold·profile/version 비교에 사용합니다. 필드가 없는 legacy qualification의 전체 hash 및 audit shape는 유지합니다. Expected file hash 확인을 약화하지 않았습니다.

제품 source는 `3048aea55757522c55e80c698e0fce3d2a4af14e`, 집중 검증 source는 `ccd94589c4c67e8038aa0c7721c526ff403d657c`입니다. Backend가 이미 작성한 `readOriginalFirstManagedDirectory` 조회 helper를 보존했습니다. Fixture의 최초 lint 실패 2건은 동일 출력 template literal로, 최초 type 실패 6건은 CA bytes를 보존하는 `Buffer.from`으로 교정했습니다. 두 실패 모두 PG 미진입이며 성공 fixture의 조건·SQL·assertion을 제거하거나 약화하지 않았습니다.

실제 PG callback 1개에서 legacy binding, 동일 namespace의 새 leaf binding, `ALREADY_REGISTERED`, 잘못된 namespace/leaf/qualification file 거절, 최종 commit까지 hold 보유와 해제를 확인했습니다. 별도 전용 DB의 새 소유 행만 추가했으며 원 252행·35표·기존 lease·ledger 23개를 보존했습니다. DDL·설치·기존 성공 suite 반복·실제 provider 호출은 0입니다.

[결과와 실제 source 입력](results.json), [원 PG TAP](focused-pg.tap)을 함께 제출합니다. 원 type log·metafile·DB identity/ledger·행 hash는 비공개 증거에 보존했으며 공개 결과에는 해당 자료의 hash와 보존 판정만 담았습니다. 계정 자격·비공개 원행·외부 credential 값을 게시하지 않습니다.

이 검증은 합성 HTTPS/WebSocket collector transport와 실제 제품 owner/PG transaction을 사용합니다. 외부 qualification 수락·물리 pin·활성 writer·provider READY·native 실행·HA 전체 합격을 의미하지 않습니다. Backend의 실제 새 leaf 연결과 이번 UI는 별도 실제 근거가 도착하기 전 미확인입니다.
