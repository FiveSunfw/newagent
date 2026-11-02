import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git } from "../exec/execution.js";
import { TaskExecution } from "../exec/task-execution.js";
import { profileSchema, type Task } from "../protocol/types.js";
import { repositoryCases, repositorySmoke } from "./repository-cases.js";
import {
  configureLocalRun,
  evaluationDatasetVersion,
  evaluationRoot,
  localHealth,
  projectRoot,
  readJson,
  saveJson,
} from "./local-environment.js";

const pins = {
  mitt: "6b41670516ed8e8b738612f60491995470aa63b3",
  "fast-json-stable-stringify": "49e230da2c84247b29ad4de02c9395793caefd15",
  dlv: "3212139c05647ffe3f1b095acd46afa2f5f635dd",
};
mkdirSync(evaluationRoot, { recursive: true });
const manifestPath = path.join(evaluationRoot, "dataset.json");
if (existsSync(manifestPath))
  throw new Error("Dataset already exists; refusing to overwrite frozen tasks");
configureLocalRun(evaluationRoot);
const health = await localHealth();
const preflightProfile = profileSchema.parse({
  id: "repository-evaluation-setup",
  source: evaluationRoot,
  execution: { mode: "docker" },
  checks: [{ name: "preflight", file: "node", args: ["--version"] }],
});
const preflightTask: Task = {
  id: "repository-evaluation-setup",
  profileId: preflightProfile.id,
  workspace: evaluationRoot,
  requirement:
    "Verify the configured Linux Docker sandbox before preparing evaluation data",
  acceptance: ["Linux Docker daemon and pinned image are available"],
  status: "queued",
  round: 0,
  branch: "setup-preflight",
  baseRevision: "",
  revision: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
await new TaskExecution(
  evaluationRoot,
  preflightTask,
  preflightProfile,
).preflight();
const dataset = [];
for (const c of repositoryCases) {
  const upstream = path.join(projectRoot, "upstream", "eval", c.repository);
  const metadata = z
    .object({ repo: z.string(), sha: z.string() })
    .parse(readJson(path.join(upstream, "upstream.json")));
  if (metadata.sha !== pins[c.repository])
    throw new Error("Upstream pin mismatch");
  const source = path.join(evaluationRoot, "sources", c.id);
  if (existsSync(source))
    throw new Error(
      `Partial dataset exists: ${source}; inspect rather than overwrite`,
    );
  cpSync(upstream, source, { recursive: true });
  for (const [file, content] of Object.entries(c.setup ?? {}))
    writeFileSync(path.join(source, file), content);
  if (c.publicExport) {
    const file = path.join(source, c.publicExport.file);
    writeFileSync(
      file,
      readFileSync(file, "utf8") + "\n" + c.publicExport.line,
    );
  }
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Evaluation"]);
  await git(source, ["config", "user.email", "evaluation@localhost"]);
  await git(source, ["add", "."]);
  await git(source, [
    "commit",
    "-m",
    "Fixed upstream baseline with documented integration fixture",
  ]);
  const referenceRevision = await git(source, ["rev-parse", "HEAD"]);
  const command = (name: string, code: string) => ({
    name,
    file: "node",
    args: [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      "import assert from 'node:assert/strict';" + code,
    ],
    timeoutMs: 120000,
  });
  const checks = [command("contract-smoke", repositorySmoke[c.repository])];
  const acceptance = [command("independent-acceptance", c.acceptance)];
  const profile = profileSchema.parse({
    id: c.id,
    source,
    execution: { mode: "docker" },
    checks,
    acceptance,
    protectedPaths: [
      "package.json",
      "package-lock.json",
      "README.md",
      "LICENSE",
      ".github",
      "test",
      "tests",
      "AGENTS.md",
      "upstream.json",
    ],
  });
  const task: Task = {
    id: c.id,
    profileId: c.id,
    requirement: c.requirement,
    acceptance: ["Independent acceptance"],
    workspace: source,
    branch: "baseline",
    status: "queued",
    round: 0,
    baseRevision: referenceRevision,
    revision: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const boundary = new TaskExecution(evaluationRoot, task, profile);
  await boundary.preflight();
  for (const check of [...checks, ...acceptance]) {
    const result = await boundary.command(
      check.file,
      check.args,
      new AbortController().signal,
      120000,
    );
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `Reference acceptance invalid: ${c.id}: ${result.stderr}`,
      );
  }
  for (const mutation of c.mutation) {
    const file = path.join(source, mutation.file);
    const content = readFileSync(file, "utf8");
    if (!content.includes(mutation.before))
      throw new Error(`Mutation anchor missing: ${c.id}`);
    writeFileSync(file, content.replace(mutation.before, mutation.after));
  }
  const failed = await boundary.command(
    acceptance[0].file,
    acceptance[0].args,
    new AbortController().signal,
    120000,
  );
  if (failed.exitCode === 0 || failed.timedOut)
    throw new Error(`Seeded defect not detected: ${c.id}`);
  await git(source, ["add", "."]);
  await git(source, [
    "commit",
    "-m",
    `Seed controlled evaluation defect ${c.id}`,
  ]);
  const seededRevision = await git(source, ["rev-parse", "HEAD"]);
  dataset.push({
    ...c,
    profile: { ...profile, base: seededRevision },
    upstream: metadata,
    referenceRevision,
    seededRevision,
    baselineDefectDetected: true,
  });
  console.log(
    JSON.stringify({ case: c.id, baselineValidated: true, seededRevision }),
  );
}
saveJson(manifestPath, {
  version: `repository-eval-${evaluationDatasetVersion}`,
  createdAt: new Date().toISOString(),
  health,
  provenance:
    "Fixed public repository snapshots with controlled planted defects; two new cross-file integration fixtures. Not natural historical issue resolution.",
  limits: { tools: 100, repairs: 3, durationMinutes: 30 },
  cases: dataset,
});
console.log(
  JSON.stringify({
    dataset: manifestPath,
    tasks: dataset.length,
    repositories: 3,
    development: 6,
    holdout: 6,
  }),
);
