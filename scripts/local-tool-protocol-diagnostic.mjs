import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const dataRoot = path.resolve("..", "data");
const outputRoot = path.resolve(
  process.argv[2] ??
    path.join(
      dataRoot,
      "repository-eval-v2",
      "protocol-diagnostic-v2",
      "pi-sdk",
    ),
);
const relativeOutput = path.relative(dataRoot, outputRoot);
if (
  relativeOutput.startsWith("..") ||
  path.isAbsolute(relativeOutput) ||
  !relativeOutput.startsWith("repository-eval-v2" + path.sep)
)
  throw new Error(
    "Protocol diagnostic output must stay under E:\\newagent\\data\\repository-eval-v2",
  );

const baseUrl =
  process.env.NEWAGENT_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(baseUrl).hostname))
  throw new Error("Protocol diagnostic only permits a loopback Ollama endpoint");

const fixturePath = "src/dlv.js";
let fixture =
  "export function dlv(obj, key, def, undef) { return obj || def; }";
const modelId =
  process.env.NEWAGENT_OLLAMA_MODEL ?? "newagent-qwen3-1.7b";
const agentDir = path.join(outputRoot, "data", "pi");
const workspace = path.join(outputRoot, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const modelConfiguration = {
  providers: {
    "local-ollama": {
      baseUrl,
      api: "openai-completions",
      apiKey: "local-only",
      models: [
        {
          id: modelId,
          name: "Loopback Ollama tool protocol diagnostic",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 512,
          samplingParams: {
            temperature: 0.7,
            top_p: 0.8,
            presence_penalty: 1.5,
            max_tokens: 512,
          },
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
          },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};
const modelsPath = path.join(agentDir, "models.json");
writeFileSync(modelsPath, JSON.stringify(modelConfiguration, null, 2));

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath,
  modelsStorePath: path.join(agentDir, "catalog.json"),
  allowModelNetwork: false,
});
const model = runtime.getModel("local-ollama", modelId);
if (!model) throw new Error("Configured loopback Ollama model was not loaded");

function toolResult(text) {
  return { content: [{ type: "text", text }], details: undefined };
}

const readTool = {
  name: "read_file",
  label: "Read isolated fixture",
  description:
    "Read the one in-memory fixture by its exact workspace-relative path.",
  parameters: Type.Object({ path: Type.String() }),
  async execute(_id, input) {
    if (input.path !== fixturePath) throw new Error("Unknown fixture path");
    return toolResult("1: " + fixture);
  },
};
const replaceTool = {
  name: "replace_text",
  label: "Replace isolated fixture text",
  description:
    "Replace one exact unique substring in the one in-memory fixture.",
  parameters: Type.Object({
    path: Type.String(),
    before: Type.String(),
    after: Type.String(),
  }),
  async execute(_id, input) {
    if (input.path !== fixturePath) throw new Error("Unknown fixture path");
    if (!input.before || input.before === input.after)
      throw new Error("Invalid replacement");
    const count = fixture.split(input.before).length - 1;
    if (count !== 1) throw new Error("Source match count was " + count);
    fixture = fixture.replace(input.before, input.after);
    return toolResult("Updated one source occurrence");
  },
};

function summarizePart(part) {
  if (part.type === "text") {
    const text = part.text ?? "";
    return {
      type: part.type,
      chars: text.length,
      pseudoToolMarkup:
        /<\/?tool_call>|"name"\s*:\s*"(?:read_file|replace_text)"/i.test(
          text,
        ),
    };
  }
  if (part.type === "thinking")
    return { type: part.type, chars: (part.thinking ?? "").length };
  if (part.type === "toolCall")
    return {
      type: part.type,
      name: part.name,
      arguments: part.arguments,
    };
  return { type: part.type };
}

async function runStage(name, tools, prompt) {
  const settingsManager = SettingsManager.inMemory({
    compaction: { reserveTokens: 1024, keepRecentTokens: 1365 },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      "You are testing structured tool handling. Use only the tools explicitly provided. Never print pseudo tool markup as ordinary text.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime: runtime,
    thinkingLevel: "off",
    model,
    settingsManager,
    resourceLoader: loader,
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    sessionManager: SessionManager.inMemory(workspace),
  });
  const events = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      events.push({
        kind: "tool_start",
        name: event.toolName,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      events.push({
        kind: "tool_end",
        name: event.toolName,
        isError: event.isError,
      });
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      events.push({
        kind: "assistant_message",
        stopReason: event.message.stopReason,
        content: event.message.content.map(summarizePart),
        usage: event.message.usage,
      });
    }
  });
  const timeout = setTimeout(() => void session.abort(), 120_000);
  let error;
  let finalText = "";
  try {
    await session.prompt(prompt);
    finalText = session.getLastAssistantText() ?? "";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    session.dispose();
  }
  return { name, events, finalText, error };
}

const read = await runStage(
  "read_file",
  [readTool],
  "Call read_file exactly once with path src/dlv.js. After its result, reply DONE.",
);
const replacement = await runStage(
  "replace_text",
  [replaceTool],
  'Call replace_text exactly once with path src/dlv.js, before "return obj || def;", and after "return obj === undefined ? def : obj;". After its result, reply DONE.',
);
const final = await runStage(
  "normal_final",
  [],
  "Return the single word DONE and nothing else.",
);

const readCalls = read.events.filter((event) => event.kind === "tool_start");
const replaceCalls = replacement.events.filter(
  (event) => event.kind === "tool_start",
);
const report = {
  model: modelId,
  endpoint: baseUrl,
  provider: "Pi SDK 0.99.2 / openai-completions",
  mode: {
    rag: false,
    reflexion: false,
    multiAgent: false,
    toolsAreInMemoryFixtures: true,
  },
  sampling:
    modelConfiguration.providers["local-ollama"].models[0].samplingParams,
  stages: [read, replacement, final],
  protocolChecks: {
    readToolObserved:
      readCalls.length === 1 &&
      readCalls[0].name === "read_file" &&
      readCalls[0].args.path === fixturePath,
    replaceToolObserved:
      replaceCalls.length === 1 &&
      replaceCalls[0].name === "replace_text" &&
      replaceCalls[0].args.before === "return obj || def;" &&
      replaceCalls[0].args.after === "return obj === undefined ? def : obj;",
    mockEditApplied: fixture.includes(
      "return obj === undefined ? def : obj;",
    ),
    normalStopObserved: /^done[.!]?$/i.test(final.finalText.trim()),
  },
  fixtureAfter: fixture,
  limitation:
    "Three constrained SDK protocol probes, not a code-repair acceptance result.",
};
report.protocolChecks.allPassed = Object.values(report.protocolChecks).every(
  (value) => value === true,
);
mkdirSync(outputRoot, { recursive: true });
writeFileSync(
  path.join(outputRoot, "result.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
