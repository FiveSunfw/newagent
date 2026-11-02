import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store } from "../state/store.js";
import { Workflow } from "../core/workflow.js";
import { PiAgent } from "../model-provider/pi.js";
const root = path.resolve(process.argv[2]);
const taskId = process.argv[3];
const dataRoot = path.resolve("../data");
const rootRelative = path.relative(dataRoot, root);
const evaluationRootName = rootRelative.split(path.sep)[0];
if (
  rootRelative.startsWith("..") ||
  path.isAbsolute(rootRelative) ||
  !/^repository-eval(?:-v[1-9][0-9]*)?$/.test(evaluationRootName)
)
  throw new Error("Worker root outside evaluation directory");
process.env.NEWAGENT_ALLOW_EMBEDDING = "1";
process.env.NEWAGENT_EMBEDDING_API_KEY = "local-only";
class CheckpointStore extends Store {
  override event(id: string, kind: string, body: unknown) {
    super.event(id, kind, body);
    const checkpoint = path.join(root, "restart-checkpoint.json");
    if (
      process.argv[4] === "recovery" &&
      kind === "tool_result" &&
      !existsSync(checkpoint)
    ) {
      const result = z
        .object({ tool: z.string(), role: z.string() })
        .safeParse(body);
      if (
        result.success &&
        ["write_file", "replace_text"].includes(result.data.tool) &&
        result.data.role === "developer"
      ) {
        writeFileSync(
          checkpoint,
          JSON.stringify({
            taskId: id,
            at: new Date().toISOString(),
            reason: "Intentional worker exit after completed sandbox write",
          }),
        );
        this.close();
        process.exit(69);
      }
    }
  }
}
const store = new CheckpointStore(path.join(root, "data"));
const flow = new Workflow(root, store, new PiAgent(root));
try {
  flow.run(taskId);
  await flow.waitForRun();
  console.log(JSON.stringify(store.get(taskId)));
} finally {
  await flow.shutdown();
  store.close();
}
