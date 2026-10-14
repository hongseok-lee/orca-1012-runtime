# 기존 native journal source 사실

Main `02bfba1aa971d9449cad41103211e8a3d3503451`의 좁은 경로와 signature만 읽었습니다. 해당 parser를 PG reader에 연결하거나 변경하지 않았습니다.

- `src/main/native-chat/agent-session-journal/journal-row-schema.ts`의 `parseJournalRow(line: string): JournalRowParse`는 JSON 한 줄을 읽고 알려진 row schema로 검사합니다. 현재 version보다 새로운 row는 `unreadable: true`이며 성공 row로 변환하지 않습니다. `serializeJournalRow(row: JournalRow): string`은 JSON 문자열을 반환합니다. Native row 종류에는 epoch/item/tombstone/submission/dispatch/lifecycle-batch가 있습니다.
- `src/main/native-chat/agent-session-journal/journal-legacy-identity.ts`는 `createLegacyIdentityTracker`와 `LegacyIdentityTracker`를 export합니다. 이 reader는 해당 legacy 추정 identity를 원 중앙 Input identity나 provider echo proof로 소비하지 않습니다.
- `src/main/native-chat/agent-session-wire/structured-agent-session-history-result.ts`의 `readStructuredAgentSessionHistoryResult({journal, record, request})`는 기존 `readAgentSessionHistory` 결과에 record의 optional fence와 provider handle chain head metadata를 연결합니다. 기존 native history의 tail/before/after는 reduced timeline과 replay 의미가 있으며 이번 forward committed PG page는 해당 handler를 대체하지 않습니다.
