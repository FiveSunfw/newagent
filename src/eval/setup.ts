import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  cpSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../exec/execution.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const fixture = path.join(root, "fixtures", "orders");
mkdirSync(path.join(fixture, "src"), { recursive: true });
mkdirSync(path.join(fixture, "tests"), { recursive: true });
mkdirSync(path.join(root, "data", "pi"), { recursive: true });
if (!existsSync(path.join(fixture, ".git"))) {
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify(
      { name: "orders-fixture", private: true, type: "module" },
      null,
      2,
    ),
  );
  writeFileSync(path.join(fixture, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(
    path.join(fixture, "AGENTS.md"),
    "Implement only authenticated self-only order access. Preserve existing tests and protected acceptance checks. Never return another user's orders.\n",
  );
  writeFileSync(
    path.join(fixture, "README.md"),
    "# Orders fixture\nTypeScript order query business module. Only authenticated owner access.\n",
  );
  writeFileSync(
    path.join(fixture, "src", "orders.ts"),
    `export interface Order { id: string; ownerId: string; createdAt: string; amount: number; }\nexport function queryOrders(orders: Order[], ownerId: string): Order[] {\n  if (!ownerId) throw new Error('Authentication required');\n  return orders.filter(order => order.ownerId === ownerId);\n}\n`,
  );
  writeFileSync(
    path.join(fixture, "tests", "baseline.test.ts"),
    `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {queryOrders} from '../src/orders.ts';\ntest('owner access and auth boundary',()=>{const orders=[{id:'1',ownerId:'a',createdAt:'2026-01-01T00:00:00Z',amount:1},{id:'2',ownerId:'b',createdAt:'2026-01-02T00:00:00Z',amount:2}];assert.equal(queryOrders(orders,'a').length,1);assert.throws(()=>queryOrders(orders,''));});\n`,
  );
  cpSync(path.join(root, "app", "templates", "orders"), fixture, {
    recursive: true,
  });
  await git(fixture, ["init"]);
  await git(fixture, ["config", "user.name", "NewAgent"]);
  await git(fixture, ["config", "user.email", "newagent@localhost"]);
  await git(fixture, ["add", "."]);
  await git(fixture, [
    "commit",
    "-m",
    "Initialize authenticated order fixture",
  ]);
}
for (const script of ["orders-acceptance.mjs", "orders-integration.mjs"]) {
  const target = path.join(root, "data", script);
  if (!existsSync(target))
    cpSync(path.join(root, "app", "templates", "validation", script), target);
}
const node = process.execPath;
const tsc = path.join(root, "app", "node_modules", "typescript", "bin", "tsc");
const typeRoots = path.join(root, "app", "node_modules", "@types");
const command = (name: string, args: string[]) => ({
  name,
  file: node,
  args,
  timeoutMs: 600000,
});
const profiles = [
  {
    id: "orders-fixture",
    source: fixture,
    base: "HEAD",
    checks: [
      command("typecheck", [
        tsc,
        "--noEmit",
        "--module",
        "nodenext",
        "--target",
        "es2022",
        "--allowImportingTsExtensions",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        typeRoots,
        "src/orders.ts",
        "tests/baseline.test.ts",
      ]),
      command("unit", [
        "--experimental-strip-types",
        "--test",
        "tests/*.test.ts",
      ]),
    ],
    integration: [
      command("http-sqlite", [
        "--experimental-strip-types",
        path.join(root, "data", "orders-integration.mjs"),
      ]),
    ],
    acceptance: [
      command("independent-acceptance", [
        "--experimental-strip-types",
        path.join(root, "data", "orders-acceptance.mjs"),
      ]),
    ],
    protectedPaths: [
      "package.json",
      ".github",
      "AGENTS.md",
      "tests/baseline.test.ts",
    ],
  },
  {
    id: "valorant-analytics",
    source: "https://github.com/FiveSunfw/valorant-analytics.git",
    base: "origin/HEAD",
    checks: [
      command("check", [
        path.join(
          path.dirname(node),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
        "run",
        "check",
      ]),
    ],
    integration: [],
    acceptance: [],
    protectedPaths: [
      "package.json",
      "package-lock.json",
      ".github",
      "AGENTS.md",
    ],
    github: { owner: "FiveSunfw", repo: "valorant-analytics", base: "main" },
  },
];
const profilePath = path.join(root, "data", "profiles.json");
if (!existsSync(profilePath))
  writeFileSync(profilePath, JSON.stringify(profiles, null, 2));
writeFileSync(
  path.join(root, "data", "model.example.json"),
  JSON.stringify({ provider: "custom", model: "your-model-id" }, null, 2),
);
writeFileSync(
  path.join(root, "data", "pi", "models.example.json"),
  JSON.stringify(
    {
      providers: {
        custom: {
          baseUrl: "https://your-provider.example/v1",
          api: "openai-completions",
          apiKey: "$NEWAGENT_API_KEY",
          models: [
            {
              id: "your-model-id",
              name: "Configured model",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);
console.log("Fixture and example configurations ready at " + root);
