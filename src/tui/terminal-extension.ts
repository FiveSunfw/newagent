import { Type } from "typebox";
import path from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Store } from "../state/store.js";
import { Workflow } from "../core/workflow.js";
import { PiAgent } from "../model-provider/pi.js";
import { acquireProcessLock } from "../state/process-lock.js";
import { taskInput, type Task } from "../protocol/types.js";
import { memoryInput } from "../memory/service.js";
const actions = [
  "new",
  "list",
  "status",
  "prepare",
  "validate",
  "run",
  "pause",
  "feedback",
  "review",
  "checks",
  "diff",
  "log",
  "publish",
  "sync",
  "help",
];
export function resolveTask(
  tasks: Task[],
  value: string | undefined,
  selected: string | undefined,
) {
  if (!value) {
    if (!selected) throw new Error("先创建或选择任务");
    return selected;
  }
  const matches = tasks.filter((t) => t.id === value || t.id.startsWith(value));
  if (matches.length !== 1)
    throw new Error(matches.length ? "任务 ID 前缀不唯一" : "找不到任务");
  return matches[0].id;
}
export function taskSummary(t: Task) {
  return [
    `任务 ${t.id}`,
    `需求：${t.requirement}`,
    `阶段：${t.status} · 返修 ${t.round}`,
    `分支：${t.branch}`,
    `版本：${t.revision.slice(0, 16) || "尚未生成"}`,
    `验收：${t.acceptance.join("；")}`,
    ...(t.error ? [`阻塞：${t.error}`] : []),
    ...(t.assessment
      ? [`发布评估：${t.assessment.verdict}`, ...t.assessment.reasons]
      : []),
  ].join("\n");
}
export default function deliveryExtension(pi: ExtensionAPI) {
  const root = path.resolve(
    process.env.NEWAGENT_ROOT ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  );
  let store: Store | undefined,
    flow: Workflow | undefined,
    release: (() => void) | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    selected: string | undefined,
    lastStatus = "";
  const display = (text: string) =>
    pi.sendMessage({ customType: "delivery", content: text, display: true });
  const state = () => {
    if (!store || !flow) throw new Error("终端流程未初始化，检查启动提示");
    return { store, flow };
  };
  function refresh(ctx: ExtensionContext) {
    if (!selected || !store) return;
    const task = store.get(selected);
    ctx.ui.setStatus("delivery", `${task.status} · ${task.id.slice(0, 8)}`);
    const events = store.events(task.id);
    const last = events.at(-1);
    ctx.ui.setWidget("delivery", [
      `研发交付 · ${task.requirement}`,
      `阶段 ${task.status} | 返修 ${task.round} | 版本 ${task.revision.slice(0, 10) || "-"}`,
      `最新记录 ${last?.kind ?? "-"} | /delivery status 查看详情`,
    ]);
    if (lastStatus !== task.status) {
      lastStatus = task.status;
      if (
        ["blocked", "ready_for_pr", "complete", "paused"].includes(task.status)
      )
        display(taskSummary(task));
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number) {
          return [
            theme.fg("accent", "NewAgent".slice(0, width)),
            theme.fg("dim", "Type a request | /delivery help".slice(0, width)),
          ];
        },
        invalidate() {
          // The header is rendered directly and keeps no layout cache.
        },
      }));
      ctx.ui.setTitle("NewAgent");
    }
    try {
      mkdirSync(path.join(root, "cache", "tmp"), { recursive: true });
      process.env.NEWAGENT_TEMP = path.join(root, "cache", "tmp");
      release = acquireProcessLock(root);
      store = new Store(path.join(root, "data"));
      flow = new Workflow(root, store, new PiAgent(root));
      pi.setActiveTools(["delivery_agent", "memory_agent"]);
      selected = undefined;
      ctx.ui.setStatus("delivery", "研发交付 · /delivery");
      ctx.ui.notify(
        "直接描述开发需求，我会调用交付工具；/delivery 可查看任务和证据。",
        "info",
      );
      timer = setInterval(() => {
        try {
          // The upstream UI restores its own title on session changes.
          if (ctx.hasUI) ctx.ui.setTitle("NewAgent");
          refresh(ctx);
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
          if (timer) clearInterval(timer);
        }
      }, 1000);
    } catch (e) {
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
    }
  });
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    await flow?.shutdown();
    store?.close();
    release?.();
    store = undefined;
    flow = undefined;
  });

  pi.on("tool_call", async (event) =>
    ["delivery_agent", "memory_agent"].includes(event.toolName)
      ? undefined
      : {
          block: true,
          reason:
            "Host tools disabled in delivery mode; use the task execution boundary",
        },
  );
  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n你是 NewAgent 研发协作助手。主会话使用 delivery_agent 编排，memory_agent 管理长期记忆，不使用宿主文件或 shell 工具。用户明确表达长期代码风格、偏好或要求记住经验时调用 memory_agent；一次性需求不自动提升为长期偏好，不从模型自己的代码推断用户习惯。项目记忆默认 project 并指定已配置 profileId，只有用户明确表示所有项目通用时使用 user 范围。可保存未经测试的经验，但标注 hypothesis 或 observed，不能假称验证成功。用户要求纠正或忘记时 update/forget。记忆不覆盖当前需求、仓库规范、权限和验收。先 inspect 选择仓库，再 create 提炼需求和验收条件，再 run 调用受控开发、检查与独立只读 Review。无需用户输入 /delivery。Docker 不可用时停止；trusted-host 仅用于明确确认的可信仓库。最多三轮返修。status 查看真实证据。publish 必须经界面确认。",
  }));
  pi.registerTool({
    name: "memory_agent",
    label: "长期记忆",
    description:
      "Mem0 长期记忆：remember 保存用户代码风格/偏好或项目经验；同一偏好使用稳定 key（如 style.indent、style.comments）以更新旧值。search/list 查看；update 纠正；forget 删除。项目范围必须指定已配置 profileId；不传用户身份。",
    parameters: Type.Object({
      action: Type.Union(
        ["remember", "search", "list", "update", "forget"].map((action) =>
          Type.Literal(action),
        ),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("project")]),
      ),
      profileId: Type.Optional(Type.String()),
      kind: Type.Optional(
        Type.Union([Type.Literal("preference"), Type.Literal("experience")]),
      ),
      status: Type.Optional(
        Type.Union(
          ["declared", "inferred", "observed", "hypothesis"].map((value) =>
            Type.Literal(value),
          ),
        ),
      ),
      text: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      memoryId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const input = memoryInput.parse(params),
        current = state();
      if (
        input.scope === "project" &&
        !current.flow
          .profiles()
          .some((profile) => profile.id === input.profileId)
      )
        throw Error("Unknown project profile");
      const result = await current.flow.memory.execute(input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "delivery_agent",
    label: "研发交付",
    description:
      "从自然语言需求创建研发任务。inspect 查看仓库；create 创建；run 使用执行边界开发、验证和独立 Review；prepare 仅准备；validate 仅验证；status 查看证据；pause 暂停；sync 同步 CI；publish 确认后推送 PR。",
    parameters: Type.Object({
      action: Type.Union(
        [
          "inspect",
          "create",
          "prepare",
          "validate",
          "run",
          "status",
          "pause",
          "sync",
          "publish",
        ].map((a) => Type.Literal(a)),
      ),
      taskId: Type.Optional(Type.String()),
      profileId: Type.Optional(Type.String()),
      requirement: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.Array(Type.String())),
      feedback: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = state();
      let output: unknown;
      if (params.action === "inspect") {
        output = {
          profiles: current.flow
            .profiles()
            .map((p) => ({ id: p.id, source: p.source, base: p.base })),
          tasks: current.store.list().map((t) => ({
            id: t.id,
            profileId: t.profileId,
            requirement: t.requirement,
            status: t.status,
          })),
        };
      } else if (params.action === "create") {
        const task = current.flow.create(taskInput.parse(params));
        selected = task.id;
        output = task;
      } else {
        if (!params.taskId) throw new Error("taskId is required");
        selected = resolveTask(current.store.list(), params.taskId, undefined);
        const id = selected;
        if (["prepare", "validate", "run"].includes(params.action)) {
          if (signal?.aborted) throw new Error("Cancelled before task started");
          current.flow.run(
            id,
            params.feedback,
            params.action === "prepare"
              ? "prepare"
              : params.action === "run"
                ? "legacy"
                : "validate",
          );
          const cancel = () => current.flow.pause(id);
          signal?.addEventListener("abort", cancel, { once: true });
          const progress = setInterval(
            () =>
              onUpdate?.({
                content: [
                  { type: "text", text: taskSummary(current.store.get(id)) },
                ],
                details: { taskId: id },
              }),
            1000,
          );
          try {
            await current.flow.waitForRun();
          } finally {
            clearInterval(progress);
            signal?.removeEventListener("abort", cancel);
          }
        } else if (params.action === "pause") current.flow.pause(id);
        else if (params.action === "sync") await current.flow.refresh(id);
        else if (params.action === "publish") {
          if (
            !ctx.hasUI ||
            !(await ctx.ui.confirm(
              "提交草稿 PR",
              "将提交代码、推送分支并创建或更新 PR。确认执行？",
            ))
          )
            throw new Error(
              "PR publication requires explicit user confirmation",
            );
          await current.flow.publish(id);
        }
        output = {
          task: current.store.get(id),
          checks: current.store.checks(id),
          staticReviewMode: current.flow.profile(current.store.get(id))
            .staticChecks.length
            ? "configured_tools_and_ai_review"
            : "ai_review",
          nextStep:
            params.action === "prepare"
              ? "Call run to develop through the task execution boundary"
              : "Inspect checks/review; call run with feedback if blocked",
        };
      }
      refresh(ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        details: {},
      };
    },
  });

  pi.registerCommand("delivery", {
    description: "研发交付：需求、开发、Review、验证与 PR",
    getArgumentCompletions: (prefix) => {
      const matches = actions.filter((a) => a.startsWith(prefix));
      return matches.length
        ? matches.map((a) => ({ value: a, label: a }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const current = state();
        let [action, value] = args.trim().split(/\s+/, 2);
        if (!action) action = (await ctx.ui.select("研发交付", actions)) ?? "";
        if (!action) return;
        if (action === "help") {
          display(
            "/delivery new 创建任务\n/delivery list 选择任务\n/delivery prepare [ID] 准备 Pi 开发工作区\n/delivery validate [ID] 静态检查、测试和质量 Review\n/delivery feedback [ID] 根据补充意见返修\n/delivery status|review|checks|diff|log [ID] 查看证据\n/delivery pause [ID] 暂停\n/delivery publish [ID] 确认后推送并创建/更新草稿 PR\n/delivery sync [ID] 同步 CI，合并后运行集成验证\n退出 Pi 时会暂停任务并保存记录。",
          );
          return;
        }
        if (action === "new") {
          const profile = await ctx.ui.select(
            "选择仓库",
            current.flow.profiles().map((p) => p.id),
          );
          if (!profile) return;
          const requirement = await ctx.ui.editor("功能需求");
          if (!requirement) return;
          const criteria = await ctx.ui.editor("验收条件：每行一项");
          if (!criteria) return;
          const task = current.flow.create(
            taskInput.parse({
              profileId: profile,
              requirement,
              acceptance: criteria
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
            }),
          );
          selected = task.id;
          display(taskSummary(task));
          refresh(ctx);
          return;
        }
        if (action === "list") {
          const tasks = current.store.list();
          if (!tasks.length) {
            display("暂无任务，使用 /delivery new 创建。");
            return;
          }
          const labels = tasks.map(
            (t) =>
              `${t.id.slice(0, 8)} · ${t.status} · ${t.requirement.slice(0, 60)}`,
          );
          const choice = await ctx.ui.select("选择任务", labels);
          if (choice) {
            selected = tasks[labels.indexOf(choice)].id;
            display(taskSummary(current.store.get(selected)));
            refresh(ctx);
          }
          return;
        }
        selected = resolveTask(current.store.list(), value, selected);
        const t = current.store.get(selected);
        switch (action) {
          case "status":
            display(taskSummary(t));
            break;
          case "prepare":
          case "validate":
          case "run":
            current.flow.run(
              selected,
              undefined,
              action === "prepare"
                ? "prepare"
                : action === "run"
                  ? "legacy"
                  : "validate",
            );
            ctx.ui.notify("已开始执行，进度显示在终端下方。", "info");
            break;
          case "feedback": {
            const feedback = await ctx.ui.editor("需要开发者处理的意见");
            if (feedback?.trim())
              current.flow.run(selected, feedback, "legacy");
            break;
          }
          case "pause":
            current.flow.pause(selected);
            break;
          case "review":
            display(
              t.review ? JSON.stringify(t.review, null, 2) : "尚无 Review 结果",
            );
            break;
          case "checks":
            display(
              current.store
                .checks(selected)
                .map(
                  (c, i) =>
                    `${i}: ${c.passed ? "通过" : "失败"} ${c.name} · ${c.kind} · ${c.revision.slice(0, 10)}${c.revision !== t.revision ? " · 旧版本" : ""}`,
                )
                .join("\n") || "尚无检查",
            );
            break;
          case "diff":
            display(
              (await current.flow.diff(selected)).slice(-60000) ||
                "暂无已跟踪文件 diff",
            );
            break;
          case "log": {
            const checks = current.store.checks(selected);
            if (!checks.length) {
              display("尚无检查日志");
              break;
            }
            const options = checks.map(
              (c, i) => `${i} · ${c.name} · ${c.passed ? "通过" : "失败"}`,
            );
            const choice = await ctx.ui.select("选择日志", options);
            if (choice)
              display(
                readFileSync(checks[options.indexOf(choice)].log, "utf8").slice(
                  -60000,
                ),
              );
            break;
          }
          case "publish":
            if (
              await ctx.ui.confirm(
                "提交草稿 PR",
                "将提交代码、推送分支并创建或更新 PR。确认执行？",
              )
            )
              display(
                JSON.stringify(await current.flow.publish(selected), null, 2),
              );
            break;
          case "sync":
            display(
              JSON.stringify(await current.flow.refresh(selected), null, 2),
            );
            break;
          default:
            throw new Error("未知操作，使用 /delivery help");
        }
        refresh(ctx);
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
