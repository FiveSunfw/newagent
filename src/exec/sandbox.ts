import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { execute, type Execution } from "./execution.js";
import { redact } from "../state/redaction.js";

export const sandboxSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("docker"),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    cpus: z.number().positive().max(8).default(2),
    memoryMb: z.number().int().min(128).max(16384).default(2048),
    pids: z.number().int().min(16).max(1024).default(128),
    dependencyVolume: z
      .string()
      .regex(/^newagent-deps-[a-f0-9]{32}$/)
      .optional(),
  }),
  z.object({ mode: z.literal("trusted-host"), acknowledged: z.literal(true) }),
]);
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type Driver = typeof execute;

/** Workspace must be a sanitized execution snapshot, never the original repository. */
export class Sandbox {
  readonly config: SandboxConfig;
  constructor(
    config: unknown,
    private driver: Driver = execute,
  ) {
    this.config = sandboxSchema.parse(config);
  }
  async preflight(cwd: string, signal?: AbortSignal) {
    if (this.config.mode === "trusted-host") return;
    const info = await this.driver(
      "docker",
      ["info", "--format", "{{.OSType}}"],
      cwd,
      signal,
      15000,
    );
    if (info.exitCode !== 0 || info.timedOut || info.stdout.trim() !== "linux")
      throw new Error(
        "Docker Linux daemon unavailable; host fallback is disabled: " + JSON.stringify(redact({exitCode:info.exitCode,timedOut:info.timedOut,stdout:info.stdout.slice(-1000),stderr:info.stderr.slice(-1000)})),
      );
    const image = await this.driver(
      "docker",
      ["image", "inspect", this.config.image],
      cwd,
      signal,
      15000,
    );
    if (image.exitCode !== 0 || image.timedOut)
      throw new Error(
        "Sandbox image unavailable; prepare dependencies explicitly",
      );
  }
  async run(
    snapshot: string,
    file: string,
    args: string[],
    options: {
      readOnly?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
      log?: string;
      input?: string;
    } = {},
  ): Promise<Execution> {
    const timeoutMs = z
      .number()
      .int()
      .positive()
      .max(1800000)
      .parse(options.timeoutMs ?? 600000);
    if (!file || file.includes("\0") || args.some((a) => a.includes("\0")))
      throw new Error("Invalid command");
    if (this.config.mode === "trusted-host")
      return this.driver(
        file,
        args,
        snapshot,
        options.signal,
        timeoutMs,
        options.log,
        {},
        options.input,
      );
    const root = path.resolve(snapshot);
    if (this.config.dependencyVolume)
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
    if (root.includes(","))
      throw new Error("Snapshot path cannot contain commas");
    await this.preflight(root, options.signal);
    const name = `newagent-${randomUUID()}`;
    const command = [
      "run",
      "--rm",
      "--interactive",
      "--name",
      name,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--cpus",
      String(this.config.cpus),
      "--memory",
      `${this.config.memoryMb}m`,
      "--memory-swap",
      `${this.config.memoryMb}m`,
      "--pids-limit",
      String(this.config.pids),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
      "--mount",
      `type=bind,src=${root},dst=/workspace${options.readOnly ? ",readonly" : ""}`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "npm_config_cache=/tmp/npm",
      ...(this.config.dependencyVolume
        ? [
            "--mount",
            `type=volume,src=${this.config.dependencyVolume},dst=/workspace/node_modules,readonly`,
          ]
        : []),
      this.config.image,
      file,
      ...args,
    ];
    try {
      return await this.driver(
        "docker",
        command,
        root,
        options.signal,
        timeoutMs,
        options.log,
        {},
        options.input,
      );
    } finally {
      // Killing the Docker CLI does not terminate the daemon's container. Cleanup has its own signal.
      const removed = await this.driver(
        "docker",
        ["rm", "--force", name],
        root,
        undefined,
        15000,
      );
      if (
        removed.timedOut ||
        (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr))
      )
        throw new Error(`Sandbox cleanup failed for ${name}`);
    }
  }
}
