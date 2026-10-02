import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
export interface Execution {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}
export function execute(
  file: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 600000,
  log?: string,
  environment: Record<string, string> = {},
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      done = false;
    const started = Date.now();
    if (signal?.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }
    const env = {
      ...process.env,
      npm_config_cache: path.resolve(cwd, "..", "..", "cache", "npm"),
      TEMP: process.env.NEWAGENT_TEMP ?? process.env.TEMP,
      TMP: process.env.NEWAGENT_TEMP ?? process.env.TMP,
    };
    for (const key of Object.keys(env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))
        delete env[key as keyof typeof env];
    }
    Object.assign(env, environment, {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    });
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (kind: "stdout" | "stderr", data: Buffer) => {
      const text = data.toString();
      if (log) appendFileSync(log, text);
      if (kind === "stdout") stdout = (stdout + text).slice(-200000);
      else stderr = (stderr + text).slice(-200000);
    };
    child.stdout.on("data", (d) => collect("stdout", d));
    child.stderr.on("data", (d) => collect("stderr", d));
    const kill = () => {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (err) => {
      if (!done) {
        done = true;
        cleanup();
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        cleanup();
        if (signal?.aborted) reject(new Error("Operation cancelled"));
        else
          resolve({
            stdout,
            stderr,
            exitCode: code,
            timedOut,
            durationMs: Date.now() - started,
          });
      }
    });
  });
}
export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  environment: Record<string, string> = {},
) {
  const r = await execute(
    "git",
    args,
    cwd,
    signal,
    60000,
    undefined,
    environment,
  );
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
export function inside(root: string, relative: string) {
  if (relative.includes(":") || relative.includes("\0"))
    throw new Error("Invalid path");
  if (path.isAbsolute(relative)) throw new Error("Use a relative path");
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path outside workspace");
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Symlinks are not supported");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export function files(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (
        [
          ".git",
          "node_modules",
          "dist",
          ".next",
          "coverage",
          ".codegraph",
        ].includes(item.name) ||
        item.name.startsWith(".env") ||
        item.name.endsWith(".tsbuildinfo")
      )
        continue;
      const p = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) visit(p);
      else if (item.isFile())
        out.push(path.relative(root, p).replaceAll("\\", "/"));
      if (out.length > 10000) throw new Error("Workspace file limit exceeded");
    }
  };
  visit(realpathSync(root));
  return out.sort();
}
export function revision(root: string) {
  const hash = createHash("sha256");
  for (const f of files(root)) {
    hash.update(f);
    hash.update(readFileSync(path.join(root, f)));
  }
  return hash.digest("hex");
}
export function logPath(root: string, id: string, name: string) {
  const dir = path.join(root, "logs", id);
  mkdirSync(dir, { recursive: true });
  return path.join(
    dir,
    `${Date.now()}-${name.replace(/[^a-z0-9-]/gi, "_")}.log`,
  );
}
