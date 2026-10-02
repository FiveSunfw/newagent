import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { execute, git } from "../exec/execution.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const acceptance = path.join(root, "data", "orders-acceptance.mjs");
const cwd = path.join(root, "cache", "reference-validation");
if (!existsSync(cwd)) {
  mkdirSync(path.dirname(cwd), { recursive: true });
  await git(path.dirname(cwd), [
    "clone",
    "--no-hardlinks",
    path.join(root, "fixtures", "orders"),
    cwd,
  ]);
}
writeFileSync(
  path.join(cwd, "src", "orders.ts"),
  readFileSync(path.join(root, "data", "eval", "reference.ts")),
);
for (const script of ["orders-acceptance.mjs", "orders-integration.mjs"]) {
  const r = await execute(
    process.execPath,
    ["--experimental-strip-types", path.join(root, "data", script)],
    cwd,
  );
  console.log(script, r.exitCode, r.stdout, r.stderr);
  if (r.exitCode !== 0) throw new Error("Reference validation failed");
}
const cases = JSON.parse(
  readFileSync(path.join(root, "data", "eval", "cases.json"), "utf8"),
);
const outcomes = [];
for (const c of cases) {
  const r = await execute(
    process.execPath,
    ["--experimental-strip-types", acceptance],
    path.join(root, "fixtures", "eval", c.id),
  );
  outcomes.push({ id: c.id, detected: r.exitCode !== 0 });
}
writeFileSync(
  path.join(root, "data", "eval", "fixture-validation.json"),
  JSON.stringify({ referencePassed: true, mutants: outcomes }, null, 2),
);
console.log(outcomes);
if (outcomes.some((c) => !c.detected))
  throw new Error("Undetected seeded defect");
