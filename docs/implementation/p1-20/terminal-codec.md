# 원 Terminal codec source 합류 결과

현재 작성한 codec·fixture source pin은 `e975394146ed742f815e21dbed688cba27664603`이고 조기 export pin은 `26e841770e7bb6b920c733a313ec302111e7ddb0`입니다. Source 작성 결과이며 type/lint와 새 focused fixture는 아직 미실행입니다. 기존 순수 5개·PG distinct 6개/type·lint 결과는 원 source `5cafadce`와 보고 head `e684bf24`의 역사 증거로 보존합니다. 새 source에서 해당 성공 시험을 실행했다고 표시하지 않습니다.

실제 Terminal writer source `103b85872c3c9adb94fdfa6461b1cf8f1a83ea76`의 `terminalIntakePayload`는 `{version:1,text,chunks,wire,originalIngressId}`를 저장합니다. `text`는 ordered chunks text의 join이고 wire는 마지막 원 ingress입니다. CR-only 제출은 wire.action.text가 CR이지만 누적 text와 다를 수 있습니다. 각 chunk에는 nonempty ingressId, string text와 ordered attachmentId reference가 있으며 별도 Input attachments 배열은 ordered aliasPath/contentHash입니다. 원 canonical version 1 envelope는 Input core의 형식입니다. Terminal writer·DDL·다른 owner 파일을 수정하거나 decoder에 writer를 활성화하지 않았습니다.

`decodeCommittedInputBody(input)`는 `agentSession.send`의 session/GENERAL body에 기존 strict schema를 사용하고 `terminal.send`의 terminal/GENERAL payload version 1을 별도로 구분합니다. Session/scope/terminal과 원 ingress identity를 대조하며 ordered chunks join이 누적 text와 정확히 같아야 합니다. 같은 첨부 ID의 반복 위치는 보존하고 해당 ID가 서로 다른 alias/hash를 가리키면 거절합니다. 현재 ingress의 raw wire attachments도 chunk reference 및 원 alias/hash와 대조합니다. 원 wire는 render body로 교체하지 않고 input.original에 그대로 유지합니다.

Legacy render body는 기존 message/user shape이며 chunk마다 원 text block 뒤에 해당 ordered attachment image-ref를 둡니다. Item key는 원 Input UUID이고 legacy submissions는 비어 있습니다. Structured의 64 blocks/256 KiB send 제한을 이미 접수된 legacy aggregate에 적용하지 않습니다. Fixture는 65개 chunk와 반복 첨부 및 256 KiB를 넘는 원 text를 준비했습니다. Trim·정규화·요약·정렬·중복 제거는 하지 않습니다.

Reader는 같은 read-only REPEATABLE READ snapshot에서 원 Input envelope와 input_attachments의 position/alias/hash, 기존 Tab의 Session/terminal 연결을 대조합니다. 008 attachment_aliases의 alias/hash/principal과 immutable attachment_blobs의 media_type만 LEFT JOIN합니다. Blob bytes·파일·credential을 읽거나 새 alias를 만들지 않습니다. 원 principal과 같은 alias이며 media_type이 image/png로 확인된 Terminal 첨부에만 image-ref를 만듭니다. Unknown codec/version, join 불일치, position·alias/hash·media·원 ingress 불일치는 명시적 읽기 오류이며 성공이나 빈 대화로 추정하지 않습니다.

새 순수 focused 2개와 PG media join 1개는 별도 파일에 작성했습니다. PG fixture는 승인된 소유 DB에서 기존 P104 정상 writer로 테스트 데이터만 준비하도록 작성되어 있으며 이 턴에는 실행하지 않았습니다. Fixture의 nominal scope와 media facts는 실제 인증 증거가 아닙니다. 기존 순수 fixture helper의 얇은 envelope에는 원 session/method/GENERAL/scope/attachments 필드를 명시했으며 기존 결과 파일과 당시 bytes는 보존합니다. 최초 성공 suite를 재실행하지 않았습니다.

다음 원격 변환·type/lint·신규 focused 검증은 Root/bridge의 Ready 및 별도 실행 배분 신호를 기다립니다. Full public snapshot/공개 handler/실제 인증/provider/native history/HA 합격은 미확인입니다. [실제 Terminal·schema source hash](terminal-codec-pins.json)와 [원 최초 검증 결과](evidence/first-verification.md)를 구분합니다.
