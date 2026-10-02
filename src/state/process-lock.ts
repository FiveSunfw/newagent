import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
export function acquireProcessLock(root: string) {
  const dir = path.join(root, "data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "runtime.lock");
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const pid = Number(readFileSync(file, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ESRCH")
        alive = false;
      else throw e;
    }
    if (alive)
      throw new Error(
        "NewAgent service or evaluator is already running; stop it before starting another process",
      );
    unlinkSync(file);
    writeFileSync(file, String(process.pid), { flag: "wx" });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ENOENT")
        throw e;
    }
  };
  process.once("exit", release);
  return release;
}
