import { codeChunks } from "./code-chunks.js";
import { hashText, type Chunk } from "./chunk-types.js";
export { hashText, type Chunk } from "./chunk-types.js";
import path from "node:path";
export const CHUNK_VERSION = "chunks-v5-parent-child";
export function chunkFile(
  repository: string,
  file: string,
  content: string,
  indexVersion: string,
): Chunk[] {
  if (content.includes("\0") || content.length > 300000) return [];
  const lines = content.split("\n"),
    fileHash = hashText(content),
    chunks: Chunk[] = [];
  const ranges = new Set<string>();
  const add = (symbol: string, start: number, end: number) => {
    for (let line = start; line <= end; line += 140) {
      const endLine = Math.min(end, line + 159);
      // Several AST statements can share one physical line and identical evidence.
      const range = JSON.stringify([symbol, line, endLine]);
      if (ranges.has(range)) {
        if (endLine === end) break;
        continue;
      }
      ranges.add(range);
      const text = lines.slice(line - 1, endLine).join("\n");
      if (!text.trim()) continue;
      const raw = hashText(
        JSON.stringify([
          repository,
          file,
          symbol,
          line,
          endLine,
          fileHash,
          indexVersion,
        ]),
      ).slice(0, 32);
      chunks.push({
        id: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`,
        repository,
        path: file,
        symbol,
        startLine: line,
        endLine,
        fileHash,
        indexVersion,
        content: text,
      });
      if (endLine === end) break;
    }
  };
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    return codeChunks(repository, file, content, indexVersion);
  } else if (path.extname(file).toLowerCase() === ".md") {
    let heading = "document",
      start = 1;
    for (let i = 0; i < lines.length; i++)
      if (/^#{1,6}\s+/.test(lines[i])) {
        if (i + 1 > start) add(heading, start, i);
        heading = lines[i].replace(/^#+\s+/, "").trim();
        start = i + 1;
      }
    add(heading, start, lines.length);
  } else add("lines", 1, lines.length);
  return chunks;
}
export function rrf(rankings: string[][], k = 60) {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    for (const [index, id] of [...new Set(ranking)].entries())
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  return [...scores]
    .sort(([a, sa], [b, sb]) => sb - sa || a.localeCompare(b))
    .map(([id, score]) => ({ id, score }));
}
