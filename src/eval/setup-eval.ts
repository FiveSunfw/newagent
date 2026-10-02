import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, execute } from "../exec/execution.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const dir = path.join(root, "fixtures", "eval");
mkdirSync(dir, { recursive: true });
const reference = `export interface Order { id:string; ownerId:string; createdAt:string; amount:number; }\nexport interface Filter { from?:string; to?:string; }\nexport function queryOrders(orders:Order[],ownerId:string,options:Filter={}):Order[]{\n if(!ownerId)throw new Error('Authentication required');\n const from=options.from===undefined ? -Infinity : Date.parse(options.from);\n const to=options.to===undefined ? Infinity : Date.parse(options.to);\n if(Number.isNaN(from)||Number.isNaN(to))throw new Error('Invalid date');\n if(from>to)throw new Error('Invalid interval');\n return orders.filter(order=>order.ownerId===ownerId && Date.parse(order.createdAt)>=from && Date.parse(order.createdAt)<=to);\n}\n`;
const variants = [
  [
    "ownership",
    "查询可能返回其他用户订单",
    reference.replace("order.ownerId===ownerId && ", ""),
  ],
  [
    "from-inclusive",
    "起始时间边界上的订单丢失",
    reference.replace(">=from", ">from"),
  ],
  [
    "to-inclusive",
    "结束时间边界上的订单丢失",
    reference.replace("<=to", "<to"),
  ],
  [
    "invalid-date",
    "非法时间输入没有报错",
    reference.replace(
      "if(Number.isNaN(from)||Number.isNaN(to))throw new Error('Invalid date');",
      "",
    ),
  ],
  [
    "reverse-range",
    "逆序区间没有报错",
    reference.replace("if(from>to)throw new Error('Invalid interval');", ""),
  ],
  [
    "auth",
    "缺少身份信息时没有拒绝查询",
    reference.replace(
      "if(!ownerId)throw new Error('Authentication required');",
      "",
    ),
  ],
  [
    "no-options",
    "不传筛选条件时查询失败",
    reference.replace("options:Filter={}", "options:Filter"),
  ],
  [
    "missing-from",
    "只传结束时间时返回空结果",
    reference.replace("? -Infinity", "? Infinity"),
  ],
  [
    "missing-to",
    "只传开始时间时返回空结果",
    reference.replace("? Infinity", "? -Infinity"),
  ],
  [
    "timezone",
    "跨时区的等价时间筛选结果不一致",
    reference.replace(
      "Date.parse(order.createdAt)>=from",
      "Date.parse(order.createdAt.replace(/Z$/,'+08:00'))>=from",
    ),
  ],
];
const baseProfile = JSON.parse(
  readFileSync(path.join(root, "data", "profiles.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
)[0];
const profiles = JSON.parse(
  readFileSync(path.join(root, "data", "profiles.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
);
const cases = [];
for (const [id, problem, source] of variants) {
  const repo = path.join(dir, id);
  if (!existsSync(path.join(repo, ".git"))) {
    await git(dir, [
      "clone",
      "--no-hardlinks",
      path.join(root, "fixtures", "orders"),
      repo,
    ]);
    await git(repo, ["config", "user.name", "NewAgent"]);
    await git(repo, ["config", "user.email", "newagent@localhost"]);
    writeFileSync(path.join(repo, "src", "orders.ts"), source);
    await execute(
      process.execPath,
      [
        path.join(
          root,
          "app",
          "node_modules",
          "prettier",
          "bin",
          "prettier.cjs",
        ),
        "--write",
        "src/orders.ts",
      ],
      repo,
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", `Seed ${id} defect`]);
  }
  const profileId = "eval-" + id;
  if (!profiles.some((p: { id: string }) => p.id === profileId))
    profiles.push({ ...baseProfile, id: profileId, source: repo });
  cases.push({
    id,
    profileId,
    requirement: `修复订单查询缺陷：${problem}。保留本人权限、闭区间时间筛选、非法或逆序区间报错，补充回归测试。`,
    acceptance: [
      "只返回本人订单",
      "from/to 均为包含边界的可选时间",
      "非法时间和逆序区间抛错",
      "不传筛选参数保持原行为",
      "等价时区时间结果一致",
    ],
  });
}
writeFileSync(
  path.join(root, "data", "profiles.json"),
  JSON.stringify(profiles, null, 2),
);
mkdirSync(path.join(root, "data", "eval"), { recursive: true });
writeFileSync(
  path.join(root, "data", "eval", "cases.json"),
  JSON.stringify(cases, null, 2),
);
writeFileSync(path.join(root, "data", "eval", "reference.ts"), reference);
console.log(
  "10 seeded defect repositories and evaluation tasks generated; no model results claimed",
);
