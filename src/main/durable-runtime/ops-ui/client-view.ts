import type { OpsUnit, OpsUnitList, OpsResourceQuantity } from '../ops/contract.ts'

/** Self-contained because this factory is serialized into the browser module. */
export function createOpsUiPresentation(callbacks: {
  onCommand: (unit: OpsUnit) => void
  onDetail: (id: string) => void
  isCommandBlocked: () => boolean
}) {
  const { onCommand, onDetail, isCommandBlocked } = callbacks
  let units: OpsUnit[] = []
  const byId = (id: string) => {
    const element = document.getElementById(id)
    if (!element) { throw new Error('UI_ELEMENT_MISSING') }
    return element
  }
  const text = (id: string, value: string) => { byId(id).textContent = value }
  function node(tag: string, value?: string, className?: string): HTMLElement {
    const element = document.createElement(tag)
    if (value !== undefined) { element.textContent = value }
    if (className) { element.className = className }
    return element
  }
  const known = (value: string | null | undefined) => value === null || value === undefined ? '미관측' : value
  function time(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) { return '미관측' }
    return new Date(value).toLocaleString('ko-KR', { hour12: false })
  }
  function memory(value: string | null): string {
    if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) { return '미관측' }
    const bytes = BigInt(value), scale = bytes >= 1073741824n ? 1073741824n : 1048576n
    return `${bytes / scale}.${(bytes % scale) * 10n / scale} ${scale === 1073741824n ? 'GiB' : 'MiB'}`
  }
  function resource(value: OpsResourceQuantity | null): string {
    return `CPU ${value?.cpuMilli === null || value?.cpuMilli === undefined ? '미관측' : `${value.cpuMilli} mCPU`} · RAM ${memory(value?.memoryBytes ?? null)}`
  }
  function fact(label: string, value: string): HTMLElement {
    const element = node('div', undefined, 'fact')
    element.append(node('span', label), node('strong', value)); return element
  }
  function status(kind: string, title: string, message: string, reload = false): void {
    byId('status-panel').hidden = kind === 'ready'
    byId('status-panel').dataset.kind = kind
    text('status-title', title); text('status-message', message)
    byId('status-reload').hidden = !reload
    text('connection', kind === 'ready' || kind === 'empty' ? '연결됨' : kind === 'loading' ? '조회 중' : kind === 'auth' ? '인증 필요' : '연결 확인 필요')
    byId('connection').dataset.state = kind === 'ready' || kind === 'empty' ? 'ready' : kind === 'auth' || kind === 'loading' ? kind : 'error'
  }
  function sum(name: keyof OpsUnit['counts']): string {
    let result = 0n
    for (const unit of units) {
      const value = unit.counts[name]
      if (!/^(0|[1-9][0-9]*)$/.test(value)) { return '미관측' }
      result += BigInt(value)
    }
    return result.toString()
  }
  function pod(unit: OpsUnit): string {
    return unit.observed === 'ABSENT' ? 'Pod 없음' : unit.observed === 'PRESENT_UNVERIFIED' ? 'Pod 존재 · 상태 미검증' : '미관측 / 미검증'
  }
  function unitFacts(unit: OpsUnit): HTMLElement {
    const facts = node('div', undefined, 'facts')
    const attempt = unit.attempt
    facts.append(fact('논리 희망 상태 / 단계', `${unit.desiredMode} / ${unit.phase}`), fact('Pod 실제 관측', pod(unit)), fact('Pod UID', known(attempt?.podUid)), fact('저장 attempt 상태', known(attempt?.status)), fact('Node', known(attempt?.node)), fact('Spot', attempt?.spot === null || attempt?.spot === undefined ? '미관측' : attempt.spot ? 'Spot' : '일반'), fact('희망 자원', resource(unit.resources.desired)), fact('Admitted 자원', resource(unit.resources.admitted)), fact('현재 사용', resource(unit.resources.usage)), fact('관측 peak', resource(unit.resources.peak)), fact('다음 축소 시각', time(unit.resources.nextDownsizeAt)), fact('관측 시각', time(unit.observedAt)), fact('대기 묶음 / 구성 입력', `${unit.counts.pendingMessages} / ${unit.counts.inputComponents}`), fact('실행 중 / 과거 UNKNOWN', `${unit.counts.inFlight} / ${unit.counts.historicalUnknown}`))
    return facts
  }
  function actions(unit: OpsUnit): HTMLElement {
    const box = node('div'), buttons = node('div', undefined, 'unit-actions')
    for (const action of unit.availableActions) {
      if (/snapshot|checkpoint|restore|unknown/i.test(action.action)) { continue }
      const enabled = action.action === 'wake' && action.enabled
      const button = node('button', action.action === 'wake' ? '깨우기 요청' : action.action) as HTMLButtonElement
      button.type = 'button'; button.disabled = !enabled || isCommandBlocked()
      const reason = action.reason ?? (enabled ? null : '현재 연결되지 않은 명령입니다.')
      button.title = reason ?? '명령을 접수합니다. 실제 완료 상태는 별도로 확인합니다.'
      if (enabled) { button.dataset.command = 'wake'; button.addEventListener('click', () => { onCommand(unit) }) }
      buttons.append(button)
      if (reason) { box.append(node('p', `${action.action}: ${reason}`, 'action-reason')) }
    }
    box.prepend(buttons); return box
  }
  function renderUnits(list: OpsUnitList): void {
    units = list.units
    text('unit-count', String(units.length)); text('pending-count', sum('pendingMessages')); text('input-count', sum('inputComponents')); text('unknown-count', sum('historicalUnknown'))
    text('observed-at', `목록 조회 시각: ${time(list.observedAt)}`)
    byId('unit-rows').replaceChildren(); byId('unit-cards').replaceChildren(); byId('units-empty').hidden = units.length !== 0
    for (const unit of units) {
      const row = node('tr'), identity = node('td', unit.alias ?? unit.id)
      identity.append(node('small', unit.id)); row.append(identity, node('td', `${unit.desiredMode} / ${unit.phase}`), node('td', pod(unit)), node('td', `희망 ${resource(unit.resources.desired)} / admitted ${resource(unit.resources.admitted)}`), node('td', `${unit.counts.pendingMessages} / ${unit.counts.inputComponents}`))
      const cell = node('td'), button = node('button', '상세') as HTMLButtonElement
      button.type = 'button'; button.addEventListener('click', () => { onDetail(unit.id) }); cell.append(button); row.append(cell); byId('unit-rows').append(row)
      const card = node('details', undefined, 'unit-card'), summary = node('summary', unit.alias ?? unit.id)
      summary.append(node('span', unit.desiredMode, 'badge')); card.append(summary, unitFacts(unit), actions(unit))
      const more = node('button', 'Session·Tab·mount 상세') as HTMLButtonElement
      more.type = 'button'; more.addEventListener('click', () => { onDetail(unit.id) }); card.append(more); byId('unit-cards').append(card)
    }
  }
  return { byId, text, node, time, status, unitFacts, actions, renderUnits }
}
