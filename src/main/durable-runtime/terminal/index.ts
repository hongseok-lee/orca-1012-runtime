export * from './types'
export { snapshotUnaryTerminalIngress, classifyTerminalIngress,
  isConfirmedTerminalDraftClear } from './ingress'
export { snapshotBinaryTerminalIngress } from './binary-ingress'
export type { TerminalBinaryIngress } from './binary-ingress'
export { emptyTerminalDraft, sameTerminalDraftBinding, reduceTerminalDraft } from './draft-reducer'
