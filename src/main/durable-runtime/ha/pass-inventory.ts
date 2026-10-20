import type { ControllerPassRequest } from './pass.ts'

export function snapshotInventory(caller: ControllerPassRequest['inventory']): ControllerPassRequest['inventory'] {
  if (!caller) {return undefined}
  const transport = caller.transport
  // Method references and their original receivers are fixed now. The actual
  // AbortSignal is still supplied at invocation; transport state is not frozen.
  return Object.freeze({ sink: caller.sink.bind(caller), transport: Object.freeze({
    list: transport.list.bind(transport), watch: transport.watch.bind(transport), get: transport.get.bind(transport)
  }) })
}

