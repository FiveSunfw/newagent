import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const newagentRoot = path.resolve(process.env.NEWAGENT_HOME ?? "E:/newagent");
const batch = process.env.NEWAGENT_RAGAS_BATCH?.trim() || "ragas-v1";
if (!/^ragas-v[1-9][0-9]*$/.test(batch))
  throw new Error("NEWAGENT_RAGAS_BATCH must look like ragas-v1");
const suffix = batch.slice("ragas-".length);
const retrievalBatch = `ragas-retrieval-${suffix}`;
const ragasOutput = path.join(newagentRoot, "data", "ragas", batch);
const retrievalRoot = path.join(newagentRoot, "data", "repository-eval-v2", retrievalBatch);
const retrievalResults = path.join(retrievalRoot, "results.json");
const reuseRetrieval = process.env.NEWAGENT_RAGAS_REUSE_RETRIEVAL === "1";
const python =
  process.platform === "win32"
    ? path.join(newagentRoot, "tools", "ragas-venv", "Scripts", "python.exe")
    : path.join(newagentRoot, "tools", "ragas-venv", "bin", "python");

if (existsSync(ragasOutput))
  throw new Error(`Ragas batch already exists at ${ragasOutput}; choose a new NEWAGENT_RAGAS_BATCH`);
if (existsSync(retrievalResults) && !reuseRetrieval)
  throw new Error(`Fresh retrieval batch already exists at ${retrievalBatch}; preserve it and choose a new Ragas batch version`);
if (reuseRetrieval && !existsSync(retrievalResults))
  throw new Error(`Cannot reuse missing retrieval results: ${retrievalResults}`);
if (!existsSync(python))
  throw new Error("Ragas Python 3.11 venv is missing; run scripts/ragas/setup.ps1 first");

const env = {
  ...process.env,
  NEWAGENT_HOME: newagentRoot,
  NEWAGENT_EVAL_DATASET_VERSION: "v2",
  NEWAGENT_RETRIEVAL_BATCH: retrievalBatch,
  NEWAGENT_RETRIEVAL_CAPTURE_CONTENT: "1",
};
if (!reuseRetrieval) {
  const retrieval = spawnSync(
    process.execPath,
    [path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/eval/evaluate-retrieval.ts"],
    { cwd: appRoot, env, stdio: "inherit", maxBuffer: 32 * 1024 * 1024 },
  );
  if (retrieval.error) throw retrieval.error;
  if (retrieval.status !== 0)
    throw new Error(`Fresh Top-10 source retrieval failed with exit code ${retrieval.status}; no Ragas model calls were made`);
} else {
  console.log(`Reusing verified fresh retrieval batch ${retrievalBatch}; no retrieval recomputation or paid model call will occur.`);
}

const exportResult = spawnSync(
  python,
  [path.join(appRoot, "scripts", "ragas", "export.py"), "--batch", batch],
  { cwd: appRoot, env, stdio: "inherit", maxBuffer: 16 * 1024 * 1024 },
);
if (exportResult.error) throw exportResult.error;
if (exportResult.status !== 0)
  throw new Error(`Ragas JSONL export failed with exit code ${exportResult.status}; no paid model calls were made`);
