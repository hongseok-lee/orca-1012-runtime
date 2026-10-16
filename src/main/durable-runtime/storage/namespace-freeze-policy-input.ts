export type NamespaceFreezeResource = Readonly<{ name: string; uid: string }>;
export type NamespaceFreezePolicyInput = Readonly<{
  namespace: string; dataset: string;
  deployment: NamespaceFreezeResource; replicaSet: NamespaceFreezeResource;
  backingPvc: NamespaceFreezeResource;
  backingPv: NamespaceFreezeResource & Readonly<{ csiDriver: string; volumeHandle: string }>;
  service: NamespaceFreezeResource & Readonly<{ selector: Readonly<Record<string, string>> }>;
  helperConfigMap: NamespaceFreezeResource & Readonly<{ sha256: string }>;
  exportsConfigMap: NamespaceFreezeResource & Readonly<{ sha256: string }>;
  ingressNetworkPolicy: NamespaceFreezeResource;
  podNamePrefix: string; container: "unfs3";
  recoveryUsernames: readonly string[]; endpointUsernames: readonly string[];
  collectorUsernames: readonly string[];
}>;

export class NamespaceFreezePolicyError extends Error {
  readonly code = "NAMESPACE_FREEZE_CONFIG_INVALID";
  constructor() { super("NAMESPACE_FREEZE_CONFIG_INVALID"); this.name = "NamespaceFreezePolicyError"; }
}
function invalid(): never { throw new NamespaceFreezePolicyError(); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) { invalid(); }
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") { invalid(); }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property)) { invalid(); }
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) { invalid(); }
  return result;
}
function string(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !pattern.test(value)) { invalid(); }
  return value;
}
function label(value: unknown): string { return string(value, /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/, 63); }
function name(value: unknown): string {
  const result = string(value, /^[a-z0-9.-]+$/, 253);
  for (const part of result.split(".")) { label(part); }
  return result;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function identity(value: Record<string, unknown>): NamespaceFreezeResource {
  return Object.freeze({ name: name(value.name), uid: string(value.uid, uuid, 36) });
}
function resource(value: unknown): NamespaceFreezeResource { return identity(shape(value, ["name", "uid"])); }
function hash(value: unknown): string { return string(value, /^[0-9a-f]{64}$/, 64); }
function configMap(value: unknown): NamespaceFreezePolicyInput["helperConfigMap"] {
  const input = shape(value, ["name", "uid", "sha256"]);
  return Object.freeze({ ...identity(input), sha256: hash(input.sha256) });
}
function usernames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) { invalid(); }
  const result = Array.from(value, item => string(item, /^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/, 253));
  if (new Set(result).size !== result.length) { invalid(); }
  return Object.freeze(result.sort());
}
function selector(value: unknown): Readonly<Record<string, string>> {
  const entries = Object.entries(record(value));
  if (entries.length === 0) { invalid(); }
  const captured = entries.map(([key, item]) => {
    const parts = key.split("/");
    if (parts.length > 2) { invalid(); }
    if (parts.length === 2) { name(parts[0]); }
    string(parts[parts.length - 1], /^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/, 63);
    if (typeof item !== "string" || item.length > 63 ||
        (item !== "" && !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(item))) { invalid(); }
    return [key, item];
  });
  captured.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return Object.freeze(Object.fromEntries(captured));
}
/** Capture only data properties. No credential, installed/qualified flag, or inferred actor. */
export function captureNamespaceFreezePolicyInput(value: unknown): NamespaceFreezePolicyInput {
  try {
    const input = shape(value, ["namespace", "dataset", "deployment", "replicaSet", "backingPvc", "backingPv",
      "service", "helperConfigMap", "exportsConfigMap", "ingressNetworkPolicy", "podNamePrefix", "container",
      "recoveryUsernames", "endpointUsernames", "collectorUsernames"]);
    const pv = shape(input.backingPv, ["name", "uid", "csiDriver", "volumeHandle"]);
    const service = shape(input.service, ["name", "uid", "selector"]);
    const replicaSet = resource(input.replicaSet), prefix = input.podNamePrefix;
    if (prefix !== `${replicaSet.name}-` || input.container !== "unfs3" ||
        typeof prefix !== "string" || prefix.length > 248) { invalid(); }
    const recoveryUsernames = usernames(input.recoveryUsernames), endpointUsernames = usernames(input.endpointUsernames);
    const collectorUsernames = usernames(input.collectorUsernames);
    if (collectorUsernames.some(actor => recoveryUsernames.includes(actor) || endpointUsernames.includes(actor))) { invalid(); }
    const helperConfigMap = configMap(input.helperConfigMap), exportsConfigMap = configMap(input.exportsConfigMap);
    if (helperConfigMap.name === exportsConfigMap.name || helperConfigMap.uid === exportsConfigMap.uid) { invalid(); }
    return Object.freeze({ namespace: label(input.namespace), dataset: label(input.dataset),
      deployment: resource(input.deployment), replicaSet, backingPvc: resource(input.backingPvc),
      backingPv: Object.freeze({ ...identity(pv), csiDriver: name(pv.csiDriver),
        volumeHandle: string(pv.volumeHandle, /^[A-Za-z0-9][A-Za-z0-9/:._-]*$/, 512) }),
      service: Object.freeze({ ...identity(service), selector: selector(service.selector) }),
      helperConfigMap, exportsConfigMap, ingressNetworkPolicy: resource(input.ingressNetworkPolicy),
      podNamePrefix: prefix, container: "unfs3", recoveryUsernames, endpointUsernames, collectorUsernames });
  } catch { throw new NamespaceFreezePolicyError(); }
}
