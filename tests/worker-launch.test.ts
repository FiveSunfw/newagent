import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executeWorkerWithRecovery } from "../src/eval/worker-launch.js";

const testRoot = process.env.NEWAGENT_TEST_ROOT ?? path.resolve("../cache/tests");

test("restarted evaluation worker receives the same host-only credential overlay", async () => {
  mkdirSync(testRoot, { recursive: true });
  const cwd = mkdtempSync(path.join(testRoot, "worker-recovery-"));
  const resumeMarker = path.join(cwd, "resume-marker.json");
  const script = [
    "const fs = require('node:fs');",
    "const marker = process.argv[1];",
    "if (process.env.NEWAGENT_API_KEY !== 'fake-eval-key') process.exit(2);",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'checkpoint'); process.exit(69); }",
    "process.stdout.write('credential-present');",
  ].join(" ");
  let resumeNotified = false;

  const result = await executeWorkerWithRecovery({
    file: process.execPath,
    args: ["-e", script, resumeMarker],
    cwd,
    timeoutMs: 10000,
    initialLog: path.join(cwd, "initial.log"),
    resumeLog: path.join(cwd, "resume.log"),
    environment: { NEWAGENT_API_KEY: "fake-eval-key" },
    resumeExitCode: 69,
    onResume: () => {
      resumeNotified = true;
    },
  });

  assert.equal(result.initial.exitCode, 69);
  assert.equal(result.restarted, true);
  assert.equal(resumeNotified, true);
  assert.equal(result.final.exitCode, 0);
  assert.equal(result.final.stdout, "credential-present");
});
