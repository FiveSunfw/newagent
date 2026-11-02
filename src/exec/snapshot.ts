import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

const excluded = new Set([
  ".git",
  ".npmrc",
  ".pypirc",
  ".aws",
  ".ssh",
  ".docker",
  "node_modules",
  "dist",
  "coverage",
  ".next",
]);
export function privateEntry(name: string) {
  return (
    excluded.has(name.toLowerCase()) ||
    name.toLowerCase().startsWith(".env") ||
    /(?:credentials|secrets|\.pem$|\.key$)/i.test(name)
  );
}
/** Fresh snapshot excludes credentials and rejects symlinks, including dependency links. */
export function createSnapshot(source: string, destination: string) {
  const root = realpathSync(source);
  const target = path.resolve(destination);
  const relative = path.relative(root, target);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw new Error("Snapshot must be outside source");
  mkdirSync(target, { recursive: false });
  const copy = (from: string, to: string) => {
    for (const item of readdirSync(from, { withFileTypes: true })) {
      if (privateEntry(item.name)) continue;
      const entry = path.join(from, item.name);
      if (lstatSync(entry).isSymbolicLink())
        throw new Error(`Snapshot symlink rejected: ${item.name}`);
      const output = path.join(to, item.name);
      if (item.isDirectory()) {
        mkdirSync(output);
        copy(entry, output);
      } else if (item.isFile()) cpSync(entry, output, { dereference: false });
      else throw new Error("Unsupported snapshot entry");
    }
  };
  copy(root, target);
  return target;
}
