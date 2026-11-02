import { z } from "zod";
import { createHmac, randomBytes } from "node:crypto";
export const limitsSchema = z.object({
  tools: z.number().int().positive().max(100).default(100),
  repairs: z.number().int().nonnegative().max(3).default(3),
  durationMs: z.number().int().positive().max(1800000).default(1800000),
});
export const budgetSchema = z.object({
  startedAt: z.number().nonnegative(),
  tools: z.number().int().nonnegative(),
  repairs: z.number().int().nonnegative(),
});
export type BudgetState = z.infer<typeof budgetSchema>;
function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalInput(item)]),
    );
  return value;
}
/** Logs stable, non-reversible fingerprints so failures can be counted without storing tool arguments. */
export class ToolAttemptLedger {
  private readonly key = randomBytes(32);
  private readonly attempts = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly successfulOutputs = new Map<
    string,
    { fingerprint: string; repeats: number }
  >();
  fingerprint(tool: string, input: unknown) {
    const canonical = JSON.stringify(canonicalInput(input)) ?? "undefined";
    return createHmac("sha256", this.key)
      .update(tool + "\0" + canonical)
      .digest("hex")
      .slice(0, 24);
  }
  recordAttempt(fingerprint: string) {
    const repeatNumber = (this.attempts.get(fingerprint) ?? 0) + 1;
    this.attempts.set(fingerprint, repeatNumber);
    return repeatNumber;
  }
  recordFailure(fingerprint: string) {
    const repeatNumber = (this.failures.get(fingerprint) ?? 0) + 1;
    this.failures.set(fingerprint, repeatNumber);
    return repeatNumber;
  }
  recordSuccessfulOutput(inputFingerprint: string, output: unknown) {
    const outputFingerprint = this.fingerprint("tool_output", output);
    const previous = this.successfulOutputs.get(inputFingerprint);
    const repeats =
      previous?.fingerprint === outputFingerprint ? previous.repeats + 1 : 1;
    this.successfulOutputs.set(inputFingerprint, {
      fingerprint: outputFingerprint,
      repeats,
    });
    return repeats;
  }
  failureCount(fingerprint: string) {
    return this.failures.get(fingerprint) ?? 0;
  }
  clearFailures(fingerprint: string) {
    this.failures.delete(fingerprint);
  }
}
export class HarnessError extends Error {
  constructor(
    readonly kind: "cancelled" | "timeout" | "budget" | "invalid_input",
    message: string,
  ) {
    super(message);
  }
}
/** One instance per Run; all agents and format repair share the persisted counters. */
export class RunBudget {
  readonly limits: z.infer<typeof limitsSchema>;
  private state: BudgetState;
  constructor(
    limits: unknown = {},
    state?: unknown,
    private now = Date.now,
  ) {
    this.limits = limitsSchema.parse(limits);
    this.state =
      state === undefined
        ? { startedAt: now(), tools: 0, repairs: 0 }
        : budgetSchema.parse(state);
  }
  snapshot(): BudgetState {
    return { ...this.state };
  }
  remainingMs() {
    return Math.max(
      0,
      this.limits.durationMs - (this.now() - this.state.startedAt),
    );
  }
  assertActive(signal?: AbortSignal) {
    if (signal?.aborted) throw new HarnessError("cancelled", "Run cancelled");
    if (!this.remainingMs())
      throw new HarnessError("timeout", "Run deadline exceeded");
  }
  consumeTool(signal?: AbortSignal) {
    this.assertActive(signal);
    if (this.state.tools >= this.limits.tools)
      throw new HarnessError("budget", "Run tool budget exhausted");
    this.state.tools++;
  }
  consumeRepair(signal?: AbortSignal) {
    this.assertActive(signal);
    if (this.state.repairs >= this.limits.repairs)
      throw new HarnessError("budget", "Run repair budget exhausted");
    this.state.repairs++;
  }
}
