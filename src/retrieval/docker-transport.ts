import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { execute } from "../exec/execution.js";
/** Local Qdrant HTTP carried over a container on its internal-only network. No host mounts. */
export function internalQdrantFetch(root: string, image: string): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/(collections(?:\/|$)|healthz$)/.test(url.pathname)
    )
      throw new Error(
        "Internal transport only supports local Qdrant endpoints",
      );
    const method = init.method ?? "GET";
    if (!["GET", "POST", "PUT", "DELETE"].includes(method))
      throw new Error("Unsupported Qdrant method");
    const name = `newagent-qdrant-proxy-${randomUUID()}`;
    const environment = { DOCKER_CONFIG: path.join(root, "cache", "docker") };
    const signal = init.signal ?? undefined;
    const payload = JSON.stringify({
      path: url.pathname + url.search,
      method,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    if (payload.length > 2000000)
      throw new Error(
        "Internal Qdrant request exceeds command transport limit",
      );
    try {
      const result = await execute(
        "docker",
        [
          "run",
          "--rm",
          "--interactive",
          "--name",
          name,
          "--pull=never",
          "--network",
          "newagent-retrieval",
          "--read-only",
          "--user",
          "1000:1000",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--cpus",
          "1",
          "--memory",
          "128m",
          "--pids-limit",
          "32",
          image,
          "node",
          "-e",
          `const p=JSON.parse(require('node:fs').readFileSync(0,'utf8'));fetch('http://qdrant:6333'+p.path,{method:p.method,body:p.body,headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(12000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>{console.error(e.message);process.exitCode=1})`,
        ],
        root,
        signal,
        15000,
        undefined,
        environment,
        payload,
      );
      if (result.exitCode !== 0 || result.timedOut)
        throw new Error(`Internal Qdrant transport failed: ${result.stderr}`);
      const response = z
        .object({ status: z.number().int(), body: z.string() })
        .parse(JSON.parse(result.stdout));
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      const removed = await execute(
        "docker",
        ["rm", "--force", name],
        root,
        undefined,
        15000,
        undefined,
        environment,
      );
      if (
        removed.timedOut ||
        (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr))
      )
        throw new Error(`Internal Qdrant proxy cleanup failed: ${name}`);
    }
  };
}
