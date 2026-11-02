import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildSiliconFlowRunConfiguration,
  copyDockerContextMetadata,
  evaluationContextWindow,
  evaluationSampling,
  resolveEvaluationRoot,
} from "../src/eval/local-environment.js";
const tempRoot =
  process.env.NEWAGENT_TEST_ROOT ?? path.resolve("../cache/tests");

test("evaluation dataset versions use separate bounded E-drive roots", () => {
  const root = path.join("E:", "newagent");
  assert.equal(
    resolveEvaluationRoot(root, "v1"),
    path.join(root, "data", "repository-eval"),
  );
  assert.equal(
    resolveEvaluationRoot(root, "v2"),
    path.join(root, "data", "repository-eval-v2"),
  );
  assert.throws(
    () => resolveEvaluationRoot(root, "../../outside"),
    /must look like v2/,
  );
});

test("local model sampling profile validates and records presence penalty", () => {
  assert.deepEqual(evaluationSampling(), {
    temperature: 0.7,
    topP: 0.8,
    presencePenalty: 1.5,
    maxOutputTokens: 2048,
  });
  assert.equal(evaluationSampling(0.3).presencePenalty, 0.3);
  assert.throws(() => evaluationSampling(2.1));
  assert.throws(() => evaluationSampling("invalid"));
});

test("evaluation context accepts 4K, 8K, 32K and 256K profiles", () => {
  assert.equal(evaluationContextWindow(), 32768);
  assert.equal(evaluationContextWindow(4096), 4096);
  assert.equal(evaluationContextWindow(8192), 8192);
  assert.equal(evaluationContextWindow(32768), 32768);
  assert.equal(evaluationContextWindow(262144), 262144);
  assert.throws(() => evaluationContextWindow(16384));
  assert.throws(() => evaluationContextWindow("invalid"));
});

test("SiliconFlow setup uses the exact DeepSeek Flash endpoint and never copies a key", () => {
  const configuration = buildSiliconFlowRunConfiguration(
    {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          apiKey: "must-not-copy",
          models: [
            {
              id: "deepseek-flash",
              name: "DeepSeek Flash",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 8192,
              compat: { thinkingFormat: "deepseek" },
            },
          ],
        },
      },
    },
    evaluationSampling(),
    32768,
  );
  assert.deepEqual(configuration.model, {
    provider: "siliconflow",
    model: "deepseek-ai/DeepSeek-V4-Flash",
  });
  const provider = configuration.providers.siliconflow as {
    baseUrl: string;
    apiKey?: string;
    models: Array<{
      id: string;
      contextWindow: number;
      maxTokens: number;
      samplingParams: Record<string, unknown>;
    }>;
  };
  assert.equal(provider.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.models[0].id, "deepseek-ai/DeepSeek-V4-Flash");
  assert.equal(provider.models[0].contextWindow, 32768);
  assert.equal(provider.models[0].maxTokens, 2048);
  assert.equal(provider.models[0].samplingParams.enable_thinking, false);
  assert.equal(JSON.stringify(configuration).includes("must-not-copy"), false);
  assert.throws(() =>
    buildSiliconFlowRunConfiguration(
      { providers: { deepseek: { baseUrl: "https://attacker.invalid" } } },
      evaluationSampling(),
      32768,
    ),
  );
});

test("isolated Docker config copies context endpoint metadata but no TLS material", () => {
  const root = mkdtempSync(path.join(tempRoot, "docker-context-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const contextId = "a".repeat(64);
  const metadata = path.join(source, "contexts", "meta", contextId);
  const tls = path.join(source, "contexts", "tls", "desktop-linux", "docker");
  mkdirSync(metadata, { recursive: true });
  mkdirSync(tls, { recursive: true });
  writeFileSync(path.join(metadata, "meta.json"), '{"Name":"desktop-linux"}');
  writeFileSync(path.join(tls, "ca.pem"), "fake certificate material");

  assert.equal(copyDockerContextMetadata(source, target), 1);
  assert.equal(
    readFileSync(
      path.join(target, "contexts", "meta", contextId, "meta.json"),
      "utf8",
    ),
    '{"Name":"desktop-linux"}',
  );
  assert.equal(
    existsSync(
      path.join(target, "contexts", "tls", "desktop-linux", "docker", "ca.pem"),
    ),
    false,
  );
});
