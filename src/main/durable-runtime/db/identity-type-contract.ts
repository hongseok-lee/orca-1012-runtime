import type {
  ControllerTerm,
  ExecutionEpoch,
  SessionFence,
  StorageEpoch,
} from "../../../shared/durable-runtime/identity.ts";

type Distinct<Left, Right> = Left extends Right ? never : true;

export const independentEpochTypes: readonly [
  Distinct<SessionFence, ExecutionEpoch>,
  Distinct<ExecutionEpoch, ControllerTerm>,
  Distinct<ControllerTerm, StorageEpoch>,
  Distinct<StorageEpoch, SessionFence>,
] = [true, true, true, true];
