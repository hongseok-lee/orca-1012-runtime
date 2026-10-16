import assert from "node:assert/strict";
import test from "node:test";
import { createNamespaceFreezePolicyBundle, NamespaceFreezePolicyError } from "./namespace-freeze-policy.ts";
import { celLiteral } from "./namespace-freeze-policy-cel.ts";
import { managedLeafInspectCommand, managedLeafExecUrl } from "./managed-leaf-collector-exec.ts";
import { namespaceFreezeExample, namespaceFreezeRequestCases, namespaceFreezeFixtureStatus,
  exampleInspectArgv, examplePodUid, exampleLeafId } from "./namespace-freeze-policy-fixtures.mts";

// Source-only preparation: Root must allocate the first invocation separately.
if (process.env.ORCA_NAMESPACE_FREEZE_POLICY_APPROVED !== "root-ready") {
  throw new Error("NAMESPACE_FREEZE_POLICY_FIXTURE_NOT_APPROVED");
}
test("unqualified namespace guard generation and API request data (not CEL enforcement)", async t => {
  const input = namespaceFreezeExample;
  await t.test("deterministic output, stable sorted inputs, Deny/Fail and exact namespace only", () => {
    const first = createNamespaceFreezePolicyBundle(input);
    const second = createNamespaceFreezePolicyBundle({ ...input,
      service: { ...input.service, selector: Object.fromEntries(Object.entries(input.service.selector).reverse()) } });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.kind, "UNQUALIFIED_NAMESPACE_GUARD_BUNDLE");
    assert.equal(first.enforcementVerified, false); assert.equal(first.physicalPinIssued, false);
    for (const policy of first.policies) {
      assert.equal(policy.spec.failurePolicy, "Fail");
      assert.deepEqual(policy.spec.matchConditions, [{ name: "exact-namespace", expression: `request.namespace == ${JSON.stringify(input.namespace)}` }]);
      assert.equal(policy.spec.matchConstraints.matchPolicy, "Exact");
      assert.equal("objectSelector" in policy.spec.matchConstraints, false);
      assert.equal("paramKind" in policy.spec, false);
    }
    assert.equal(first.policies.length, first.bindings.length);
    for (const binding of first.bindings) {
      assert.deepEqual(binding.spec.validationActions, ["Deny"]);
      assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, { "kubernetes.io/metadata.name": input.namespace });
    }
  });
  await t.test("invalid identity, empty selectors, alias actor lists and secret/qualification fields fail closed", () => {
    for (const value of [null, {}, { ...input, namespace: "bad/namespace" },
      { ...input, dataset: "bad\nvalue" }, { ...input, deployment: { ...input.deployment, uid: "not-a-uid" } },
      { ...input, helperConfigMap: { ...input.helperConfigMap, sha256: "invalid" } },
      { ...input, service: { ...input.service, selector: {} } },
      { ...input, service: { ...input.service, selector: { 'x" || true || "': "value" } } },
      { ...input, podNamePrefix: "nfs-" }, { ...input, container: "other" },
      { ...input, recoveryUsernames: [] }, { ...input, collectorUsernames: ["same", "same"] },
      { ...input, collectorUsernames: input.recoveryUsernames },
      { ...input, endpointUsernames: ['actor" || true || "'] },
      { ...input, credential: "synthetic-unexpected-field" }, { ...input, enforcementVerified: true },
    ]) { assert.throws(() => createNamespaceFreezePolicyBundle(value), NamespaceFreezePolicyError); }
    let touched = false;
    const accessor = Object.defineProperty({ ...input }, "namespace", { enumerable: true,
      get() { touched = true; throw new Error("raw-untrusted-input"); } });
    assert.throws(() => createNamespaceFreezePolicyBundle(accessor), NamespaceFreezePolicyError);
    assert.equal(touched, false);
  });
  await t.test("CEL literals retain injection bytes as quoted data, never caller expressions", () => {
    const injection = '\" || true || \"\\\n';
    assert.equal(celLiteral(injection), JSON.stringify(injection));
    assert.equal(JSON.parse(celLiteral(injection)), injection);
    const bundle = createNamespaceFreezePolicyBundle(input);
    const inspectExpression = bundle.policies.find(item => item.metadata.name.endsWith("-exec"))?.spec.validations[0].expression;
    assert.ok(inspectExpression?.includes(JSON.stringify(managedLeafInspectCommand)));
  });
  await t.test("argv fixture is the existing managedLeafExecUrl source contract", () => {
    const url = managedLeafExecUrl({ apiOrigin: "https://synthetic.invalid", namespace: input.namespace,
      podName: `${input.podNamePrefix}abcde`, podUid: examplePodUid, containerName: input.container,
      dataset: input.dataset, helperSha256: input.helperConfigMap.sha256, exportsSha256: input.exportsConfigMap.sha256,
      ca: new Uint8Array([1]), readReviewerBearer: () => { throw new Error("CREDENTIAL_MUST_NOT_BE_READ"); },
      clusterIdentityRef: "synthetic-cluster", backendId: "synthetic-backend", exportId: "synthetic-export",
      imageDigest: `sha256:${"c".repeat(64)}`, pvcName: input.backingPvc.name, pvcUid: input.backingPvc.uid,
      pvName: input.backingPv.name, pvUid: input.backingPv.uid, csiDriver: input.backingPv.csiDriver,
      volumeHandle: input.backingPv.volumeHandle, helperConfigMapName: input.helperConfigMap.name,
      helperConfigMapUid: input.helperConfigMap.uid, timeoutMs: 1 }, exampleLeafId);
    assert.deepEqual(url.searchParams.getAll("command"), exampleInspectArgv);
    assert.equal(url.searchParams.get("stdin"), "false"); assert.equal(url.searchParams.get("tty"), "false");
    assert.equal(url.searchParams.get("stdout"), "true"); assert.equal(url.searchParams.get("stderr"), "true");
  });
  await t.test("API cases remain unevaluated synthetic evidence", () => {
    assert.equal(namespaceFreezeFixtureStatus.evaluation, "NOT_EXECUTED");
    assert.equal(namespaceFreezeFixtureStatus.actualControllerUsernamesConfirmed, false);
    assert.equal(namespaceFreezeFixtureStatus.admissionEnforcementVerified, false);
    assert.equal(new Set(namespaceFreezeRequestCases.map(item => item.id)).size, namespaceFreezeRequestCases.length);
    assert.ok(namespaceFreezeRequestCases.some(item => item.id === "selector-only-forgery"));
    assert.ok(namespaceFreezeRequestCases.some(item => item.id === "endpointslice-label-removal"));
    // Expected decisions are not evaluated here: a real API/CEL qualification is separate.
  });
});
