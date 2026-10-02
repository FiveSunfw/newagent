import { acquireProcessLock } from "../state/process-lock.js";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Store } from "../state/store.js";
import { PiAgent } from "../model-provider/pi.js";
import { Workflow } from "../core/workflow.js";
import { taskInput } from "../protocol/types.js";
const root = path.resolve(
  process.env.NEWAGENT_ROOT ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
);
mkdirSync(path.join(root, "cache", "tmp"), { recursive: true });
process.env.NEWAGENT_TEMP = path.join(root, "cache", "tmp");
process.env.PI_CODING_AGENT_DIR = path.join(root, "data", "pi");
const releaseLock = acquireProcessLock(root);
const store = new Store(path.join(root, "data"));
const workflow = new Workflow(root, store, new PiAgent(root));
const app = Fastify({ logger: false, bodyLimit: 100000 });
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    return reply.code(403).send({ error: "Cross-origin requests are blocked" });
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].some(
      (h) => req.headers.host?.split(":")[0] === h,
    ) &&
    !req.headers.host?.startsWith("[::1]:")
  )
    return reply.code(403).send({ error: "Invalid host" });
});
app.setErrorHandler((error, _req, reply) => {
  const message = error instanceof Error ? error.message : "Operation failed";
  reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: message });
});
app.get("/api/health", async () => ({
  status: "ok",
  root,
  modelConfigured: existsSync(path.join(root, "data", "model.json")),
}));
app.get("/api/profiles", async () =>
  workflow.profiles().map((p) => ({
    id: p.id,
    source: p.source,
    checks: p.checks.map((c) => c.name),
    integration: p.integration.map((c) => c.name),
    github: p.github,
  })),
);
app.get("/api/tasks", async () => store.list());
app.post("/api/tasks", async (req, reply) =>
  reply.code(201).send(workflow.create(taskInput.parse(req.body))),
);
app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => ({
  task: store.get(req.params.id),
  events: store.events(req.params.id),
  checks: store.checks(req.params.id),
}));
app.post<{ Params: { id: string } }>("/api/tasks/:id/run", async (req) => {
  const body = z
    .object({ feedback: z.string().max(20000).optional() })
    .parse(req.body ?? {});
  return workflow.run(req.params.id, body.feedback);
});
app.post<{ Params: { id: string } }>("/api/tasks/:id/pause", async (req) => {
  workflow.pause(req.params.id);
  return { ok: true };
});
app.post<{ Params: { id: string } }>("/api/tasks/:id/publish", async (req) => {
  z.object({ approve: z.literal(true) }).parse(req.body);
  return workflow.publish(req.params.id);
});
app.post<{ Params: { id: string } }>("/api/tasks/:id/refresh", async (req) =>
  workflow.refresh(req.params.id),
);
app.get<{ Params: { id: string } }>("/api/tasks/:id/diff", async (req) => ({
  diff: await workflow.diff(req.params.id),
}));
app.get<{ Params: { id: string; seq: string } }>(
  "/api/tasks/:id/log/:seq",
  async (req) => {
    const check = store.checks(req.params.id)[Number(req.params.seq)];
    if (!check) throw new Error("Check not found");
    return { log: readFileSync(check.log, "utf8").slice(-200000) };
  },
);
const web = path.join(root, "app", "web-dist");
if (existsSync(web)) await app.register(staticPlugin, { root: web });
app.addHook("onClose", async () => {
  await workflow.shutdown();
  store.close();
  releaseLock();
});
await app.listen({ host: "127.0.0.1", port: 4780 });
console.log("NewAgent: http://127.0.0.1:4780");
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void app.close());
