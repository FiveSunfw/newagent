import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../state/store.js";
import { acquireProcessLock } from "../state/process-lock.js";
import { TaskExecution } from "../exec/task-execution.js";
import { RunBudget } from "../core/harness.js";
import { Workflow } from "../core/workflow.js";
import { PiAgent } from "../model-provider/pi.js";
import { searchRepository } from "../retrieval/service.js";
import { redact } from "../state/redaction.js";

export function createMcpServer(root: string, taskId: string, store: Store) {
  const flow = new Workflow(root, store, new PiAgent(root));
  store.get(taskId);
  const server = new McpServer({ name: "newagent-local", version: "0.1.0" });
  let busy = false;
  async function tool(
    name: string,
    action: (boundary: TaskExecution, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    if (busy) throw new Error("Another MCP operation is running");
    busy = true;
    const task = store.get(taskId),
      profile = flow.profile(task),
      budget = new RunBudget(profile.runLimits ?? {}, task.budget);
    const started = Date.now();
    try {
      budget.consumeTool(signal);
      task.budget = budget.snapshot();
      store.save(task);
      const executionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(600000, budget.remainingMs())),
      ]);
      const output = redact(
        await action(new TaskExecution(root, task, profile), executionSignal),
      );
      store.event(taskId, "mcp_result", {
        name,
        durationMs: Date.now() - started,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
      };
    } catch (error) {
      store.event(taskId, "mcp_failure", {
        name,
        durationMs: Date.now() - started,
        message: String(error),
      });
      throw error;
    } finally {
      busy = false;
    }
  }
  server.registerTool(
    "repository_search",
    {
      description:
        "Search this bound task repository with indexed evidence and explicit fallback",
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(20).default(10),
      },
    },
    (input, extra) =>
      tool(
        "repository_search",
        (boundary, signal) =>
          searchRepository(
            root,
            store.get(taskId).profileId,
            boundary,
            input.query,
            input.limit,
            signal,
          ),
        extra.signal,
      ),
  );
  server.registerTool(
    "file_read",
    {
      description:
        "Read current source in this bound task; private/traversal paths denied",
      inputSchema: { path: z.string().min(1).max(1000) },
    },
    (input, extra) =>
      tool(
        "file_read",
        (boundary, signal) => boundary.read(input.path, signal),
        extra.signal,
      ),
  );
  server.registerTool(
    "verification_run",
    {
      description:
        "Run administrator configured checks through the same execution boundary; cannot publish or mint Review approval",
      inputSchema: {},
    },
    (_input, extra) =>
      tool(
        "verification_run",
        async (_boundary, signal) => {
          const task = store.get(taskId);
          return flow.checks(task, flow.profile(task), "check", signal);
        },
        extra.signal,
      ),
  );
  server.registerTool(
    "verification_evidence",
    {
      description: "Get recorded validation evidence for this bound task",
      inputSchema: {},
    },
    (_input, extra) =>
      tool(
        "verification_evidence",
        async () => ({ task: store.get(taskId), checks: store.checks(taskId) }),
        extra.signal,
      ),
  );
  return server;
}
async function main() {
  const root = path.resolve(
    process.env.NEWAGENT_ROOT ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  );
  const taskId = process.argv[2];
  if (!taskId)
    throw new Error("Usage: newagent-mcp TASK_ID (local stdio only)");
  const release = acquireProcessLock(root),
    store = new Store(path.join(root, "data"));
  try {
    const server = createMcpServer(root, taskId, store);
    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1048576,
    });
    transport.onclose = () => {
      store.close();
      release();
    };
    await server.connect(transport);
  } catch (error) {
    store.close();
    release();
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
