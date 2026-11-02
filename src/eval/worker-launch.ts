import { execute, type Execution } from "../exec/execution.js";

export interface WorkerRecoveryExecution {
  initial: Execution;
  final: Execution;
  restarted: boolean;
}

export async function executeWorkerWithRecovery(input: {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  initialLog: string;
  resumeLog: string;
  environment: Record<string, string>;
  resumeExitCode?: number;
  onResume?: () => void;
}): Promise<WorkerRecoveryExecution> {
  const initial = await execute(
    input.file,
    input.args,
    input.cwd,
    undefined,
    input.timeoutMs,
    input.initialLog,
    input.environment,
  );
  if (
    input.resumeExitCode === undefined ||
    initial.exitCode !== input.resumeExitCode
  )
    return { initial, final: initial, restarted: false };

  input.onResume?.();
  const final = await execute(
    input.file,
    input.args,
    input.cwd,
    undefined,
    input.timeoutMs,
    input.resumeLog,
    input.environment,
  );
  return { initial, final, restarted: true };
}
