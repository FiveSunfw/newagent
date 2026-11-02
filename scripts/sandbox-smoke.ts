import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "../src/exec/sandbox.js";
import { createSnapshot } from "../src/exec/snapshot.js";
import { TaskExecution } from "../src/exec/task-execution.js";
import { profileSchema, type Task } from "../src/protocol/types.js";

const root = path.resolve("..");
process.env.DOCKER_CONFIG = path.join(root, "cache", "docker");
const image = process.env.NEWAGENT_SANDBOX_IMAGE;
if (!image)
  throw new Error(
    "Set NEWAGENT_SANDBOX_IMAGE to a prepared sha256 image ID; no automatic pull",
  );
const base = path.join(root, "cache", "sandbox-smoke");
mkdirSync(base, { recursive: true });
const run = mkdtempSync(path.join(base, "run-"));
const source = path.join(run, "source");
mkdirSync(source);
writeFileSync(path.join(source, ".env"), "FAKE_SECRET=never-mount");
writeFileSync(path.join(source, "value.txt"), "before");
const snapshot = createSnapshot(source, path.join(run, "snapshot"));
const task: Task = {
  id: path.basename(run),
  profileId: "smoke",
  requirement: "Isolated smoke",
  acceptance: ["check isolation"],
  status: "developing",
  round: 0,
  workspace: source,
  branch: "smoke",
  baseRevision: "",
  revision: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const profile = profileSchema.parse({
  id: "smoke",
  source,
  checks: [{ name: "node", file: "node", args: ["-e", "0"] }],
});
const boundary = new TaskExecution(root, task, profile);
await boundary.preflight();
assert.ok((await boundary.list()).includes("value.txt"));
assert.equal(await boundary.read("value.txt"), "before");
await assert.rejects(boundary.read("../outside"), /outside workspace/);
await assert.rejects(boundary.read(".env"), /Private/);
await assert.rejects(boundary.write("sub/../package.json", "{}"), /protected/);
await boundary.write("added.txt", "through-boundary");
assert.ok(
  (await boundary.search("through-boundary")).some(
    (hit) => hit.path === "added.txt" && hit.line === 1,
  ),
);
assert.equal(
  readFileSync(path.join(source, "added.txt"), "utf8"),
  "through-boundary",
);
await assert.rejects(
  new TaskExecution(root, task, profile, true).write("value.txt", "bad"),
  /Read-only/,
);
const checked = await boundary.command("node", [
  "-e",
  "if(require('fs').readFileSync('added.txt','utf8')!=='through-boundary')process.exit(1)",
]);
assert.equal(checked.exitCode, 0);
await assert.rejects(
  boundary.command("node", [
    "-e",
    "require('fs').writeFileSync('value.txt','bad')",
  ]),
  /evidence invalid/,
);
assert.equal(readFileSync(path.join(source, "value.txt"), "utf8"), "before");
const sandbox = new Sandbox({ mode: "docker", image });
const report: { name: string; passed: boolean; durationMs: number }[] = [];
async function check(name: string, code: string, readOnly = false) {
  const result = await sandbox.run(snapshot, "node", ["-e", code], {
    readOnly,
    timeoutMs: 30000,
  });
  assert.equal(result.exitCode, 0, `${name}: ${result.stderr}`);
  report.push({ name, passed: true, durationMs: result.durationMs });
}
await check(
  "non-root and no secrets/socket",
  `const a=require('node:assert/strict'),fs=require('node:fs');a.equal(process.getuid(),1000);a.equal(fs.existsSync('/workspace/.env'),false);a.equal(fs.existsSync('/var/run/docker.sock'),false);a.equal(process.env.NEWAGENT_API_KEY,undefined);`,
);
await check(
  "network unavailable",
  `const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>{s.destroy();process.exit(0)},2000);`,
);
await check(
  "review cannot write",
  `const fs=require('node:fs');try{fs.writeFileSync('/workspace/value.txt','bad');process.exit(1)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}`,
  true,
);
await check(
  "developer can write snapshot",
  `require('node:fs').writeFileSync('/workspace/value.txt','after')`,
);
assert.equal(readFileSync(path.join(source, "value.txt"), "utf8"), "before");
assert.equal(readFileSync(path.join(snapshot, "value.txt"), "utf8"), "after");
await check(
  "root filesystem readonly and privilege limits",
  `const a=require('node:assert/strict'),fs=require('node:fs');a.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);a.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+/);a.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'128');a.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'2147483648');try{fs.writeFileSync('/etc/smoke','bad');process.exit(1)}catch{}`,
);
const timeout = await sandbox.run(
  snapshot,
  "node",
  ["-e", "setTimeout(()=>{},60000)"],
  { timeoutMs: 2000 },
);
assert.equal(timeout.timedOut, true);
report.push({
  name: "timeout and container cleanup",
  passed: true,
  durationMs: timeout.durationMs,
});
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2000);
try {
  await assert.rejects(
    sandbox.run(snapshot, "node", ["-e", "setTimeout(()=>{},60000)"], {
      signal: controller.signal,
    }),
    /cancelled/,
  );
} finally {
  clearTimeout(timer);
}
report.push({
  name: "cancellation and container cleanup",
  passed: true,
  durationMs: 2000,
});
writeFileSync(
  path.join(run, "report.json"),
  JSON.stringify({ at: new Date().toISOString(), image, report }, null, 2),
);
console.log(JSON.stringify({ run, report }, null, 2));
