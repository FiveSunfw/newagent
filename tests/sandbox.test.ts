import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { Sandbox, type Driver } from "../src/exec/sandbox.js";
import { createSnapshot } from "../src/exec/snapshot.js";
import { execute } from "../src/exec/execution.js";
test("streamed Chinese output survives chunk boundaries", async () => {
  const result = await execute(
    process.execPath,
    ["-e", "process.stdout.write('汉字'.repeat(40000))"],
    process.cwd(),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "汉字".repeat(40000));
});
const image = `sha256:${"a".repeat(64)}`;
test("snapshot rejects a junction escaping to fake credentials", () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "junction-"));
  const source = path.join(root, "source"),
    outside = path.join(root, "outside");
  mkdirSync(source);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "fake.txt"), "fake-credential");
  symlinkSync(
    outside,
    path.join(source, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => createSnapshot(source, path.join(root, "snapshot")),
    /symlink rejected/,
  );
});
const ok = {
  stdout: "linux\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
};
test("Docker failure stops without host fallback", async () => {
  const calls: string[] = [];
  const driver: Driver = async (file) => {
    calls.push(file);
    return { ...ok, exitCode: 1 };
  };
  await assert.rejects(
    new Sandbox({ mode: "docker", image }, driver).run(
      process.cwd(),
      "node",
      [],
    ),
    /fallback is disabled/,
  );
  assert.deepEqual(calls, ["docker"]);
  assert.throws(() => new Sandbox({ mode: "trusted-host" }));
});
test("container restricts privileges, network, resources and cleans up after timeout", async () => {
  const calls: string[][] = [];
  const driver: Driver = async (_file, args) => {
    calls.push(args);
    return args[0] === "run" ? { ...ok, timedOut: true } : ok;
  };
  const r = await new Sandbox({ mode: "docker", image }, driver).run(
    process.cwd(),
    "node",
    ["-e", "1"],
    { readOnly: true },
  );
  assert.equal(r.timedOut, true);
  const run = calls.find((c) => c[0] === "run")!;
  for (const flag of [
    "--network=none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--pull=never",
  ])
    assert.ok(run.includes(flag));
  assert.ok(run.some((a) => a.endsWith(",readonly")));
  assert.equal(run[run.indexOf("--user") + 1], "1000:1000");
  assert.equal(calls.at(-1)?.[0], "rm");
});
test("sanitized snapshot excludes fake credentials and git metadata", () => {
  const base = path.resolve("../cache/tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "snapshot-"));
  const source = path.join(root, "source");
  mkdirSync(source);
  for (const f of [".env", ".npmrc", "secret.key", "index.ts"])
    writeFileSync(path.join(source, f), "fake");
  mkdirSync(path.join(source, ".git"));
  const output = createSnapshot(source, path.join(root, "copy"));
  assert.ok(existsSync(path.join(output, "index.ts")));
  for (const f of [".env", ".npmrc", "secret.key", ".git"])
    assert.equal(existsSync(path.join(output, f)), false);
  assert.throws(() => createSnapshot(source, path.join(source, "nested")));
});
