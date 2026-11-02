import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { profileSchema } from "../src/protocol/types.js";
import { Sandbox } from "../src/exec/sandbox.js";
import { execute, inside } from "../src/exec/execution.js";

const [profileId, authorization] = process.argv.slice(2);
if (!profileId || authorization !== "--allow-network")
  throw new Error(
    "Usage: npm run sandbox:dependencies -- PROFILE --allow-network (dependency download only; lifecycle scripts disabled)",
  );
const root = path.resolve(process.env.NEWAGENT_ROOT ?? "..");
const profilesPath = path.join(root, "data", "profiles.json");
const profiles = JSON.parse(
  readFileSync(profilesPath, "utf8").replace(/^\uFEFF/, ""),
);
if (!Array.isArray(profiles)) throw new Error("Invalid profiles");
const index = profiles.findIndex((p: { id?: string }) => p.id === profileId);
if (index < 0) throw new Error("Unknown profile");
const profile = profileSchema.parse(profiles[index]);
if (profile.execution.mode !== "docker")
  throw new Error("Dependency preparation requires a Docker profile");
const config = JSON.parse(
  readFileSync(path.join(root, "data", "sandbox.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
);
const sandbox = new Sandbox(config);
if (sandbox.config.mode !== "docker")
  throw new Error("Docker configuration required");
const environment = { DOCKER_CONFIG: path.join(root, "cache", "docker") };
const cache = path.join(root, "cache", "npm-linux");
mkdirSync(cache, { recursive: true });
const prep = path.join(root, "cache", "dependencies");
mkdirSync(prep, { recursive: true });
const workspace = mkdtempSync(path.join(prep, "prepare-"));
mkdirSync(path.join(workspace, "node_modules"));
const lock = readFileSync(inside(profile.source, "package-lock.json"));
const lockHash = createHash("sha256").update(lock).digest("hex");
const volume = `newagent-deps-${createHash("sha256")
  .update(lockHash + sandbox.config.image)
  .digest("hex")
  .slice(0, 32)}`;
writeFileSync(path.join(workspace, "package-lock.json"), lock);
writeFileSync(
  path.join(workspace, "package.json"),
  readFileSync(inside(profile.source, "package.json")),
);
const created = await execute(
  "docker",
  ["volume", "create", volume],
  root,
  undefined,
  15000,
  undefined,
  environment,
);
if (created.exitCode !== 0 || created.timedOut)
  throw new Error(`Volume preparation failed: ${created.stderr}`);
const name = `newagent-dependency-${path.basename(workspace)}`;
let result;
try {
  result = await execute(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--pull=never",
      "--network=bridge",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
      "--mount",
      `type=bind,src=${workspace},dst=/workspace,readonly`,
      "--mount",
      `type=volume,src=${volume},dst=/workspace/node_modules`,
      "--mount",
      `type=bind,src=${cache},dst=/cache`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "npm_config_cache=/cache",
      sandbox.config.image,
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    root,
    undefined,
    600000,
    path.join(workspace, "install.log"),
    environment,
  );
} finally {
  const removed = await execute(
    "docker",
    ["rm", "--force", name],
    root,
    undefined,
    15000,
    undefined,
    environment,
  );
  if (
    removed.timedOut ||
    (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr))
  )
    throw new Error(`Dependency container cleanup failed: ${name}`);
}
if (result.exitCode !== 0 || result.timedOut)
  throw new Error(
    `Dependency preparation failed; see ${workspace}/install.log`,
  );
profiles[index] = {
  ...profiles[index],
  execution: {
    mode: "docker",
    dependencies: { volume, lockHash, image: sandbox.config.image },
  },
};
writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
console.log(
  JSON.stringify(
    {
      profileId,
      volume,
      lockHash,
      image: sandbox.config.image,
      workspace,
      lifecycleScripts: false,
    },
    null,
    2,
  ),
);
