# Catalog 합성 교정 fixture의 type 결과와 Root 지정 소스 교정

제품 source는 `17cca6af7bb8fad1285921b399660a1a6806cad0`, 실제 실행 fixture는 `79f7d0e48be3cb790d77fa06626d30ff653307a0`, 실행 시 PR head는 `14f8bce02171307372a3302eda7e1772502b56a3`입니다. 2026-10-13 14:41:03.559–14:41:10.198 UTC에 fixture 변경 1개와 composition source 2255개를 대조했고 update exit 0 뒤 type exit 1로 종료했습니다. 62행의 TS2352 하나가 남았습니다. 원 branded AttachmentPrincipal을 가진 object가 UnitIntentAuthority의 비공개 brand를 포함하지 않아 직접 assertion의 타입 overlap 판정이 실패했습니다. 새 PG 오류나 권한 발급 오류가 아니라 합성 fixture의 타입 표현 경계입니다.

Type compiler PID는 10013, update PID는 10006, control PID는 9994입니다. Run readback은 FINISHED와 heavyOccupied=false입니다. 별도 owner control도 종료·active 0으로 Root가 확인했습니다. 이후 원격 반복 호출·runner 재시작은 없고 다음 heavy가 배정되지 않았습니다.

이 실행에서도 lint와 신규 PG 7개는 미진입입니다. 실제 PG 성공·실패는 각각 0개이며 PG 7개 성공으로 표시하지 않습니다. 최초 type 오류 2개 로그와 이번 TS2352 로그를 모두 보존합니다. 이번 로그 SHA-256은 `feb1af6d9f8919c1cf0e9c2f4bfd2e11bcd975ad786aebda6e1c965401fd9669`이고 569 bytes입니다. 최초 로그 SHA-256은 `a4dbaed023d43c369f00d873d84cbf985c156a735932119c1818d8ef63a466e4`입니다. 원 로그는 비공개 운영 증거에 보존합니다.

기존 성공 lifecycle fixture는 일반 string principal에 직접 assertion을 사용했습니다. Catalog fixture는 기존 paired-device constructor가 반환한 별도 AttachmentPrincipal brand를 가진 같은 원 principal을 사용합니다. 실제 lifecycle target 타입은 principalId:string과 별도의 비공개 object brand를 요구합니다. 이 필드·cast 차이를 읽기만으로 Root에 보고했고 새로운 authority constructor나 helper를 설계하지 않았습니다.

Root가 직접 검토해 지정한 fixture 전용 `as unknown as UnitIntentAuthority` 한 줄 교정을 source `9d8f399e6d5e73831851c689c1bd36430fcb0ed6`에 반영했습니다. 동일 principal·Unit·scope 값을 유지합니다. 제품 source object, authority issuer/type, DDL, 실제 권한 규칙은 바꾸지 않았습니다. 교정 후 type/lint·PG는 미실행이며 다음 배분을 기다립니다. 기존 Catalog 8개·순수 Node 13개·anchor·018 suite·캡처를 반복하지 않았고 설치·build·새 환경·RPC/provider 활성화도 없습니다.
