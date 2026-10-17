/** Clone before any I/O; callers cannot mutate an in-flight binding/hash/payload tuple. */
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}
