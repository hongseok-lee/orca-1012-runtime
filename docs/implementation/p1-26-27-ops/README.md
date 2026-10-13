# P126 / P127 API 조기 합류

Root가 지정한 HTTP / UI 첫 연결 계약의 API 소유 초기 source입니다. PR43 exact source `dae68ae347442d9d0300a645874bc4619120c5d3`에서 별도 branch로 작성했습니다. 원 PR22 / PR40 source와 시험 / PNG는 그대로이며 재실행하지 않았습니다.

`ops/contract.ts`에 UI가 읽는 Unit / 상세 / operation / event cursor / notification / command DTO와 `OpsUiProvider`를 정의했습니다. `createOpsHttpHandler(config: OpsHttpConfig): OpsHttpHandler`는 HTTP request를 소유하면 true, 아니면 false를 반환해 기존 static handler와 합성할 수 있습니다. `stop(): Promise<void>`는 서버 종료 접점입니다. UI provider는 `(pathname: string) => OpsUiAsset | null | Promise<OpsUiAsset | null>`이며 credential이나 actor를 받지 않습니다. `OpsUiAsset`은 `{contentType,body}`입니다.

`authenticateBearer(token)`은 startup 소유자가 기존 유효 키 verifier를 실제 호출하는 closure로 제공해야 합니다. 원 method / receiver를 bind하고 cookie를 인증으로 사용하지 않습니다. 같은 configured origin을 대조하고 no-store / sanitized 오류를 반환합니다. PG services / 실제 8개 route 연결은 계속 작성 중이며 조기 entry는 데이터 성공을 반환하지 않습니다. 최초 fixture / type / lint / PG / runtime / UI 캡처는 미실행입니다.

PR43이 변경한 `runtime-rpc-pairing-types.ts` / `runtime-rpc-state.ts`는 optional server config 연결과 겹쳐 Root에 파일을 먼저 보고했습니다. 해당 파일과 `orcad-entry.ts`는 변경하지 않았습니다. Startup 활성화와 최종 base / merge는 Root가 지정합니다.
