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
    try {
      mkdirSync(path.join(root, "cache", "tmp"), { recursive: true });
      process.env.NEWAGENT_TEMP = path.join(root, "cache", "tmp");
      release = acquireProcessLock(root);
      store = new Store(path.join(root, "data"));
      flow = new Workflow(root, store, new PiAgent(root));
      selected = undefined;
      ctx.ui.setStatus("delivery", "研发交付 · /delivery");
      ctx.ui.notify(
        "直接描述开发需求，我会调用交付工具；/delivery 可查看任务和证据。",
        "info",
      );
      timer = setInterval(() => {
        try {
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

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n你是 NewAgent 研发协作助手。开发由当前完整原生 Pi 会话负责，不启动另一个开发 Agent。需要交付追踪时先调用 delivery_agent inspect，根据用户上下文选择仓库，歧义时询问；提炼需求和验收条件后 create，再 prepare 获取隔离 workspace 和分支。无需用户输入 /delivery。之后用原生 read/edit/write/bash 在该 workspace 开发和补充测试，每个命令明确工作目录；不得修改原仓库或任务库。完成后调用 validate，运行静态检查、功能测试、独立工程质量 Review。检查失败或 Review 阻塞时，在当前 Pi 会话修复该 workspace，再 validate；最多三轮自动返修，仍失败交给用户。不要削弱测试或检查配置来通过。Review 关注可读性、重复冗余、职责和模块边界、复用现有模块、需求所需的扩展性；避免过度设计。没有静态检查配置时由 AI 审查静态风险和代码规范，明确这是 AI 判断而非编译器/lint 通过，不因此阻塞流程。ready_for_pr 表示当前版本检查完成，不等于已发布。sync 同步 CI；publish 必须经界面确认。",
  }));
  pi.registerTool({
    name: "delivery_agent",
    label: "研发交付",
    description:
      "从自然语言需求创建并执行研发任务，开发使用当前原生 Pi 会话。inspect 查看仓库；create 创建；prepare 准备隔离 workspace；validate 执行静态检查、测试和只读工程质量审查，失败后由当前 Pi 修复；run 是 validate 的兼容别名；status 查看证据；pause 暂停；sync 同步 CI；publish 确认后推送 PR。",
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
          tasks: current.store
            .list()
            .map((t) => ({
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
            params.action === "prepare" ? "prepare" : "validate",
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
              ? "Use native Pi tools in task.workspace, then validate"
              : "Inspect checks/review; fix in current Pi session and validate again if blocked",
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
              action === "prepare" ? "prepare" : "validate",
            );
            ctx.ui.notify("已开始执行，进度显示在终端下方。", "info");
            break;
          case "feedback": {
            const feedback = await ctx.ui.editor("需要开发者处理的意见");
            if (feedback?.trim())
              current.flow.run(selected, feedback, "validate");
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
