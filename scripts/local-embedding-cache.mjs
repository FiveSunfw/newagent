import http from "node:http";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
const directory = path.resolve("../cache/embedding/vectors-v1");
mkdirSync(directory, { recursive: true });
const version = "qwen3-embedding-0.6b-cpu-leftpad-last-v1";
let queue = Promise.resolve();
const model = "Qwen/Qwen3-Embedding-0.6B";
function cached(text) {
  const key = createHash("sha256")
    .update(version + "\0" + text)
    .digest("hex");
  const file = path.join(directory, key + ".json");
  return {
    file,
    vector: existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : undefined,
  };
}
function trimCache() {
  const files = readdirSync(directory).filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name),
  );
  if (files.length <= 4096) return;
  files.sort(
    (a, b) =>
      statSync(path.join(directory, a)).mtimeMs -
      statSync(path.join(directory, b)).mtimeMs,
  );
  for (const file of files.slice(0, files.length - 4096))
    unlinkSync(path.join(directory, file));
}
http
  .createServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            model,
            dimensions: 1024,
            device: "cpu",
            cacheVersion: version,
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        res.writeHead(404);
        res.end();
        return;
      }
      let length = 0;
      const parts = [];
      for await (const part of req) {
        length += part.length;
        if (length > 2000000) throw Error("Embedding request too large");
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString());
      if (
        body.model !== model ||
        !Array.isArray(body.input) ||
        body.input.length < 1 ||
        body.input.length > 32 ||
        body.input.some((v) => typeof v !== "string" || v.length > 300000)
      )
        throw Error("Invalid local embedding request");
      const run = async () => {
        const entries = body.input.map(cached);
        const missing = entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => !entry.vector);
        if (missing.length) {
          const response = await fetch("http://127.0.0.1:18091/v1/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              input: missing.map(({ index }) => body.input[index]),
            }),
            signal: AbortSignal.timeout(180000),
          });
          if (!response.ok)
            throw Error(`CPU embedding HTTP ${response.status}`);
          const output = await response.json();
          if (
            !Array.isArray(output.data) ||
            output.data.length !== missing.length
          )
            throw Error("Invalid embedding rows");
          for (const row of output.data) {
            const item = missing[row.index];
            if (
              !item ||
              !Array.isArray(row.embedding) ||
              row.embedding.length !== 1024 ||
              row.embedding.some(
                (v) => typeof v !== "number" || !Number.isFinite(v),
              )
            )
              throw Error("Invalid embedding vector");
            item.entry.vector = row.embedding;
            writeFileSync(item.entry.file, JSON.stringify(row.embedding));
          }
          trimCache();
        }
        return {
          object: "list",
          model,
          data: entries.map((entry, index) => ({
            object: "embedding",
            index,
            embedding: entry.vector,
          })),
          cache: {
            hits: entries.length - missing.length,
            misses: missing.length,
            version,
          },
        };
      };
      const result = queue.then(run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      const output = await result;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(output));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  })
  .listen(18092, "127.0.0.1", () =>
    console.log("Local embedding cache on 127.0.0.1:18092"),
  );
