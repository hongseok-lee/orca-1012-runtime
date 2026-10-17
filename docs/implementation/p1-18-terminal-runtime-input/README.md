# Terminal 입력 실행 연결 근거

현재 제품 source는 `f3c4b17275130c79e8ba224f44e6b50accbdc1f7`다. `70ce961f`의 원 근거는 이력으로 보존한다. 기존 PR156의 공개 접수/모드 변경 source를 보존하고 후속 실행 coordinator를 별도로 추가했다. `INPUT_DELIVERY` operation과 원 component/receipt를 연결하며 stage COMMIT, claim COMMIT, 실제 owned protection permit, 같은 ready driver 순서를 사용한다.

최초 PG callback은 `58abab80`에서 정상 접수 후 socket close/UI 변경, 원 delivery admission/completion, receipt 중복 방지, UNKNOWN 재전송 방지 assertion을 지난 뒤 마지막 fixture의 CLOSED/closed_at 제약 누락으로 exit 1이었다. 원 TAP를 보존했다. `70ce961f`는 fixture의 close timestamp를 교정하고 마지막 명시 close 경계만 실행해 exit 0이었다. 앞선 성공 구간을 재실행하지 않았으며 두 결과를 전체 callback 한 번의 성공으로 합치지 않는다. 제품 6개 파일의 bytes/mode는 두 pin 사이 불변이다.

각 bundle의 실제 입력 216개와 고정 Git bytes/size, bundle/metafile hash를 guard 전에 대조했다. 전용 PG DB의 OID 80991/system 7696101282789175327/SQL ledger 19와 모든 기존 행을 보존했다. 최초 owned7 lint의 서식 진단은 원본을 보존하고 바뀐 3개 파일, 이후 바뀐 fixture 1개만 확인했다. 타입/기존 suite/schema/build는 실행하지 않았다.

관측은 실제 production driver/parser/저장 경로와 합성 native transport/socket/controller/protection을 사용한다. 실제 provider 인증·Agent 실행·전체 기능/UI/native iPhone/HA 합격 근거가 아니다. 첨부 materialization은 이 최초 text 입력 연결에 포함하지 않으며 attachment 입력을 조용히 생략하지 않고 원 입력을 보존한다. 자동 UNKNOWN 재전송·새 owner 채택·structured alias 생성은 하지 않는다.

공용 bootstrap/public 합류와 실제 한 Session의 공개 접수/전달/출력은 Backend/출력 담당과 후속 연결 중이다. 신규 screenshot을 꾸며 넣지 않았으며 아직 해당 source의 실제 앱 화면은 검증하지 않았다. 실행 시 usage limit/credits/stream 오류는 미관측이다.

Root 리뷰의 세 결손을 `f3c4b172`에서 교정했다. 실제 원 turn의 terminal 관측 COMMIT 뒤 다음 pending Message를 전달하며 admission으로 실행 슬롯을 해제하지 않는다. Session/Unit 잠금 아래 원 Message의 현재 eligible revision을 seal하고 같은 merged Message의 여러 receipt를 중복 stage하지 않는다. Native callback에 진입하지 않은 permit 거절은 실제 transport exit의 UNKNOWN 대상에서 제외한다. 새 QUEUED_MERGED_ONLY callback은 변경 4개 파일 lint 뒤 PASS였고 기존 성공 경계를 반복하지 않았다. 실제 입력 216개 중 수락된 213개 pin을 재사용하고 소유 입력 delta 3개만 Git bytes로 대조했으며 불일치 0이었다. 원행과 SQL ledger는 보존됐다.
