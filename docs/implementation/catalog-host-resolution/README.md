# Catalog host 판정 교정의 첫 검증과 최종 정렬

Legacy `connectionId`만 있는 Repo를 raw fallback이 local로 판정하던 경로를 교정했습니다. `validateCatalogSnapshot`, `confirmTombstone`, unverified ps가 기존 canonical Repo/Worktree helpers를 사용합니다. Parsed Workspace host 우선순위, dataset/allowlist/host-owner 확인과 기존 RR read-only/cleanup/error 경계를 유지합니다. Tombstone은 초기 snapshot에서 제외된 deleted Repo도 실제 id/payload로 다시 확인합니다.

검증 source는 `6e124f66274395136236f19e3ff4f9c5f446eb5d`이고 당시 base는 `8fdb1918ae03eeb96fbdebc47743f728c1c33b05`입니다. Root가 원 입력 union 316개·소유 5개·SQL 19개·원 로그 5개와 ledger를 직접 대조하여 첫 결과를 수락했습니다.

| 항목 | 기존 실행 결과 |
|---|---|
| 소유 lint 5개 | 2026-10-14 19:28:41.880–19:28:42.289 UTC, exit 0, warning/error 0입니다. |
| 값 callback 1개 | 19:28:42.294–19:28:44.228 UTC, PASS 1/FAIL 0/skip 0/cancel 0/exit 0입니다. |
| 격리 SQL | 새 `orca_catalog_host_20261014`, OID 88487에 001–019를 최초 1회 적용했습니다. |
| PG callback 1개 | 19:28:45.656–19:28:47.046 UTC, PASS 1/FAIL 0/skip 0/cancel 0/exit 0입니다. |
| 실제 입력 | 값 157개·PG 314개이며 Root가 대조한 union은 316개입니다. 실행 pin의 fixed Git 불일치는 0개입니다. |
| 타입·추가 실행 | type는 미실행이며 통과 검증·SQL·설치·build·live를 반복하지 않았습니다. |

[결과·시각·원 hash](validation-results.json), [실제 실행 입력](actual-input-manifest.json), [값 TAP](value.tap), [PG TAP](pg.tap), [소유 lint](owned-lint.log), [schema 로그](schema.log), [준비 로그](prepare.log)를 기록합니다. 이 5개 공개 로그는 원 bytes와 동일합니다. 실제 esbuild metafile은 input guard 전에 비공개 원 증거에 보존했고 `pg`/`zod`는 external입니다. Source delta 15개만 기존 cache 위에 준비했으며 dependency 설치나 전체 source 복사를 하지 않았습니다.

값 callback은 legacy SSH의 local 거절, explicit Repo host 우선순위, Worktree host 우선순위, Folder Workspace projection과 ps host 일치를 확인했습니다. PG callback은 실제 adapter read/subscribe의 legacy remote 거절과 local 유지, 초기 snapshot 전에 deleted Repo를 제외한 뒤 Workspace tombstone을 기록하는 결정적 경로를 확인했습니다. 실제 Repo 재조회·명시 오류·잘못된 removed frame 0개·ROLLBACK/release/cleanup을 대조했습니다. 기존 RR helper의 transaction 내부 `CatalogReadError`→`DB_FAILURE` 정제도 유지합니다. 합성 snapshot·private method 호출·무작위 sleep race로 경로를 대체하지 않았습니다.

## 정렬 후 공유 의존성과 수용 한계

Root 지정 main `663266d4d67c1a17a3943f05b172fdf5f757227c`으로 최종 정렬을 1회 수행했습니다. 소유 5개 파일의 blob/mode는 검증 source와 같고, 제품·fixture 소유 밖 파일은 지정 main에서 가져온 그대로입니다.

[PR69](https://github.com/hongseok-lee/orca-1012-runtime/pull/69)는 2026-10-14 19:31:26 UTC에 병합되었으며 merge commit은 위 지정 main입니다. 원 실제 소비 입력과 Git delta의 교집합에서는 `rpc/public.ts`와 `rpc/registry.ts` 두 파일이 바뀌었습니다. 둘 다 PG 314개 입력에 포함됩니다. 원 값 manifest의 157개 경로에서는 변경이 없습니다. [정확한 공유 의존성 diff](alignment-consumed-input.diff)를 별도로 보존했습니다.

최종 runtime closure를 다시 산출하거나 실행하지 않았습니다. 입력 전체 동일이나 정렬 후 새로운 PG PASS를 주장하지 않습니다. 기존 검증 pin의 결과와 병합된 PR69의 provenance를 구분하고 최종 수용 한계는 Root가 판단합니다.

## DB와 미검증 범위

기존 schema helper와 PG callback은 expected system identifier `7696101282789175327` assertion을 통과했습니다. 그러나 원 `schema-ready.json`에는 measured system field가 없습니다. 이 원 증거의 한계를 유지하고 helper 수선·field 추가·재측정을 하지 않았습니다. Ledger 19개 checksum/applied_at과 기존 seed는 불변이며 reset/delete는 없습니다. 모든 known child는 종료되었고 heavy는 반환되었습니다.

인증 context는 synthetic fixture이며 실제 기기 pairing/auth 증거가 아닙니다. 실제 Chrome/provider/native/HA/live 경로와 P1-16/17/20 전체 완료는 미검증입니다. 기존 launch-preparation의 local 전용·connectionId 거절을 유지하고 public/registry/다른 worker 파일을 직접 수정하지 않았습니다.

## 기존 화면의 출처

![기존 dev Ops 빈 scope](https://raw.githubusercontent.com/hongseok-lee/orca-1012-runtime/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first.png)

[기존 provenance](https://github.com/hongseok-lee/orca-1012-runtime/blob/3a315db34a635388bd7acd59828146f0ab6c83e9/docs/implementation/p1-26-27-live-dev-first/ops-empty-scope-first-provenance.json)의 시각은 `2026-10-14T09:54:55.097Z`, viewport 390 × 844, DPR 1, 이미지 390 × 1092입니다. PNG SHA-256은 `004784a90cd9fb0823c6571376f042f9c4bd7be318e5b04e67830b2db0c9237f`입니다. 이 교정 이전의 baseline이며 신규 host 교정 성공 화면이나 native iPhone 인증 증거가 아닙니다. 새 capture는 없습니다.
