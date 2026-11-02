import type { SearchHit } from "./repository-index.js";

const codeChangeIntent =
  /修复|实现|修正|修改|恢复|支持|调整|增加|删除|缺陷|回归|错误|必须|应当|\b(?:fix|implement|correct|modify|restore|support|add|remove|refactor|regression|bug|defect|must|should|return|serialize|serialize|preserve)\b/i;
const nonImplementationDirectories = new Set([
  "test",
  "tests",
  "__tests__",
  "example",
  "examples",
  "benchmark",
  "benchmarks",
  "doc",
  "docs",
]);
const sourceExtensions =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|c|h|cc|cpp|php|rb|swift|kt)$/i;

function isImplementationFile(file: string) {
  const normalized = file.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  if (
    segments.some((segment) =>
      nonImplementationDirectories.has(segment.toLowerCase()),
    ) ||
    /^(?:readme|changelog|contributing|license|code_of_conduct)(?:\.|$)/i.test(
      name,
    ) ||
    /^package(?:-lock)?\.json$/i.test(name) ||
    normalized.startsWith(".")
  )
    return false;
  return sourceExtensions.test(name);
}

/** Keep implementation candidates ahead of tests, demos, and docs for code-change tasks. */
export function selectInitialCodeContext(
  hits: SearchHit[],
  requirement: string,
  limit = 3,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Invalid repository context limit");
  const ordered = hits;
  if (!codeChangeIntent.test(requirement)) return ordered.slice(0, limit);
  const implementations = ordered.filter((hit) =>
    isImplementationFile(hit.path),
  );
  if (!implementations.length) return ordered.slice(0, limit);
  const implementationIds = new Set(implementations.map((hit) => hit.id));
  return [
    ...implementations,
    ...ordered.filter((hit) => !implementationIds.has(hit.id)),
  ].slice(0, limit);
}
