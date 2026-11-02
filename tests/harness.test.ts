import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RunBudget,
  HarnessError,
  ToolAttemptLedger,
} from "../src/core/harness.js";
test("budget is cumulative across roles and restart and refuses tool 101", () => {
  const first = new RunBudget({}, undefined, () => 1000);
  for (let i = 0; i < 60; i++) first.consumeTool();
  const resumed = new RunBudget({}, first.snapshot(), () => 1100);
  for (let i = 0; i < 40; i++) resumed.consumeTool();
  assert.throws(
    () => resumed.consumeTool(),
    (e: unknown) => e instanceof HarnessError && e.kind === "budget",
  );
  assert.equal(resumed.snapshot().tools, 100);
});
test("restored deadline, repair cap and cancellation remain effective", () => {
  let now = 10;
  const budget = new RunBudget({ durationMs: 100 }, undefined, () => now);
  for (let i = 0; i < 3; i++) budget.consumeRepair();
  assert.throws(() => budget.consumeRepair(), /repair budget/);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => budget.consumeTool(controller.signal), /cancelled/);
  now = 110;
  assert.throws(
    () =>
      new RunBudget(
        { durationMs: 100 },
        budget.snapshot(),
        () => now,
      ).consumeTool(),
    /deadline/,
  );
});
test("tool attempt telemetry identifies exact retries without retaining arguments", () => {
  const ledger = new ToolAttemptLedger();
  const first = ledger.fingerprint("replace_text", {
    path: "src/index.ts",
    before: "const x = 1;",
    after: "const x = 2;",
  });
  const reordered = ledger.fingerprint("replace_text", {
    after: "const x = 2;",
    before: "const x = 1;",
    path: "src/index.ts",
  });
  const other = ledger.fingerprint("replace_text", {
    path: "src/index.ts",
    before: "const x = 3;",
    after: "const x = 4;",
  });
  assert.equal(first, reordered);
  assert.notEqual(first, other);
  assert.equal(ledger.recordAttempt(first), 1);
  assert.equal(ledger.recordAttempt(reordered), 2);
  assert.equal(ledger.recordFailure(first), 1);
  assert.equal(ledger.recordFailure(reordered), 2);
  ledger.clearFailures(first);
  assert.equal(ledger.recordFailure(first), 1);
  assert.equal(
    ledger.recordSuccessfulOutput(first, { text: "same result" }),
    1,
  );
  assert.equal(
    ledger.recordSuccessfulOutput(reordered, { text: "same result" }),
    2,
  );
  assert.equal(ledger.recordSuccessfulOutput(first, { text: "new result" }), 1);
});
