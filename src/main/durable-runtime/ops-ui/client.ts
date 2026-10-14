import { OPS_ROUTES } from '../ops/contract.ts'
import type {
  OpsUnit, OpsUnitList, OpsUnitDetail, OpsResourceQuantity, OpsReplayPage, OpsReplayCursor,
  OpsNotification, OpsNotificationList, OpsNotificationReadResult, OpsOperation,
  OpsCommandRequest, OpsCommandAdmission, OpsNotificationReadRequest
} from '../ops/contract.ts'

/** The generated module has no embedded key or data. All helpers remain inside its closure. */
function bootOpsUi(routes: typeof OPS_ROUTES): void {
  let key = ''; let generation = 0; let controller = new AbortController()
  let cursor: OpsReplayCursor | null = null; let resetCursor: OpsReplayCursor | null = null; let units: OpsUnit[] = []
  let notifications: OpsNotification[] = []; let nextNotification: string | null = null; let operationId: string | null = null
  let operationUnitId: string | null = null; let operationInFlight = false; let uncertainCommand: { unitId: string
  operationId: string; body: string } | null = null; let detailSequence = 0
  let detailController: AbortController | null = null; const readRetries = new Map<string, string>(); const eventRows: HTMLElement[] = []
  const byId = (id: string) => { const element = document.getElementById(id)
    if (!element) { throw new Error('UI_ELEMENT_MISSING') }
    return element }
  const text = (id: string, value: string) => { byId(id).textContent = value }
  function node(tag: string, value?: string, className?: string): HTMLElement { const element = document.createElement(tag)
    if (value !== undefined) { element.textContent = value }
    if (className) { element.className = className }
    return element }
  const known = (value: string | null | undefined) => value === null || value === undefined ? '미관측' : value
  function time(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) { return '미관측' }
    return new Date(value).toLocaleString('ko-KR', { hour12: false }) }
  function memory(value: string | null): string {
    if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) { return '미관측' }
    const bytes = BigInt(value), scale = bytes >= 1073741824n ? 1073741824n : 1048576n
    return `${bytes / scale}.${(bytes % scale) * 10n / scale} ${scale === 1073741824n ? 'GiB' : 'MiB'}` }
  function resource(value: OpsResourceQuantity | null): string {
    return `CPU ${value?.cpuMilli === null || value?.cpuMilli === undefined ? '미관측' : `${value.cpuMilli} mCPU`} · RAM ${memory(value?.memoryBytes ?? null)}` }
  function fact(label: string, value: string): HTMLElement { const element = node('div', undefined, 'fact')
    element.append(node('span', label), node('strong', value)); return element }
  function status(kind: string, title: string, message: string, reload = false): void {
    byId('status-panel').hidden = kind === 'ready'; byId('status-panel').dataset.kind = kind; text('status-title', title); text('status-message', message); byId('status-reload').hidden = !reload; text('connection', kind === 'ready' || kind === 'empty' ? '연결됨' : kind === 'loading' ? '조회 중' : kind === 'auth' ? '인증 필요' : '연결 확인 필요'); byId('connection').dataset.state = kind === 'ready' || kind === 'empty' ? 'ready' : kind === 'auth' || kind === 'loading' ? kind : 'error'
  }
  function invalidateDetail(): void { detailSequence++; detailController?.abort(); detailController = null
  }
  function syncCommandControls(): void { const blocked = uncertainCommand !== null || operationInFlight
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-command="wake"]')) {
      button.disabled = blocked
      button.title = blocked ? '원 명령의 접수 결과를 확인하는 동안 새 명령은 시작할 수 없습니다.' : '명령을 접수합니다. 실제 완료 상태는 별도로 확인합니다.'
    }
    ;(byId('operation-refresh') as HTMLButtonElement).disabled = operationInFlight || (!uncertainCommand && !operationId)
  }
  function clearData(): void {
    units = []; notifications = []; cursor = null; resetCursor = null; eventRows.length = 0
    for (const id of ['unit-rows', 'unit-cards', 'notifications', 'events', 'detail-body']) { byId(id).replaceChildren() }
    for (const id of ['unit-count', 'pending-count', 'input-count', 'unknown-count']) { text(id, '미관측') }
    text('observed-at', '관측 시각 미확인'); byId('units-empty').hidden = true; text('notification-state', '아직 조회하지 않았습니다.'); text('event-state', '아직 조회하지 않았습니다.'); byId('operation-panel').hidden = true; operationId = null; operationUnitId = null; uncertainCommand = null; operationInFlight = false; readRetries.clear() }
  function disconnect(): void { generation++; controller.abort(); invalidateDetail(); controller = new AbortController(); key = ''; clearData(); byId('auth-panel').hidden = false; byId('disconnect').hidden = true
    ;(byId('reload') as HTMLButtonElement).disabled = true
    ;(byId('unit-detail') as HTMLDialogElement).close()
    status('auth', '인증이 필요합니다', '유효 키로 연결하면 운영 상태를 조회할 수 있습니다.') }
  class HttpFailure extends Error {
    constructor(readonly status: number, code: string) { super(code); this.name = 'HttpFailure' }
  }
  function responseCode(data: unknown, fallback: string): string { const candidate = data && typeof data === 'object' && 'error' in data ? data.error : null
    return candidate && typeof candidate === 'object' && 'code' in candidate && typeof candidate.code === 'string' && /^[A-Za-z0-9_]+$/.test(candidate.code) ? candidate.code : fallback }
  async function responseFailure(response: Response): Promise<HttpFailure> { const data: unknown = await response.json().catch(() => null)
    return new HttpFailure(response.status, responseCode(data, response.status === 401 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED')) }
  function confirmedRejection(error: unknown): error is HttpFailure {
    return error instanceof HttpFailure && ((error.status >= 400 && error.status < 500) || error.status === 501) }
  function errorState(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') { return }
    const code = error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED'
    if ((error instanceof HttpFailure && error.status === 401) || code === 'AUTH_REQUIRED') {
      disconnect(); text('auth-error', `인증키가 유효하지 않거나 인증이 필요합니다. 오류 코드: ${code}.`); byId('auth-error').hidden = false
    } else {
      status('error', '조회에 실패했습니다', `오류 코드: ${code}${error instanceof HttpFailure ? ` · HTTP ${error.status}` : ''}. 빈 데이터로 처리하지 않았습니다.`, true) } }
  async function api<T>(path: string, body?: string, signal = controller.signal): Promise<T> { const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    if (body !== undefined) { headers['Content-Type'] = 'application/json' }
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
    if (!response.ok) { throw await responseFailure(response) }
    return await response.json() as T }
  function after(value: OpsReplayCursor): string {
    // Browser serialization of the exact API cursor; no credential is put in the URL.
    const bytes = new TextEncoder().encode(JSON.stringify({ streamId: value.streamId, epoch: value.epoch, offset: value.offset }))
    return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
  function sum(name: keyof OpsUnit['counts']): string { let result = 0n
    for (const unit of units) { const value = unit.counts[name]
      if (!/^(0|[1-9][0-9]*)$/.test(value)) { return '미관측' }
      result += BigInt(value)
    }
    return result.toString() }
  function pod(unit: OpsUnit): string {
    return unit.observed === 'ABSENT' ? 'Pod 없음' : unit.observed === 'PRESENT_UNVERIFIED' ? 'Pod 존재 · 상태 미검증' : '미관측 / 미검증' }
  function unitFacts(unit: OpsUnit): HTMLElement { const facts = node('div', undefined, 'facts'); const attempt = unit.attempt
    facts.append(fact('논리 희망 상태 / 단계', `${unit.desiredMode} / ${unit.phase}`), fact('Pod 실제 관측', pod(unit)), fact('Pod UID', known(attempt?.podUid)), fact('저장 attempt 상태', known(attempt?.status)), fact('Node', known(attempt?.node)), fact('Spot', attempt?.spot === null || attempt?.spot === undefined ? '미관측' : attempt.spot ? 'Spot' : '일반'), fact('희망 자원', resource(unit.resources.desired)), fact('Admitted 자원', resource(unit.resources.admitted)), fact('현재 사용', resource(unit.resources.usage)), fact('관측 peak', resource(unit.resources.peak)), fact('다음 축소 시각', time(unit.resources.nextDownsizeAt)), fact('관측 시각', time(unit.observedAt)), fact('대기 묶음 / 구성 입력', `${unit.counts.pendingMessages} / ${unit.counts.inputComponents}`), fact('실행 중 / 과거 UNKNOWN', `${unit.counts.inFlight} / ${unit.counts.historicalUnknown}`))
    return facts }
  function actions(unit: OpsUnit): HTMLElement { const box = node('div'), buttons = node('div', undefined, 'unit-actions')
    for (const action of unit.availableActions) {
      if (/snapshot|checkpoint|restore|unknown/i.test(action.action)) { continue }
      const enabled = action.action === 'wake' && action.enabled; const button = node('button', action.action === 'wake' ? '깨우기 요청' : action.action) as HTMLButtonElement
      button.type = 'button'; button.disabled = !enabled || uncertainCommand !== null || operationInFlight
      const reason = action.reason ?? (enabled ? null : '현재 연결되지 않은 명령입니다.')
      button.title = reason ?? '명령을 접수합니다. 실제 완료 상태는 별도로 확인합니다.'
      if (enabled) { button.dataset.command = 'wake'; button.addEventListener('click', () => { void command(unit) }) }
      buttons.append(button)
      if (reason) { box.append(node('p', `${action.action}: ${reason}`, 'action-reason')) }
    }
    box.prepend(buttons); return box
  }
  function renderUnits(list: OpsUnitList): void {
    units = list.units
    text('unit-count', String(units.length)); text('pending-count', sum('pendingMessages')); text('input-count', sum('inputComponents')); text('unknown-count', sum('historicalUnknown')); text('observed-at', `목록 조회 시각: ${time(list.observedAt)}`); byId('unit-rows').replaceChildren(); byId('unit-cards').replaceChildren(); byId('units-empty').hidden = units.length !== 0
    for (const unit of units) { const row = node('tr'), identity = node('td', unit.alias ?? unit.id); identity.append(node('small', unit.id)); row.append(identity, node('td', `${unit.desiredMode} / ${unit.phase}`), node('td', pod(unit)), node('td', `희망 ${resource(unit.resources.desired)} / admitted ${resource(unit.resources.admitted)}`), node('td', `${unit.counts.pendingMessages} / ${unit.counts.inputComponents}`)); const cell = node('td'), button = node('button', '상세') as HTMLButtonElement
      button.type = 'button'; button.addEventListener('click', () => { void detail(unit.id) }); cell.append(button); row.append(cell); byId('unit-rows').append(row)
      const card = node('details', undefined, 'unit-card'), summary = node('summary', unit.alias ?? unit.id); summary.append(node('span', unit.desiredMode, 'badge')); card.append(summary, unitFacts(unit), actions(unit)); const more = node('button', 'Session·Tab·mount 상세') as HTMLButtonElement
      more.type = 'button'; more.addEventListener('click', () => { void detail(unit.id) }); card.append(more); byId('unit-cards').append(card)
    }
    syncCommandControls()
  }
  async function detail(id: string): Promise<void> {
    invalidateDetail()
    const current = generation, sequence = detailSequence, requestController = new AbortController()
    detailController = requestController
    const dialog = byId('unit-detail') as HTMLDialogElement; const active = () => current === generation && sequence === detailSequence && dialog.open && !requestController.signal.aborted; text('detail-title', 'Unit 상세 조회 중'); byId('detail-body').replaceChildren()
    if (!dialog.open) { dialog.showModal() }
    try { const signal = AbortSignal.any([controller.signal, requestController.signal]); const data = await api<OpsUnitDetail>(`${routes.units}/${encodeURIComponent(id)}`, undefined, signal)
      if (!active()) { return }
      text('detail-title', data.unit.alias ?? data.unit.id); const body = byId('detail-body'); body.append(unitFacts(data.unit), actions(data.unit)); syncCommandControls()
      const sections: [string, string[]][] = [
        ['Sessions', data.sessions.map(s => `${s.id} · ${s.lifecycle} · revision ${s.revision}`)],
        ['Tabs', data.tabs.map(t => `${t.id} · ${t.kind} · ${t.lifecycle} · Session ${t.sessionId ?? '없음'}`)],
        ['Mount 저장 상태', data.unit.mounts.map(m => `${m.id} · ${m.accessState} · epoch ${m.storageEpoch} · 저장 grant ${m.grant?.state ?? '없음'} · writer attempt ${m.writerAttemptId ?? '없음'}`)],
        ['최근 사건', data.recentIncidents.map(i => `${i.id} · ${i.state} · ${i.classification ?? '미분류'} · ${time(i.observedAt)}`)],
        ['Operations', data.operations.map(o => `${o.id} · ${o.disposition} · ${o.step} · ${o.reason ?? '사유 없음'}`)]
      ]
      for (const [label, rows] of sections) { const section = node('section', undefined, 'detail-section'); section.append(node('h3', label))
        for (const value of rows.length ? rows : ['저장된 항목이 없습니다.']) { section.append(node('p', value)) }
        body.append(section) }
    } catch (error) { if (active()) { text('detail-title', '상세 조회 실패'); errorState(error) } }
    finally { if (sequence === detailSequence) { detailController = null } }
  }
  function renderNotifications(): void { const list = byId('notifications'); list.replaceChildren(); text('notification-state', notifications.length ? '읽음 상태와 해결 상태를 구분합니다.' : '저장된 알림이 없습니다.'); byId('more-notifications').hidden = nextNotification === null
    for (const notification of notifications) {
      const item = node('li'); item.append(node('strong', notification.reason)); item.append(node('div', `${notification.readAt ? '읽음' : '읽지 않음'} · ${notification.state === 'RESOLVED' ? '해결됨' : '미해결'} · 재시도 ${notification.retryCount}`, 'item-meta')); item.append(node('div', `최근 ${time(notification.lastSeenAt)} · 해결 ${time(notification.resolvedAt)}`, 'item-meta')); const button = node('button', readRetries.has(notification.id) ? '같은 요청으로 읽음 확인' : '읽음 표시') as HTMLButtonElement
      button.type = 'button'; button.disabled = notification.readAt !== null && !readRetries.has(notification.id)
      button.addEventListener('click', () => { void markRead(notification, button) }); item.append(button); list.append(item)
    }
  }
  async function markRead(notification: OpsNotification, button: HTMLButtonElement): Promise<void> { const current = generation; const request: OpsNotificationReadRequest = { operationId: crypto.randomUUID(), expectedRevision: notification.revision }; const body = readRetries.get(notification.id) ?? JSON.stringify(request); readRetries.set(notification.id, body); button.disabled = true
    try { const result = await api<OpsNotificationReadResult>(`${routes.notifications}/${encodeURIComponent(notification.id)}/read`, body)
      if (current !== generation) { return }
      notifications = notifications.map(n => n.id === notification.id ? { ...n, revision: result.revision, state: result.state, readAt: result.readAt, resolvedAt: result.resolvedAt } : n)
      readRetries.delete(notification.id); renderNotifications()
    } catch (error) { if (current === generation) {
      if (confirmedRejection(error)) { readRetries.delete(notification.id) }
      renderNotifications(); errorState(error)
    } }
  }
  async function command(unit: OpsUnit): Promise<void> {
    // A different card click must never become a retry of an earlier Unit's command.
    if (uncertainCommand || operationInFlight) { return }
    const request: OpsCommandRequest = { operationId: crypto.randomUUID(), expectedRevision: unit.revision, action: 'wake', params: { expectedIntentRevision: unit.intentRevision } }
    await sendCommand({ unitId: unit.id, operationId: request.operationId, body: JSON.stringify(request) })
  }
  async function sendCommand(pending: { unitId: string; operationId: string; body: string }): Promise<void> {
    if (operationInFlight) { return }
    const current = generation; operationInFlight = true; uncertainCommand = pending; operationId = null; operationUnitId = pending.unitId; syncCommandControls(); byId('operation-panel').hidden = false; text('operation-result', `Unit ${pending.unitId} · operation ${pending.operationId} · 접수 여부를 확인 중입니다.`)
    try { const result = await api<OpsCommandAdmission>(`${routes.units}/${encodeURIComponent(pending.unitId)}/commands`, pending.body)
      if (current !== generation) { return }
      operationId = result.operationId; uncertainCommand = null; text('operation-result', `Unit ${pending.unitId} · operation ${result.operationId} · 접수됨 · ${result.receipt} · ${result.executionDisposition}. 실제 적용 완료는 아직 확인하지 않았습니다.`); text('operation-refresh', '실제 상태 확인')
    } catch (error) {
      if (current === generation) {
        if (confirmedRejection(error)) { uncertainCommand = null; text('operation-result', `Unit ${pending.unitId} · operation ${pending.operationId} · 거절됨 · HTTP ${error.status} · ${error.message}. 원 요청은 재전송하지 않습니다.`); text('operation-refresh', '상태 확인')
        } else { text('operation-result', `Unit ${pending.unitId} · operation ${pending.operationId} · 접수 결과가 불확정입니다${error instanceof HttpFailure ? ` · HTTP ${error.status} · ${error.message}` : ''}. 동일한 operation ID와 원 payload로 다시 확인할 수 있습니다.`); text('operation-refresh', '원 요청으로 접수 재확인')
        }
        errorState(error)
      }
    } finally { if (current === generation) { operationInFlight = false; syncCommandControls() } }
  }
  async function refreshOperation(): Promise<void> {
    if (operationInFlight) { return }
    // Retry uses only the preserved target/body, even after the Unit leaves the list.
    if (uncertainCommand) { await sendCommand(uncertainCommand); return }
    if (!operationId) { return }
    const current = generation, id = operationId, unitId = operationUnitId; operationInFlight = true; syncCommandControls()
    try { const value = await api<OpsOperation>(`${routes.operations}/${encodeURIComponent(id)}`)
      if (current !== generation) { return }
      const label = { queued: '대기 중', blocked: '차단 / 대기', failed: '실패', applied: '실제 적용됨', unverifiable: '미확인' }[value.disposition]; text('operation-result', `Unit ${unitId} · operation ${id} · ${label} · ${value.step} · ${value.reason ?? '사유 없음'} · revision ${value.revision}`)
    } catch (error) { if (current === generation) { errorState(error) } }
    finally { if (current === generation) { operationInFlight = false; syncCommandControls() } }
  }
  function replay(page: OpsReplayPage): boolean {
    if (page.status === 'RESET_REQUIRED') {
      resetCursor = { streamId: page.streamId, epoch: page.currentEpoch, offset: BigInt(page.minimumOffset) > 0n ? (BigInt(page.minimumOffset) - 1n).toString() : '0' }
      text('event-state', '보존 범위를 벗어났습니다. 새 범위에서 명시적으로 다시 불러오세요.')
      status('reset', '사건 범위를 다시 불러와야 합니다', '보존된 cursor 범위가 바뀌었습니다. 다시 불러오면 새 보존 범위에서 이어갑니다.', true)
      return false }
    cursor = page.nextCursor
    for (const event of page.events) { const item = node('li'), payload = event.payload; const kind = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.kind === 'string' ? payload.kind : '사건'; item.append(node('strong', kind), node('time', `${time(event.occurredAt)} · ${event.sourceEventId}`)); eventRows.push(item)
    }
    // Bounded display window only. The source journal/messages and scanned cursor are untouched.
    if (eventRows.length > 200) { eventRows.splice(0, eventRows.length - 200) }
    byId('events').replaceChildren(...eventRows); text('event-state', eventRows.length ? '최신 사건 최대 200개 · 원문은 표시하지 않습니다.' : '이 page에서 표시할 사건이 없습니다. Cursor는 계속 진행합니다.')
    return true }
  async function stream(current: number, signal: AbortSignal): Promise<void> {
    if (!cursor) { return }
    const response = await fetch(`${routes.stream}?after=${encodeURIComponent(after(cursor))}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' }, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
    if (!response.ok) { throw await responseFailure(response) }
    if (!response.body) { throw new Error('STREAM_FAILED') }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
    try {
      while (current === generation && !signal.aborted) { const { value, done } = await reader.read()
        if (done) { throw new Error('STREAM_DISCONNECTED') }
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.match(/\r?\n\r?\n/)
        while (separator?.index !== undefined) { const frame = buffer.slice(0, separator.index); buffer = buffer.slice(separator.index + separator[0].length); let name = 'message', id = '', data = ''
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) { name = line.slice(6).trimStart() }
            if (line.startsWith('id:')) { id = line.slice(3).trimStart() }
            if (line.startsWith('data:')) { data += (data ? '\n' : '') + line.slice(5).trimStart() }
          }
          if (current !== generation || signal.aborted) { return }
          if (name === 'page') { const page = JSON.parse(data) as OpsReplayPage
            if (page.status !== 'PAGE' || (id && id !== after(page.nextCursor))) { throw new Error('STREAM_CURSOR_INVALID') }
            replay(page)
          } else if (name === 'reset') { replay(JSON.parse(data) as OpsReplayPage); return }
          else if (name === 'error') { throw new HttpFailure(503, responseCode(JSON.parse(data) as unknown, 'STREAM_DATABASE_ERROR')) }
          separator = buffer.match(/\r?\n\r?\n/)
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
  async function load(): Promise<void> {
    if (!key) { return }
    generation++; const current = generation; controller.abort(); invalidateDetail(); operationInFlight = false
    controller = new AbortController(); const signal = controller.signal
    syncCommandControls()
    if (uncertainCommand) { text('operation-result', `Unit ${uncertainCommand.unitId} · operation ${uncertainCommand.operationId} · 원 요청의 접수 결과를 재확인해야 합니다.`); text('operation-refresh', '원 요청으로 접수 재확인')
    }
    status('loading', '저장된 상태를 조회합니다', '자료를 확인할 때까지 미관측 상태를 유지합니다.')
    const rangeReset = resetCursor !== null, startCursor = resetCursor ?? cursor
    try { const [list, notice, events] = await Promise.all([api<OpsUnitList>(routes.units, undefined, signal), api<OpsNotificationList>(routes.notifications, undefined, signal), api<OpsReplayPage>(routes.events + (startCursor ? `?after=${encodeURIComponent(after(startCursor))}` : ''), undefined, signal)])
      if (current !== generation) { return }
      renderUnits(list); notifications = notice.notifications; nextNotification = notice.nextAfterId; renderNotifications()
      status(units.length ? 'ready' : 'empty', '저장된 Unit이 없습니다', '연결과 조회는 정상입니다. 이 범위에 저장된 Unit이 없습니다.')
      if (rangeReset && events.status === 'PAGE') {
        // Keep old observations during reset/failure; replace them only on a new range PAGE.
        eventRows.length = 0; byId('events').replaceChildren(); resetCursor = null
      }
      if (replay(events)) {
        void stream(current, signal).catch(error => {
          if (current !== generation || signal.aborted) { return }
          if (error instanceof HttpFailure || (error instanceof Error && error.message === 'AUTH_REQUIRED')) { errorState(error); return }
          status('disconnected', '실시간 연결이 끊겼습니다', '마지막 관측 자료를 유지합니다. 다시 불러오면 저장된 cursor부터 page와 stream을 연결합니다.', true)
          text('event-state', '연결 끊김 · 마지막 cursor 보존')
        })
      }
    } catch (error) { if (current === generation && !signal.aborted) { errorState(error) } }
  }
  byId('auth-form').addEventListener('submit', event => {
    event.preventDefault(); const input = byId('access-key') as HTMLInputElement, next = input.value
    input.value = ''; disconnect(); key = next; byId('auth-error').hidden = true
    if (!key) { return }
    byId('auth-panel').hidden = true; byId('disconnect').hidden = false
    ;(byId('reload') as HTMLButtonElement).disabled = false; void load()
  })
  byId('disconnect').addEventListener('click', disconnect)
  for (const id of ['reload', 'status-reload']) { byId(id).addEventListener('click', () => { void load() }) }
  byId('close-detail').addEventListener('click', () => { invalidateDetail(); (byId('unit-detail') as HTMLDialogElement).close() }); byId('unit-detail').addEventListener('cancel', invalidateDetail); byId('unit-detail').addEventListener('close', () => { if (!(byId('unit-detail') as HTMLDialogElement).open) { invalidateDetail() } }); byId('operation-refresh').addEventListener('click', () => { void refreshOperation() })
  byId('more-notifications').addEventListener('click', () => {
    if (!nextNotification) { return }
    const current = generation
    void api<OpsNotificationList>(`${routes.notifications}?after=${encodeURIComponent(nextNotification)}`).then(page => {
      if (current !== generation) { return }
      const ids = new Set(notifications.map(n => n.id)); notifications.push(...page.notifications.filter(n => !ids.has(n.id))); nextNotification = page.nextAfterId; renderNotifications()
    }).catch(error => { if (current === generation) { errorState(error) } })
  })
  window.addEventListener('pagehide', () => { generation++; controller.abort(); invalidateDetail(); key = '' }, { once: true })
}

export const opsUiClientSource = `(${bootOpsUi.toString()})(${JSON.stringify(OPS_ROUTES)});`
