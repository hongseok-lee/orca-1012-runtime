# P120 journal 및 Terminal codec 검증 결과

새 Terminal codec의 순수 2개와 실제 PG media join 1개가 최초 실행에서 모두 통과했습니다. Fail·skip·cancelled는 0개이며 새 범위의 scoped type/lint도 exit 0입니다. 기존 순수 5개·PG distinct 6개 성공은 원 source의 이력이며 이번 실행에서 반복하지 않았습니다.

| 구분 | 실제 실행 source | 결과 |
| --- | --- | --- |
| 새 원 Terminal codec | `d6aeb9c1d8b079a4edf5bae289cb5bdc6e477686` | 순수 2개 + PG media 1개 최초 통과, type/lint 0 |
| 기존 journal·structured identity 이력 | `5cafadce3afb6c7e1bfd467f2963eb4d3b51545c` | 순수 5개 + PG distinct 6개, 최종 type/lint 0. 이번 재실행 0 |

조기 codec pin은 `26e841770e7bb6b920c733a313ec302111e7ddb0`이며 실제 실행은 전용 type 설정을 포함한 `d6aeb9c1`입니다. 원 Terminal writer shape는 `103b85872c3c9adb94fdfa6461b1cf8f1a83ea76` source 사실로 구분했습니다. 원 writer를 변경하거나 활성화하지 않았습니다. 기준 main은 `02bfba1a`, 원 Input은 `4d1cabbc`, 017 schema는 `a24db99e`입니다. 정확한 full pin과 213개 파일 hash는 [새 검증 결과 JSON](terminal-codec-verification.json)에 기록했습니다.

새 순수 첫 사례는 65개 chunk와 반복된 원 첨부 3개 위치, 256 KiB를 넘는 누적 text를 그대로 읽었습니다. 기존 message/user shape의 68개 block을 만들며 structured의 64 blocks/256 KiB 제한을 legacy aggregate에 적용하지 않았습니다. 마지막 CR인 wire.action.text를 누적 text 대신 쓰지 않고 raw payload·chunks·wire를 원 Input 모델에 유지했습니다. 다른 순수 사례는 잘못된 text join, attachment position와 alias/hash, unknown method/version/media, 다른 terminal 및 첨부 principal을 명시 오류로 거절했습니다.

실제 PG 1개는 기존 P104 정상 저장자가 소유 검증 DB에 만든 immutable 첨부를 사용했습니다. Reader가 같은 read-only REPEATABLE READ snapshot에서 Input 원 envelope·input_attachments position/alias/hash와 008 alias/hash/principal/media_type을 조회했고 image/png로 확인된 원 durable alias만 image-ref로 만들었습니다. 반복 위치 3개를 모두 보존하고 원 Input UUID의 item key를 사용했으며 legacy submission 배열은 비어 있었습니다. Reader SQL에는 blob content_bytes와 INSERT/UPDATE/DELETE가 없습니다. Fixture 데이터 준비와 read-only reader 경계를 구분하며 실제 provider 실행·인증·파일 접근을 검증한 것이 아닙니다.

Node 24.15.0, TypeScript 7.0.2, esbuild 0.25.12, oxlint 1.80.0과 @types/node 25.9.5의 기존 cache를 읽기 재사용했습니다. PGPASS mode는 0600입니다. 기존 소유 PG의 main 001–012 및 017 checksum 13개를 읽기 확인했으며 이번 DDL과 dev schema 적용은 0회입니다. 신규 install/image build/runtime 재시작/기존 성공 suite/촬영은 0회입니다.

2026-10-13 14:36:53.731 UTC의 보존 readback에서 소유 PID 9530은 Z, active job은 0개였고 heavy를 반환했습니다. Canonical source와 execution의 213개 파일은 모두 manifest와 일치했습니다. 원 TAP·type/lint·cache·schema 결과는 비공개 운영 증거에 그대로 보존합니다. 이후 두 model capacity 오류는 완료된 시험 성공과 별도인 제어 오류이며 원 결과를 변경하지 않았습니다. 이 문서 납품에서는 원격 조회나 제품 시험을 재실행하지 않았습니다.

기존 첫 검증의 원 실패도 유지합니다. 최초 type 4건은 UUID로 좁게 추론된 fixture operation key, lint 2건은 Record 표기, 최초 PG 23503은 fixture resource profile 0 누락이었습니다. PG 최초 5개 통과·1개 실패 뒤 해당 1개만 교정해 PG distinct 6개를 확인했습니다. 최초 shell 기동 오류와 sourceRevision 환경 변수 누락의 보충 provenance도 원 bytes와 함께 보존합니다. 기존 보고서의 legacy label은 실제 Terminal payload가 아니라 structured_submissions 행이 없는 agentSession.send/session-scope structured `{body}` fixture였으며, 이번 2개·1개만 실제 원 Terminal codec 경계입니다. [기존 최초 결과와 원 실패 이력](first-verification.md)을 별도로 연결합니다.

이번 납품은 receipt-only utility와 read-only media projection입니다. 전체 공개 snapshot/RPC, 실제 인증 issuer, provider echo·inference, native history/reconnect, 물리 fence 및 HA 합격은 미확인입니다. PR #30의 병합 source·PG 9개·PNG는 유지했습니다. 이 문서의 최초 보고 PNG는 지정된 client 한 명의 후속 촬영이며 이 worker는 촬영하지 않았습니다.
