# P116 공개 PG 조회·구독의 조기 source

이 별도 branch의 기준은 main `c2304c4ef606bb3cf292363c7f123b7a83a8e1e6`입니다. Catalog `90eb71b6`/`1a25f853`/`9ca02f1d`와 014 `521a9ba9`의 실제 API를 소비합니다. 이 선행은 아직 main에 없으며 검증 합성본과 최종 root merge 순서에서 합류할 대상입니다. 공용 Catalog source와 DDL을 이 branch에 복제하거나 변경하지 않습니다.

`captureDurableCatalogReadConfig`는 서버의 borrowed Pool, dataset·논리 host, 확정된 허용 repo/group/workspace 집합 및 poll 간격을 첫 await 전에 고정합니다. Host 조회 함수와 원 receiver도 캡처합니다. 기본 poll 간격은 1000 ms이며 Pool을 생성하거나 종료하지 않습니다.

`captureCatalogReadContext`는 기존 인증 전송 계층의 fingerprint만 받아 서버 namespace의 Catalog principal을 구성합니다. Payload나 raw client ID/credential은 authority에 사용하지 않습니다. 이것은 인증을 새로 수행하는 helper가 아니며 인증된 dispatcher options의 경계가 전제입니다. 빈 direct/in-process context는 거절합니다.

`SharedCatalogHeadHints`는 같은 Pool/dataset에서 활성 구독이 있을 때만 하나의 읽기 전용 head poll을 공유합니다. Query가 겹치지 않고 구독 0개에서 timer와 pending callback 세대를 정리합니다. Head 변화는 snapshot 재조회 힌트일 뿐 wire payload나 새 정본이 아닙니다.

현재는 source 작성 중이며 PG/type/lint/test는 실행하지 않았습니다. 실제 RPC adapter·server constructor 합류와 새 fixture는 같은 위임 안에서 이어 작성합니다. Live source·환경·dev schema·Expo·Cloud는 변경하지 않습니다. PR32와 원 증거 및 읽기 전용 사실 문서는 그대로 보존합니다.
