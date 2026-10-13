import type { StorageEvidenceAuthority } from './evidence.ts';
// Compile-only negative contract tests. No runtime proof factory.
// @ts-expect-error Async collection cannot be injected as the local directory accessor.
const asyncDirectory: StorageEvidenceAuthority['directory'] = async () => null;
// @ts-expect-error Promise-valued pin validity must not be truthy evidence in a tx.
const asyncPin: StorageEvidenceAuthority['directoryPinValid'] = async () => true;
// @ts-expect-error Cloud I/O cannot be injected as the local stop accessor.
const asyncStop: StorageEvidenceAuthority['permanentComputeStop'] = async () => null;
void asyncDirectory; void asyncPin; void asyncStop;
