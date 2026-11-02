import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Sandbox } from "./sandbox.js";
import { createSnapshot, privateEntry } from "./snapshot.js";
import { inside, revision, execute, files } from "./execution.js";
import type { Profile, Task } from "../protocol/types.js";

/** Host operations here only stage snapshots and import a validated single-file write. */
export class TaskExecution {
  private static readonly journals = new Map<
    string,
    { epoch: number; generation: number; changes: Map<string, number> }
  >();
  private sandbox: Sandbox;
  private journal() {
    const key = path.resolve(this.task.workspace);
    let state = TaskExecution.journals.get(key);
    if (!state) {
      state = { epoch: 0, generation: 0, changes: new Map() };
      TaskExecution.journals.set(key, state);
    }
    return state;
  }
  indexState(): {
    scope: string;
    generation: number;
    changes: ReadonlyMap<string, number>;
  } {
    const state = this.journal();
    return {
      scope: `${path.resolve(this.task.workspace)}:${state.epoch}`,
      generation: state.generation,
      changes: state.changes,
    };
  }
  resetIndexState() {
    this.journal().epoch++;
  }
  async fingerprints(files: string[], signal?: AbortSignal) {
    return this.batchRead(files, true, signal);
  }
  async readMany(files: string[], signal?: AbortSignal) {
    return this.batchRead(files, false, signal);
  }
  private async batchRead(
    paths: string[],
    hashes: boolean,
    signal?: AbortSignal,
  ) {
    if (paths.length > (hashes ? 2000 : 40))
      throw new Error("Batch read limit");
    if (!paths.length) return {};
    for (const file of paths) this.allowed(file);
    const { result } = await this.node(
      `${nodePrelude}\n${resolvePath}\nconst out={};for(const file of input.paths){const target=confined(file);if(!fs.existsSync(target))continue;const content=fs.readFileSync(target,'utf8');if(content.length>300000)throw Error('Read limit');out[file]=input.hashes?require('node:crypto').createHash('sha256').update(content).digest('hex'):content;}console.log(JSON.stringify(out));`,
      { paths, hashes },
      true,
      signal,
    );
    return z.record(z.string(), z.string()).parse(JSON.parse(result.stdout));
  }
  constructor(
    private root: string,
    private task: Task,
    private profile: Profile,
    private readOnly = false,
  ) {
    if (profile.execution.mode === "trusted-host")
      this.sandbox = new Sandbox(profile.execution);
    else {
      const configPath = path.join(root, "data", "sandbox.json");
      if (!existsSync(configPath))
        throw new Error(
          "Docker sandbox not configured: prepare data/sandbox.json; no host fallback",
        );
      this.sandbox = new Sandbox(
        {
          ...JSON.parse(
            readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
          ),
          dependencyVolume: profile.execution.dependencies?.volume,
        },
        (file, args, cwd, signal, timeout, log, environment, input) =>
          execute(
            file,
            args,
            cwd,
            signal,
            timeout,
            log,
            {
              ...environment,
              DOCKER_CONFIG: path.join(root, "cache", "docker"),
            },
            input,
          ),
      );
      if (this.sandbox.config.mode !== "docker")
        throw new Error("Docker task requires Docker configuration");
    }
  }
  environment() {
    return {
      mode: this.sandbox.config.mode,
      image:
        this.sandbox.config.mode === "docker"
          ? this.sandbox.config.image
          : `node:${process.version}`,
      boundaryVersion: "snapshot-v1",
      config: this.sandbox.config,
    };
  }
  private allowed(relative: string, write = false) {
    const target = inside(this.task.workspace, relative);
    const normalized = path
      .relative(this.task.workspace, target)
      .replaceAll("\\", "/")
      .toLowerCase();
    if (normalized.split("/").some(privateEntry))
      throw new Error("Private path");
    if (
      write &&
      (this.readOnly ||
        this.profile.protectedPaths.some(
          (p) =>
            normalized === p.toLowerCase() ||
            normalized.startsWith(p.toLowerCase() + "/"),
        ))
    )
      throw new Error("Read-only or protected path");
    return target;
  }
  private rejectRepositoryPrefixedPath(relative: string) {
    const suggestion = this.workspaceRootRelativeSuggestion(relative);
    if (suggestion)
      throw new Error(
        `Workspace root is already the repository root: '${relative}' repeats the repository name. Use '${suggestion}'.`,
      );
  }
  preflight(signal?: AbortSignal) {
    if (this.profile.execution.mode === "docker") {
      for (const command of [
        ...this.profile.checks,
        ...this.profile.staticChecks,
        ...this.profile.acceptance,
        ...this.profile.integration,
      ])
        if (
          /^[a-z]:/i.test(command.file) ||
          command.args.some((arg) => /^[a-z]:/i.test(arg))
        )
          throw new Error(
            "Windows-only profile commands require explicitly acknowledged trusted-host mode; rejected before any model call",
          );
      const lock = path.join(this.task.workspace, "package-lock.json");
      if (existsSync(lock)) {
        const hash = createHash("sha256")
          .update(readFileSync(lock))
          .digest("hex");
        if (this.profile.execution.dependencies?.lockHash !== hash)
          throw new Error(
            "Linux dependencies missing or stale; run sandbox:dependencies with explicit network authorization",
          );
        if (
          this.profile.execution.dependencies?.image !==
          this.environment().image
        )
          throw new Error(
            "Dependency image changed; prepare Linux dependencies again",
          );
      }
    }
    return this.sandbox.preflight(this.root, signal);
  }
  private snapshot() {
    const dir = path.join(this.root, "cache", "sandbox", this.task.id);
    mkdirSync(dir, { recursive: true });
    return createSnapshot(this.task.workspace, path.join(dir, randomUUID()));
  }
  private async node(
    code: string,
    input: unknown,
    readOnly: boolean,
    signal?: AbortSignal,
  ) {
    const cwd =
      this.profile.execution.mode === "docker"
        ? this.snapshot()
        : this.task.workspace;
    const result = await this.sandbox.run(cwd, "node", ["-e", code], {
      readOnly,
      signal,
      input: JSON.stringify(input),
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(`Workspace operation failed: ${result.stderr}`);
    return { result, cwd };
  }
  async list(signal?: AbortSignal) {
    if (this.profile.execution.mode === "trusted-host")
      return files(this.task.workspace).filter(
        (file) => !file.split("/").some(privateEntry),
      );
    const { result } = await this.node(
      `const fs=require('node:fs'),p=require('node:path');const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(['node_modules','.git','dist','coverage'].includes(e.name)||e.name.startsWith('.env'))continue;const f=p.join(d,e.name);if(e.isSymbolicLink())throw Error('Symlink denied');if(e.isDirectory())walk(f);else out.push(p.relative(process.cwd(),f));if(out.length>10000)throw Error('File limit')}}walk(process.cwd());console.log(JSON.stringify(out.sort()))`,
      {},
      true,
      signal,
    );
    return z.array(z.string()).parse(JSON.parse(result.stdout));
  }
  async read(relative: string, signal?: AbortSignal) {
    this.rejectRepositoryPrefixedPath(relative);
    this.allowed(relative);
    const { result } = await this.node(
      `${pathGuard}\nconst text=fs.readFileSync(target,'utf8');if(text.length>300000)throw Error('Read limit');console.log(JSON.stringify(text));`,
      { path: relative },
      true,
      signal,
    );
    return z.string().parse(JSON.parse(result.stdout));
  }
  workspaceRootRelativeSuggestion(relative: string): string | undefined {
    const parts = relative.replaceAll("\\", "/").split("/");
    if (
      parts.length < 2 ||
      parts[0].toLowerCase() !==
        path.basename(this.profile.source).toLowerCase()
    )
      return undefined;
    const candidate = parts.slice(1).join("/");
    try {
      const target = this.allowed(candidate);
      return existsSync(target) && statSync(target).isFile()
        ? candidate
        : undefined;
    } catch (error) {
      if (
        error instanceof Error &&
        /outside workspace|private path|symlink/i.test(error.message)
      )
        return undefined;
      throw error;
    }
  }
  async edit(
    relative: string,
    before: string,
    after: string,
    signal?: AbortSignal,
  ) {
    this.rejectRepositoryPrefixedPath(relative);
    this.allowed(relative, true);
    if (!before) throw new Error("Replacement text must not be empty");
    if (before === after)
      throw new Error(
        "Replacement has no effect: before and after are identical",
      );
    const content = await this.read(relative, signal);
    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    const normalizeLineEndings = (value: string) =>
      value.replace(/\r\n|\r|\n/g, lineEnding);
    const exactBefore = normalizeLineEndings(before);
    const occurrences = content.split(exactBefore).length - 1;
    if (occurrences !== 1)
      throw new Error(
        occurrences === 0
          ? "Replacement must match exactly one source occurrence; found none in " +
              relative +
              ". Reread current source and copy it without line-number prefixes. CRLF/LF line endings are normalized."
          : "Replacement must match exactly one source occurrence; found " +
              occurrences +
              " in " +
              relative +
              ". Include a longer unique source excerpt. CRLF/LF line endings are normalized.",
      );
    await this.write(
      relative,
      content.replace(exactBefore, normalizeLineEndings(after)),
      signal,
    );
  }
  async write(relative: string, content: string, signal?: AbortSignal) {
    this.rejectRepositoryPrefixedPath(relative);
    this.allowed(relative, true);
    const target = inside(this.task.workspace, relative);
    if (content.length > 300000) throw new Error("Write limit");
    const { cwd } = await this.node(
      `${pathGuard}\nfs.mkdirSync(p.dirname(target),{recursive:true});fs.writeFileSync(target,input.content);`,
      { path: relative, content },
      false,
      signal,
    );
    if (this.profile.execution.mode === "docker") {
      const actual = readFileSync(inside(cwd, relative), "utf8");
      if (actual !== content) throw new Error("Snapshot write mismatch");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, actual);
    }
    const state = this.journal();
    state.changes.set(
      path.relative(this.task.workspace, target).replaceAll("\\", "/"),
      ++state.generation,
    );
  }
  async search(query: string, signal?: AbortSignal) {
    if (!query || query.length > 300) throw new Error("Invalid search query");
    const { result } = await this.node(
      String.raw`const fs=require('node:fs'),p=require('node:path'),input=JSON.parse(fs.readFileSync(0,'utf8')),matches=[];
      for(const relative of input.files){
        const target=p.resolve(relative),rel=p.relative(process.cwd(),target);
        if(rel.startsWith('..')||p.isAbsolute(rel))throw Error('Outside workspace');
        let current=process.cwd();for(const part of rel.split(p.sep)){current=p.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Symlink denied');}
        if(fs.statSync(target).size>=100000)continue;
        const content=fs.readFileSync(target,'utf8');if(content.includes('\0'))continue;
        const lines=content.split('\n');for(let i=0;i<lines.length;i++){if(lines[i].includes(input.query))matches.push({path:relative,line:i+1,text:lines[i].slice(0,1000)});if(matches.length>=100)break;}
        if(matches.length>=100)break;
      }console.log(JSON.stringify(matches));`,
      { query, files: await this.list(signal) },
      true,
      signal,
    );
    return z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
        }),
      )
      .parse(JSON.parse(result.stdout));
  }
  async command(
    file: string,
    args: string[],
    signal?: AbortSignal,
    timeoutMs = 600000,
    log?: string,
  ) {
    if (this.readOnly)
      throw new Error("Reviewer cannot execute mutating commands");
    if (this.profile.execution.mode === "trusted-host") {
      try {
        return await execute(
          file,
          args,
          this.task.workspace,
          signal,
          timeoutMs,
          log,
        );
      } finally {
        this.resetIndexState();
      }
    }
    if (/^[a-z]:/i.test(file) || args.some((a) => /^[a-z]:/i.test(a)))
      throw new Error(
        "Windows-only command requires explicitly acknowledged trusted-host mode",
      );
    const snapshot = this.snapshot();
    const before = revision(snapshot);
    const result = await this.sandbox.run(snapshot, file, args, {
      signal,
      timeoutMs,
      log,
    });
    if (revision(snapshot) !== before)
      throw new Error("Validation changed snapshot source; evidence invalid");
    return result;
  }
}
const nodePrelude = `const fs=require('node:fs'),p=require('node:path'),input=JSON.parse(fs.readFileSync(0,'utf8'));`;
const resolvePath = `function confined(file){const target=p.resolve(file),rel=p.relative(process.cwd(),target);if(p.isAbsolute(file)||rel.startsWith('..')||p.isAbsolute(rel))throw Error('Outside workspace');let at=process.cwd();for(const part of rel.split(p.sep)){if(part.startsWith('.env')||['.git','.npmrc','.pypirc'].includes(part))throw Error('Private path');at=p.join(at,part);if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())throw Error('Symlink denied');}return target;}`;
const pathGuard = `${nodePrelude}\n${resolvePath}\nconst target=confined(input.path);`;
