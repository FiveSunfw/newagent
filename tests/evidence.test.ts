import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verificationFingerprint } from "../src/exec/evidence.js";
test("evidence changes with uncommitted source, check config and environment", () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "evidence-"));
  writeFileSync(path.join(root, "a.ts"), "export const a = 1");
  const env = { mode: "docker", image: "sha256:a", boundaryVersion: "1" };
  const checks = [{ file: "node", args: ["test.js"] }];
  const initial = verificationFingerprint(root, checks, env);
  assert.equal(
    initial,
    verificationFingerprint(root, checks, {
      boundaryVersion: "1",
      image: "sha256:a",
      mode: "docker",
    }),
  );
  assert.notEqual(
    initial,
    verificationFingerprint(root, [{ file: "node", args: ["other.js"] }], env),
  );
  assert.notEqual(
    initial,
    verificationFingerprint(root, checks, { ...env, image: "sha256:b" }),
  );
  writeFileSync(path.join(root, "a.ts"), "export const a = 2");
  assert.notEqual(initial, verificationFingerprint(root, checks, env));
});
