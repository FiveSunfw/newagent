import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const newagentRoot = path.resolve(process.env.NEWAGENT_HOME ?? "E:/newagent");
const python =
  process.platform === "win32"
    ? path.join(newagentRoot, "tools", "ragas-venv", "Scripts", "python.exe")
    : path.join(newagentRoot, "tools", "ragas-venv", "bin", "python");
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

const scripts = {
  run: [path.join(appRoot, "scripts", "ragas", "run.py"), ...commandArgs],
  report: [path.join(appRoot, "scripts", "ragas", "report.py"), ...commandArgs],
  test: ["-m", "unittest", "discover", "-s", "scripts/ragas/tests", "-p", "test_*.py", ...commandArgs],
};
if (!scripts[command])
  throw new Error("Usage: npm run eval:ragas:run|report or npm run test:ragas");
if (!existsSync(python))
  throw new Error("Ragas Python 3.11 venv is missing; run scripts/ragas/setup.ps1 first");

const result = spawnSync(python, scripts[command], {
  cwd: appRoot,
  env: { ...process.env, NEWAGENT_HOME: newagentRoot, PYTHONDONTWRITEBYTECODE: "1" },
  stdio: "inherit",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
