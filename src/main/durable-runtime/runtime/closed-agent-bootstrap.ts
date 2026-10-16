/** Internal closed idle argv only; no provider entrypoint or execution authority. */
export const CLOSED_AGENT_BOOTSTRAP = Object.freeze({
  command: Object.freeze(['/usr/local/bin/node'] as const),
  args: Object.freeze(['-e', 'setInterval(() => {}, 3600000)'] as const),
  workingDir: '/tmp' as const,
  checkoutAnnotation: 'orca.dev/checkout-path' as const,
})

export function isClosedAgentBootstrap(entrypoint: Readonly<{
  command: readonly unknown[]; args: readonly unknown[]
}>): boolean {
  return entrypoint.command.length === CLOSED_AGENT_BOOTSTRAP.command.length &&
    entrypoint.args.length === CLOSED_AGENT_BOOTSTRAP.args.length &&
    entrypoint.command.every((value, index) => value === CLOSED_AGENT_BOOTSTRAP.command[index]) &&
    entrypoint.args.every((value, index) => value === CLOSED_AGENT_BOOTSTRAP.args[index])
}
