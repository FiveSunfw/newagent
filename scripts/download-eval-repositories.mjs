import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve("..");
const pins = [
  ["mitt", "developit/mitt", "6b41670516ed8e8b738612f60491995470aa63b3"],
  [
    "fast-json-stable-stringify",
    "epoberezkin/fast-json-stable-stringify",
    "49e230da2c84247b29ad4de02c9395793caefd15",
  ],
  ["dlv", "developit/dlv", "3212139c05647ffe3f1b095acd46afa2f5f635dd"],
];
for (const [name, repo, sha] of pins) {
  const target = path.join(root, "upstream", "eval", name);
  const metadata = path.join(target, "upstream.json");
  if (existsSync(metadata)) {
    const prior = JSON.parse(readFileSync(metadata, "utf8"));
    if (prior.repo !== repo || prior.sha !== sha)
      throw new Error("Upstream pin mismatch");
    console.log(`${name}: existing pinned snapshot`);
    continue;
  }
  if (existsSync(target)) throw new Error(`Partial download exists: ${target}`);
  const url = `https://api.github.com/repos/${repo}/tarball/${sha}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "newagent-evaluation" },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(`GitHub download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10000000)
    throw new Error("Repository archive exceeds 10MB cap");
  const cache = path.join(root, "cache", "eval-downloads");
  mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `${name}-${sha}.tar.gz`);
  writeFileSync(archive, bytes);
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr);
  for (const entry of listing.stdout.trim().split("\n")) {
    if (entry.startsWith("/") || entry.split(/[\\/]/).includes(".."))
      throw new Error("Unsafe archive entry");
  }
  mkdirSync(target, { recursive: true });
  const extraction = spawnSync(
    "tar",
    ["-xzf", archive, "-C", target, "--strip-components=1"],
    { encoding: "utf8" },
  );
  if (extraction.status !== 0) throw new Error(extraction.stderr);
  writeFileSync(
    metadata,
    JSON.stringify(
      {
        repo,
        sha,
        url,
        archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(`${name}: ${sha}`);
}
