import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  reflexionMemorySchema,
  reflexionObservationSchema,
} from "../protocol/types.js";
import { redact } from "../state/redaction.js";
import { evaluationRoot, saveJson } from "./local-environment.js";

const model =
  process.env.NEWAGENT_REFLEXION_MODEL ?? "newagent-qwen3-1.7b:latest";
const observations = reflexionObservationSchema
  .array()
  .max(4)
  .parse([
    {
      id: "O1",
      source: "evaluator",
      fact: "Independent acceptance failed: actual value was fallback; expected 0.",
    },
    {
      id: "O2",
      source: "workspace",
      fact: "The development attempt changed source, but the independent acceptance still failed.",
    },
  ]);
const started = Date.now();
const response = await fetch("http://127.0.0.1:11434/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  signal: AbortSignal.timeout(180000),
  body: JSON.stringify({
    model,
    stream: false,
    format: "json",
    think: false,
    messages: [
      {
        role: "system",
        content:
          "You are a self-reflection model after a failed coding attempt. Return one JSON object only. Cite only supplied evidence IDs. Do not invent source facts or claim success.",
      },
      {
        role: "user",
        content: [
          "Task: deep lookup must preserve an existing zero instead of returning a default.",
          `Verified observations: ${JSON.stringify(observations)}`,
          'Return exactly these fields: {"diagnosis":"...","evidenceIds":["O1"],"lessons":["..."],"doNotRepeat":[],"nextSteps":["..."],"uncertainty":"..."}. Keep each item concise.',
        ].join("\n"),
      },
    ],
    options: { temperature: 0.1, num_predict: 220 },
  }),
});
if (!response.ok)
  throw new Error(
    `Local Reflexion smoke failed: Ollama returned ${response.status}`,
  );
const envelope = z
  .object({
    message: z.object({ content: z.string() }),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .passthrough()
  .parse(await response.json());
const reflection = reflexionMemorySchema.parse(
  JSON.parse(envelope.message.content),
);
const availableIds = new Set(observations.map((observation) => observation.id));
if (reflection.evidenceIds.some((id) => !availableIds.has(id)))
  throw new Error("Local Reflexion smoke cited evidence outside its input");
mkdirSync(evaluationRoot, { recursive: true });
const artifact = path.join(evaluationRoot, "reflexion-smoke.json");
saveJson(artifact, {
  kind: "prompt-contract-only",
  model,
  durationMs: Date.now() - started,
  usage: {
    promptTokens: envelope.prompt_eval_count,
    outputTokens: envelope.eval_count,
  },
  observations,
  reflection: redact(reflection),
  limitation:
    "One synthetic local prompt; this does not measure task acceptance or Reflexion effectiveness.",
});
console.log(
  JSON.stringify({
    kind: "prompt-contract-only",
    model,
    durationMs: Date.now() - started,
    validSchema: true,
    citedSuppliedEvidence: true,
    artifact,
  }),
);
