import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/state/store.js";
import { Workflow } from "../src/core/workflow.js";
import { TaskExecution } from "../src/exec/task-execution.js";
import { git } from "../src/exec/execution.js";
import type { Agent } from "../src/model-provider/pi.js";
const base = path.resolve("../cache/sandbox-workflow");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, "run-"));
mkdirSync(path.join(root, "data"));
const configuration = readFileSync(
  path.resolve("../data/sandbox.json"),
  "utf8",
);
writeFileSync(path.join(root, "data", "sandbox.json"), configuration);
const source = path.join(root, "source");
mkdirSync(source);
writeFileSync(
  path.join(source, "package.json"),
  JSON.stringify({ name: "sandbox-workflow", type: "module" }),
);
writeFileSync(
  path.join(source, "money.ts"),
  "export function cents(price: number) { return Math.round(price); }\n",
);
writeFileSync(
  path.join(source, "total.ts"),
  "import { cents } from './money.ts'; export function total(price: number, quantity: number) { return cents(price) + quantity; }\n",
);
await git(source, ["init"]);
await git(source, ["config", "user.name", "Fixture"]);
await git(source, ["config", "user.email", "fixture@localhost"]);
await git(source, ["add", "."]);
await git(source, ["commit", "-m", "Isolated protocol fixture"]);
writeFileSync(
  path.join(root, "data", "profiles.json"),
  JSON.stringify([
    {
      id: "sandbox",
      source,
      checks: [
        {
          name: "acceptance",
          file: "node",
          args: [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            "import assert from 'node:assert/strict';import {total} from './total.ts';assert.equal(total(1.25,3),375);assert.equal(total(0,3),0);",
          ],
        },
      ],
    },
  ]),
);
const store = new Store(path.join(root, "data"));
let developers = 0,
  reviews = 0;
const agent: Agent = {
  async run(task, profile, role, _prompt, signal) {
    const boundary = new TaskExecution(
      root,
      task,
      profile,
      role === "reviewer",
    );
    if (role === "developer") {
      developers++;
      await boundary.write(
        "total.ts",
        "import { cents } from './money.ts'; export function total(price: number, quantity: number) { return cents(price) * quantity; }\n",
        signal,
      );
      if (developers > 1)
        await boundary.write(
          "money.ts",
          "export function cents(price: number) { return Math.round(price * 100); }\n",
          signal,
        );
      return "Protocol fixture developer; no real model";
    }
    reviews++;
    assert.match(await boundary.read("money.ts", signal), /price \* 100/);
    await assert.rejects(
      boundary.write("money.ts", "bad", signal),
      /Read-only/,
    );
    return '{"findings":[],"verdict":"pass"}';
  },
};
const flow = new Workflow(root, store, agent);
try {
  const task = flow.create({
    profileId: "sandbox",
    requirement:
      "Fix money units and quantity multiplication across two modules",
    acceptance: ["Independent checks must pass"],
  });
  flow.run(task.id);
  await flow.waitForRun();
  const result = store.get(task.id);
  assert.equal(result.status, "ready_for_pr", result.error ?? "");
  assert.equal(developers, 2);
  assert.equal(reviews, 1);
  assert.equal(store.checks(task.id)[0].passed, false);
  assert.equal(store.checks(task.id).at(-1)?.passed, true);
  assert.ok(result.verificationFingerprint);
  assert.equal(
    readFileSync(path.join(source, "money.ts"), "utf8").includes("price * 100"),
    false,
  );
  const profiles = JSON.parse(
    readFileSync(path.join(root, "data", "profiles.json"), "utf8"),
  );
  profiles[0].checks[0].args = ["-e", "0"];
  writeFileSync(
    path.join(root, "data", "profiles.json"),
    JSON.stringify(profiles),
  );
  await assert.rejects(flow.publish(task.id), /environment changed/);
  const report = {
    root,
    protocolFixture: true,
    realModel: false,
    developers,
    reviews,
    checks: store.checks(task.id),
    task: store.get(task.id),
  };
  writeFileSync(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      root,
      status: result.status,
      developers,
      reviews,
      staleConfigurationRejected: true,
      realModel: false,
    }),
  );
} finally {
  await flow.shutdown();
  store.close();
}
