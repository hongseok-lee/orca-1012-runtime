import type { recordUnitIntent } from '../lifecycle/intent.ts'
import type { reserveSleep } from '../lifecycle/sleep.ts'
import type { recordInputCancel } from '../input/cancel.ts'

/** Exact owner API types. Runtime selects pinned implementations after root integration. */
export type CatalogOwnerEntries = {
  readonly recordUnitIntent: typeof recordUnitIntent
  readonly reserveSleep: typeof reserveSleep
  readonly recordInputCancel: typeof recordInputCancel
}

export const catalogOwnerPins = Object.freeze({
  database: '521a9ba96393a4d4383e5b6f42ceb234dff15d97',
  cancel: 'a1f44e80d6a6d90655b765fbbeaad359841dcf18',
  sleep: '4db2bff75e9c61bc606f44d07ba2c70d30c94a55',
  lifecycleCore: '4c516670a0fb8fc7204150a12863e15d758886d7'
})
