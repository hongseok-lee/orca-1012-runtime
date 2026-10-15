import * as https from 'node:https'
import type {
  CapturedComputeIdentityConfiguration, ComputeInstanceIdentityConfiguration,
  ComputeInstanceIdentityInput
} from './compute-instance-identity-types'

function exactFormat(value: string, pattern: RegExp): boolean {
  // JS $ may match before a final newline; require the match to cover the entire string.
  return pattern.exec(value)?.[0] === value
}

/** Canonical positive uint64 decimal; never coerced through JS Number. */
export function isComputeNumericInstanceId(value: unknown): value is string {
  return typeof value === 'string' && exactFormat(value, /^[1-9][0-9]{0,19}$/) &&
    (value.length < 20 || value <= '18446744073709551615')
}

export function snapshotComputeIdentityConfiguration(
  config: ComputeInstanceIdentityConfiguration
): CapturedComputeIdentityConfiguration | null {
  try {
    const projectId = config.projectId
    const timeoutMs = config.timeoutMs
    const supplier = config.readAccessToken
    const transport = config.https ?? https
    const request = transport.request
    // General current GCP project IDs only. Legacy domain-scoped IDs are unsupported.
    if (typeof projectId !== 'string' || !exactFormat(projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
        typeof supplier !== 'function' || typeof request !== 'function') {
      return null
    }
    return Object.freeze({ projectId, timeoutMs,
      readAccessToken: supplier.bind(config), request: request.bind(transport) })
  } catch {
    return null
  }
}

export function snapshotComputeIdentityInput(
  input: ComputeInstanceIdentityInput
): ComputeInstanceIdentityInput | null {
  try {
    const zone = input.zone
    const instanceName = input.instanceName
    const expectedNumericInstanceId = input.expectedNumericInstanceId
    if (typeof zone !== 'string' || !exactFormat(zone, /^[a-z][a-z0-9-]{0,60}-[a-z]$/) ||
        typeof instanceName !== 'string' || !exactFormat(instanceName, /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/) ||
        !isComputeNumericInstanceId(expectedNumericInstanceId)) {
      return null
    }
    return Object.freeze({ zone, instanceName, expectedNumericInstanceId })
  } catch {
    return null
  }
}

export function computeInstancePath(projectId: string, input: ComputeInstanceIdentityInput): string {
  return `compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(input.zone)}` +
    `/instances/${encodeURIComponent(input.instanceName)}`
}

export function computeCanonicalUrl(value: string, path: string): boolean {
  // Exact equality rejects credentials, ports, query, fragment, encoded separators and suffixes.
  return value === `https://www.googleapis.com/${path}` ||
    value === `https://compute.googleapis.com/${path}`
}
