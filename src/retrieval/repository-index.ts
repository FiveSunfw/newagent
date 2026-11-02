import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chunkFile, hashText, rrf, type Chunk } from "./chunks.js";
import { isIndexableFile, type IndexOptions } from "./file-selection.js";
import type { DenseIndex } from "./dense.js";
export interface RepositoryReader {
  list(signal?: AbortSignal): Promise<string[]>;
  read(file: string, signal?: AbortSignal): Promise<string>;
  fingerprints?(
    files: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>>;
  readMany?(
    files: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>>;
  indexState?(): {
    scope: string;
    generation: number;
    changes: ReadonlyMap<string, number>;
  };
}
export interface SearchHit extends Chunk {
  score: number;
  source: "indexed" | "live";
  parents?: ParentContext[];
}
export interface ParentContext {
  id: string;
  symbol: string;
  startLine: number;
  endLine: number;
  content: string;
  complete: boolean;
}
/** Prefer semantic method/class ancestors over intermediate control-flow blocks. */
function parentContexts(
  chunk: Chunk,
  chunks: Map<string, Chunk>,
): ParentContext[] {
  const contexts: ParentContext[] = [];
  const visited = new Set([chunk.id]);
  let parentId = chunk.parentId;
  while (parentId && contexts.length < 2) {
    const parent = chunks.get(parentId);
    if (
      !parent ||
      visited.has(parent.id) ||
      parent.fileHash !== chunk.fileHash ||
      parent.path !== chunk.path ||
      parent.repository !== chunk.repository ||
      parent.indexVersion !== chunk.indexVersion
    )
      break;
    visited.add(parent.id);
    parentId = parent.parentId;
    if (parent.kind === "branch" || parent.kind === "fragment") continue;
    const lines = parent.content.split("\n");
    const offset = Math.max(
      0,
      Math.min(chunk.startLine - parent.startLine - 12, lines.length - 160),
    );
    const selected: string[] = [];
    let characters = 0;
    for (const line of lines.slice(offset, offset + 160)) {
      if (!selected.length && line.length > 12000) break;
      if (selected.length && characters + line.length + 1 > 12000) break;
      selected.push(line);
      characters += line.length + 1;
    }
    if (!selected.length) continue;
    contexts.push({
      id: parent.id,
      symbol: parent.symbol,
      startLine: parent.startLine + offset,
      endLine: parent.startLine + offset + selected.length - 1,
      content: selected.join("\n"),
      complete: offset === 0 && selected.length === lines.length,
    });
  }
  return contexts;
}
export class RepositoryIndex {
  private db: Database.Database;
  constructor(
    directory: string,
    private repository: string,
    private reader: RepositoryReader,
    private version: string,
    private dense?: DenseIndex,
    private options: IndexOptions = {},
  ) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, "repository-index.db"));
    this.db.pragma("journal_mode = WAL");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS retrieval_files(repository TEXT,path TEXT,hash TEXT,version TEXT,dense_ready INTEGER,PRIMARY KEY(repository,path));
      CREATE TABLE IF NOT EXISTS retrieval_chunks(id TEXT PRIMARY KEY,repository TEXT,path TEXT,body TEXT);
      CREATE TABLE IF NOT EXISTS retrieval_pending_delete(repository TEXT,version TEXT,id TEXT,PRIMARY KEY(repository,version,id));
      CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(id UNINDEXED,repository UNINDEXED,path,symbol,content);`);
  }
  close() {
    this.db.close();
  }
  private rows(file?: string): Chunk[] {
    const rows = (
      file === undefined
        ? this.db
            .prepare("SELECT body FROM retrieval_chunks WHERE repository=?")
            .all(this.repository)
        : this.db
            .prepare(
              "SELECT body FROM retrieval_chunks WHERE repository=? AND path=?",
            )
            .all(this.repository, file)
    ) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body));
  }
  async update(signal?: AbortSignal, rebuild = false, changedPaths?: string[]) {
    const all =
      changedPaths && !this.reader.fingerprints
        ? (await this.reader.list(signal)).filter((file) =>
            changedPaths.includes(file),
          )
        : (changedPaths ?? (await this.reader.list(signal)));
    let selected = all.filter((file) => isIndexableFile(file, this.options));
    if (selected.length > 2000)
      throw new Error(
        "Repository indexing limit exceeded (2000 textual files)",
      );
    const fingerprints =
      !rebuild && this.reader.fingerprints
        ? await this.reader.fingerprints(selected, signal)
        : undefined;
    if (fingerprints)
      selected = selected.filter((file) => fingerprints[file] !== undefined);
    const oldFiles = this.db
      .prepare(
        "SELECT path,hash,version,dense_ready FROM retrieval_files WHERE repository=?",
      )
      .all(this.repository) as {
      path: string;
      hash: string;
      version: string;
      dense_ready: number;
    }[];
    const old = new Map(oldFiles.map((row) => [row.path, row]));
    const reasons: string[] = [];
    if (this.dense) {
      const pending = this.db
        .prepare(
          "SELECT id FROM retrieval_pending_delete WHERE repository=? AND version=?",
        )
        .all(this.repository, this.version) as { id: string }[];
      if (pending.length)
        try {
          for (let offset = 0; offset < pending.length; offset += 1000)
            await this.dense.remove(
              pending.slice(offset, offset + 1000).map((row) => row.id),
              signal,
            );
          this.db
            .prepare(
              "DELETE FROM retrieval_pending_delete WHERE repository=? AND version=?",
            )
            .run(this.repository, this.version);
        } catch (error) {
          if (signal?.aborted) throw error;
          reasons.push(String(error));
        }
    }
    let updated = 0,
      deleted = 0;
    const removeLocal = (file: string) => {
      this.db
        .prepare("DELETE FROM retrieval_fts WHERE repository=? AND path=?")
        .run(this.repository, file);
      this.db
        .prepare("DELETE FROM retrieval_chunks WHERE repository=? AND path=?")
        .run(this.repository, file);
      this.db
        .prepare("DELETE FROM retrieval_files WHERE repository=? AND path=?")
        .run(this.repository, file);
    };
    for (const file of old.keys())
      if (
        !selected.includes(file) &&
        (!changedPaths || changedPaths.includes(file))
      ) {
        const ids = this.rows(file).map((chunk) => chunk.id);
        this.db.transaction(() => removeLocal(file))();
        deleted++;
        if (this.dense)
          try {
            await this.dense.remove(ids, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            for (const id of ids)
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO retrieval_pending_delete VALUES(?,?,?)",
                )
                .run(this.repository, this.version, id);
            reasons.push(String(error));
          }
      }
    for (const file of selected) {
      signal?.throwIfAborted();
      const previous = old.get(file);
      if (
        !rebuild &&
        fingerprints?.[file] === previous?.hash &&
        previous?.version === this.version &&
        (!this.dense || previous.dense_ready)
      )
        continue;
      const content = await this.reader.read(file, signal),
        hash = hashText(content);
      if (
        !rebuild &&
        previous?.hash === hash &&
        previous.version === this.version &&
        (!this.dense || previous.dense_ready)
      )
        continue;
      const chunks = chunkFile(this.repository, file, content, this.version);
      const oldIds = this.rows(file).map((chunk) => chunk.id);
      const obsoleteIds = oldIds.filter(
        (id) => !chunks.some((chunk) => chunk.id === id),
      );
      let ready = 0;
      if (this.dense)
        try {
          await this.dense.upsert(chunks, signal);
          await this.dense.remove(obsoleteIds, signal);
          ready = 1;
        } catch (error) {
          if (signal?.aborted) throw error;
          for (const id of obsoleteIds)
            this.db
              .prepare(
                "INSERT OR IGNORE INTO retrieval_pending_delete VALUES(?,?,?)",
              )
              .run(this.repository, this.version, id);
          reasons.push(String(error));
        }
      this.db.transaction(() => {
        removeLocal(file);
        this.db
          .prepare("INSERT INTO retrieval_files VALUES(?,?,?,?,?)")
          .run(this.repository, file, hash, this.version, ready);
        for (const chunk of chunks) {
          this.db
            .prepare("INSERT INTO retrieval_chunks VALUES(?,?,?,?)")
            .run(chunk.id, this.repository, file, JSON.stringify(chunk));
          if (chunk.role !== "parent")
            this.db
              .prepare("INSERT INTO retrieval_fts VALUES(?,?,?,?,?)")
              .run(
                chunk.id,
                this.repository,
                file,
                chunk.symbol,
                chunk.content,
              );
        }
      })();
      updated++;
    }
    if (!this.dense)
      reasons.push(
        "Embedding configuration or authorization missing; indexed keyword search only",
      );
    return {
      updated,
      deleted,
      files: (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM retrieval_files WHERE repository=?",
          )
          .get(this.repository) as { count: number }
      ).count,
      dense: Boolean(this.dense) && reasons.length === 0,
      reasons: [...new Set(reasons)],
    };
  }
  async search(
    query: string,
    limit = 10,
    signal?: AbortSignal,
    preferredPaths: string[] = [],
    sourceSnapshotFresh = false,
  ) {
    if (
      !query.trim() ||
      query.length > 500 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error("Invalid retrieval query or limit");
    const started = Date.now();
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 30) ?? [];
    const expression = tokens
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" OR ");
    const keywords = expression
      ? (
          this.db
            .prepare(
              "SELECT id FROM retrieval_fts WHERE retrieval_fts MATCH ? AND repository=? ORDER BY bm25(retrieval_fts) LIMIT ?",
            )
            .all(expression, this.repository, limit * 3) as { id: string }[]
        ).map((row) => row.id)
      : [];
    let vectors: string[] = [],
      reason: string | undefined;
    if (this.dense)
      try {
        vectors = await this.dense.search(
          query,
          this.repository,
          limit * 3,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        reason = String(error);
      }
    else
      reason =
        "Embedding configuration or authorization missing; keyword fallback";
    const ranking = rrf([keywords, vectors]),
      chunks = new Map(
        this.rows()
          .filter((chunk) => isIndexableFile(chunk.path, this.options))
          .map((chunk) => [chunk.id, chunk]),
      );
    const live = new Map<string, string>();
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const candidates = new Map<string, Chunk[]>();
    for (const chunk of chunks.values()) {
      if (chunk.parentId)
        candidates.set(chunk.parentId, [
          ...(candidates.get(chunk.parentId) ?? []),
          chunk,
        ]);
    }
    const leaves = (chunk: Chunk): Chunk[] =>
      chunk.role === "parent"
        ? (candidates.get(chunk.id) ?? []).flatMap(leaves)
        : [chunk];
    // Rank before reading source; only the winning candidates cross the boundary.
    ranking.sort(
      (a, b) =>
        b.score +
        (preferredPaths.includes(chunks.get(b.id)?.path ?? "") ? 0.001 : 0) -
        (a.score +
          (preferredPaths.includes(chunks.get(a.id)?.path ?? "") ? 0.001 : 0)),
    );
    if (!sourceSnapshotFresh && this.reader.readMany) {
      const paths = [
        ...new Set(
          ranking
            .flatMap((item) => {
              const chunk = chunks.get(item.id);
              return chunk ? leaves(chunk).map((leaf) => leaf.path) : [];
            })
            .slice(0, limit),
        ),
      ];
      if (paths.length)
        for (const [file, content] of Object.entries(
          await this.reader.readMany(paths, signal),
        ))
          live.set(file, content);
    }
    for (const item of ranking) {
      if (hits.length >= limit) break;
      signal?.throwIfAborted();
      const ranked = chunks.get(item.id);
      if (!ranked) continue; // Remote orphan points never become evidence.
      for (const chunk of leaves(ranked)) {
        if (hits.length >= limit) break;
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        if (sourceSnapshotFresh) {
          // Callers may skip this duplicate read only immediately after update().
          hits.push({
            ...chunk,
            score: item.score,
            source: "indexed",
            parents: parentContexts(chunk, chunks),
          });
          continue;
        }
        let current: string;
        try {
          current =
            live.get(chunk.path) ??
            (await this.reader.read(chunk.path, signal));
          live.set(chunk.path, current);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (/ENOENT|not found/i.test(String(error))) continue;
          throw error;
        }
        if (hashText(current) !== chunk.fileHash) {
          const fresh = chunkFile(
            this.repository,
            chunk.path,
            current,
            `live:${hashText(current)}`,
          );
          const matching = fresh.find(
            (candidate) => candidate.symbol === chunk.symbol,
          );
          if (matching)
            hits.push({
              ...matching,
              score: item.score,
              source: "live",
              parents: parentContexts(
                matching,
                new Map(fresh.map((entry) => [entry.id, entry])),
              ),
            });
        } else
          hits.push({
            ...chunk,
            score: item.score,
            source: "indexed",
            parents: parentContexts(chunk, chunks),
          });
      }
    }
    // Diff/module hints only break close ranks; they never fabricate evidence.
    hits.sort(
      (a, b) =>
        b.score +
          (preferredPaths.includes(b.path) ? 0.001 : 0) -
          (a.score + (preferredPaths.includes(a.path) ? 0.001 : 0)) ||
        a.path.localeCompare(b.path),
    );
    return {
      mode: reason ? "keyword" : "hybrid",
      reason,
      latencyMs: Date.now() - started,
      hits: hits.slice(0, limit),
    };
  }
}
