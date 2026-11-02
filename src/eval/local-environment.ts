import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { retrievalConfigSchema } from "../retrieval/dense.js";

export const projectRoot = path.resolve("..");
export const siliconFlowDeepseekModelId = "deepseek-ai/DeepSeek-V4-Flash";
export function resolveEvaluationRoot(root: string, version: string) {
  const normalized = version.trim() || "v1";
  if (!/^v[1-9][0-9]*$/.test(normalized))
    throw new Error("NEWAGENT_EVAL_DATASET_VERSION must look like v2");
  return path.join(
    root,
    "data",
    normalized === "v1" ? "repository-eval" : `repository-eval-${normalized}`,
  );
}
export const evaluationDatasetVersion =
  process.env.NEWAGENT_EVAL_DATASET_VERSION?.trim() || "v1";
export const evaluationRoot = resolveEvaluationRoot(
  projectRoot,
  evaluationDatasetVersion,
);
export function evaluationSampling(presencePenalty: unknown = 1.5) {
  return {
    temperature: 0.7,
    topP: 0.8,
    presencePenalty: z
      .number()
      .finite()
      .min(0)
      .max(2)
      .parse(Number(presencePenalty)),
    maxOutputTokens: 2048,
  };
}
export function evaluationContextWindow(value: unknown = 32768) {
  return z
    .union([
      z.literal(4096),
      z.literal(8192),
      z.literal(32768),
      z.literal(262144),
    ])
    .parse(Number(value));
}
export function saveJson(file: string, value: unknown) {
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, file);
}
export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}
export function copyDockerContextMetadata(
  sourceConfig: string,
  targetConfig: string,
) {
  const sourceMetadata = path.join(sourceConfig, "contexts", "meta");
  if (!existsSync(sourceMetadata)) return 0;
  let copied = 0;
  for (const entry of readdirSync(sourceMetadata, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/i.test(entry.name)) continue;
    const source = path.join(sourceMetadata, entry.name, "meta.json");
    if (!existsSync(source)) continue;
    const target = path.join(
      targetConfig,
      "contexts",
      "meta",
      entry.name,
      "meta.json",
    );
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied++;
  }
  return copied;
}
export function configureLocalRun(
  root: string,
  sampling = evaluationSampling(),
  contextWindow = evaluationContextWindow(),
) {
  mkdirSync(path.join(root, "data", "pi"), { recursive: true });
  mkdirSync(path.join(root, "cache", "docker"), { recursive: true });
  cpSync(
    path.join(projectRoot, "data", "sandbox.json"),
    path.join(root, "data", "sandbox.json"),
  );
  cpSync(
    path.join(projectRoot, "cache", "docker", "config.json"),
    path.join(root, "cache", "docker", "config.json"),
  );
  copyDockerContextMetadata(
    path.join(projectRoot, "cache", "docker"),
    path.join(root, "cache", "docker"),
  );
  const retrieval = retrievalConfigSchema.parse(
    readJson(path.join(projectRoot, "data", "retrieval.json")),
  );
  if (
    !new Set(["127.0.0.1", "localhost"]).has(
      new URL(retrieval.embedding.endpoint).hostname,
    )
  )
    throw new Error("Local benchmark forbids remote embedding endpoints");
  saveJson(path.join(root, "data", "retrieval.json"), retrieval);
  saveJson(path.join(root, "data", "model.json"), {
    provider: "local-ollama",
    model:
      contextWindow >= 32768
        ? "newagent-qwen3-1.7b-32k"
        : "newagent-qwen3-1.7b",
  });
  const localModelId =
    contextWindow >= 32768
      ? "newagent-qwen3-1.7b-32k"
      : "newagent-qwen3-1.7b";
  saveJson(path.join(root, "data", "pi", "models.json"), {
    providers: {
      "local-ollama": {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "local-only",
        models: [
          {
            id: localModelId,
            name: "Local Qwen3 1.7B evaluation",
            reasoning: false,
            input: ["text"],
            contextWindow,
            maxTokens: sampling.maxOutputTokens,
            samplingParams: {
              temperature: sampling.temperature,
              top_p: sampling.topP,
              presence_penalty: sampling.presencePenalty,
              reasoning_effort: "none",
              max_tokens: sampling.maxOutputTokens,
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
  });
  process.env.NEWAGENT_ALLOW_EMBEDDING = "1";
  process.env.NEWAGENT_EMBEDDING_API_KEY = "local-only";
}
export function configureDeepseekRun(
  root: string,
  sampling: ReturnType<typeof evaluationSampling>,
  contextWindow: number,
) {
  if (!process.env.DEEPSEEK_API_KEY?.trim())
    throw new Error(
      "DeepSeek comparison requires DEEPSEEK_API_KEY in the process environment",
    );
  const source = z
    .object({ providers: z.record(z.string(), z.unknown()) })
    .parse(readJson(path.join(projectRoot, "data", "pi", "models.json")));
  const provider = z
    .object({
      baseUrl: z.string().url(),
      api: z.literal("openai-completions"),
      models: z.array(z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(source.providers.deepseek);
  if (new URL(provider.baseUrl).hostname !== "api.deepseek.com")
    throw new Error("DeepSeek comparison only permits api.deepseek.com");
  const sourceModel = provider.models.find(
    (candidate) => candidate.id === "deepseek-flash",
  );
  if (!sourceModel)
    throw new Error(
      "Configured DeepSeek provider does not contain deepseek-flash",
    );
  const model = z
    .object({
      id: z.literal("deepseek-flash"),
      name: z.string(),
      reasoning: z.boolean(),
      input: z.array(z.string()),
      compat: z.record(z.string(), z.unknown()).optional(),
      cost: z.unknown().optional(),
    })
    .passthrough()
    .parse(sourceModel);
  const modelConfiguration = {
    ...model,
    contextWindow,
    maxTokens: sampling.maxOutputTokens,
    samplingParams: {
      temperature: sampling.temperature,
      top_p: sampling.topP,
      presence_penalty: sampling.presencePenalty,
      max_tokens: sampling.maxOutputTokens,
    },
  };
  const providerConfiguration = {
    ...provider,
    models: [modelConfiguration],
  } as Record<string, unknown>;
  delete providerConfiguration.apiKey;
  saveJson(path.join(root, "data", "model.json"), {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  saveJson(path.join(root, "data", "pi", "models.json"), {
    providers: { deepseek: providerConfiguration },
  });
}
export function buildSiliconFlowRunConfiguration(
  sourceValue: unknown,
  sampling: ReturnType<typeof evaluationSampling>,
  contextWindow: number,
) {
  const source = z
    .object({ providers: z.record(z.string(), z.unknown()) })
    .parse(sourceValue);
  const provider = z
    .object({
      baseUrl: z.string().url(),
      api: z.literal("openai-completions"),
      models: z.array(z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(source.providers.deepseek);
  if (new URL(provider.baseUrl).hostname !== "api.deepseek.com")
    throw new Error("SiliconFlow setup requires the configured DeepSeek model template");
  const sourceModel = provider.models.find(
    (candidate) => candidate.id === "deepseek-flash",
  );
  if (!sourceModel)
    throw new Error("Configured model template does not contain deepseek-flash");
  const model = z
    .object({
      name: z.string(),
      reasoning: z.boolean(),
      input: z.array(z.string()),
      compat: z.record(z.string(), z.unknown()).optional(),
      cost: z.unknown().optional(),
    })
    .passthrough()
    .parse(sourceModel);
  const modelConfiguration = {
    id: siliconFlowDeepseekModelId,
    name: "DeepSeek V4 Flash via SiliconFlow",
    reasoning: model.reasoning,
    input: model.input,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    contextWindow,
    maxTokens: sampling.maxOutputTokens,
    samplingParams: {
      temperature: sampling.temperature,
      top_p: sampling.topP,
      presence_penalty: sampling.presencePenalty,
      max_tokens: sampling.maxOutputTokens,
      enable_thinking: false,
    },
  };
  const providerConfiguration = {
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    models: [modelConfiguration],
  };
  return {
    model: {
      provider: "siliconflow",
      model: siliconFlowDeepseekModelId,
    },
    providers: { siliconflow: providerConfiguration },
  };
}
export function configureSiliconFlowRun(
  root: string,
  sampling: ReturnType<typeof evaluationSampling>,
  contextWindow: number,
) {
  if (!process.env.NEWAGENT_API_KEY?.trim())
    throw new Error(
      "SiliconFlow comparison requires NEWAGENT_API_KEY in the process environment",
    );
  const source = readJson(path.join(projectRoot, "data", "pi", "models.json"));
  const configuration = buildSiliconFlowRunConfiguration(
    source,
    sampling,
    contextWindow,
  );
  saveJson(
    path.join(root, "data", "model.json"),
    configuration.model,
  );
  saveJson(path.join(root, "data", "pi", "models.json"), {
    providers: configuration.providers,
  });
}
export async function localHealth(
  modelId = "newagent-qwen3-1.7b",
) {
  const embedding = await fetch("http://127.0.0.1:18091/health", {
    signal: AbortSignal.timeout(15000),
  });
  if (!embedding.ok) throw new Error("Local embedding unavailable");
  const model = await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(15000),
  });
  if (!model.ok) throw new Error("Local model unavailable");
  const tags = z
    .object({
      models: z.array(
        z.object({ name: z.string(), digest: z.string() }).passthrough(),
      ),
    })
    .parse(await model.json());
  if (!tags.models.some((m) => m.name.startsWith(modelId)))
    throw new Error("Evaluation model alias missing: " + modelId);
  const details = await fetch("http://127.0.0.1:11434/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!details.ok) throw new Error("Local model configuration unavailable");
  const modelDetails = z
    .object({ parameters: z.string() })
    .passthrough()
    .parse(await details.json());
  const backendContextWindow = /^num_ctx\s+(\d+)$/m.exec(
    modelDetails.parameters,
  )?.[1];
  return {
    embedding: (await embedding.json()) as unknown,
    models: tags,
    ollamaModelAlias: modelId,
    backendContextWindow: backendContextWindow
      ? Number(backendContextWindow)
      : undefined,
    embeddingProvenance: existsSync(
      path.join(projectRoot, "data", "embedding", "model-manifest.json"),
    )
      ? readJson(
          path.join(projectRoot, "data", "embedding", "model-manifest.json"),
        )
      : { verified: false, reason: "Embedding weight manifest missing" },
  };
}
export async function localEmbeddingHealth() {
  const model = "Qwen/Qwen3-Embedding-0.6B";
  const upstream = await fetch("http://127.0.0.1:18091/health", {
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok)
    throw new Error("Local Qwen embedding model unavailable");
  const upstreamHealth = z
    .object({
      status: z.literal("ok"),
      model: z.literal(model),
      device: z.literal("cpu"),
      dimensions: z.literal(1024),
    })
    .parse(await upstream.json());
  const cache = await fetch("http://127.0.0.1:18092/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: ["Local NewAgent repository embedding preflight"],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!cache.ok)
    throw new Error("Local Qwen embedding cache unavailable");
  const cacheHealth = z
    .object({
      model: z.literal(model),
      data: z
        .array(z.object({ embedding: z.array(z.number().finite()).length(1024) }))
        .length(1),
      cache: z
        .object({ hits: z.number().int().nonnegative(), misses: z.number().int().nonnegative() })
        .optional(),
    })
    .parse(await cache.json());
  return {
    embedding: {
      ...upstreamHealth,
      cache: cacheHealth.cache,
      endpoint: "http://127.0.0.1:18092/v1",
    },
    models: { models: [] as { name: string; digest: string }[] },
    backendContextWindow: undefined,
  };
}
export async function deepseekHealth() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "DeepSeek comparison requires DEEPSEEK_API_KEY in the process environment",
    );
  const response = await fetch("https://api.deepseek.com/models", {
    headers: { Authorization: "Bearer " + apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      "DeepSeek model-list preflight failed with HTTP " + response.status,
    );
  const responseBody = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          context_window: z.number().optional(),
        }),
      ),
    })
    .parse(await response.json());
  const model = responseBody.data.find(
    (candidate) => candidate.id === "deepseek-flash",
  );
  if (!model)
    throw new Error("Configured DeepSeek account does not list deepseek-flash");
  return {
    provider: "deepseek",
    model: model.id,
    name: model.name,
    contextWindow: model.context_window,
  };
}
export async function siliconFlowHealth() {
  const apiKey = process.env.NEWAGENT_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "SiliconFlow comparison requires NEWAGENT_API_KEY in the process environment",
    );
  const response = await fetch("https://api.siliconflow.cn/v1/models", {
    headers: { Authorization: "Bearer " + apiKey },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      "SiliconFlow model-list preflight failed with HTTP " + response.status,
    );
  const responseBody = z
    .object({
      data: z.array(z.object({ id: z.string() }).passthrough()),
    })
    .parse(await response.json());
  const model = responseBody.data.find(
    (candidate) => candidate.id === siliconFlowDeepseekModelId,
  );
  if (!model)
    throw new Error(
      "Configured SiliconFlow account does not list " +
        siliconFlowDeepseekModelId,
    );
  return {
    provider: "siliconflow",
    model: model.id,
    baseUrl: "https://api.siliconflow.cn/v1",
  };
}
