import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
const root = path.resolve("..");
const budgetPath = path.join(root, "data", "eval-budget.json");
const budget = existsSync(budgetPath)
  ? z
      .object({
        currency: z.literal("CNY"),
        maxCost: z.number().nonnegative(),
        paidRunsEnabled: z.boolean(),
      })
      .parse(
        JSON.parse(readFileSync(budgetPath, "utf8").replace(/^\uFEFF/, "")),
      )
  : undefined;
console.log(
  JSON.stringify(
    {
      mode: "plan-only",
      paidModelCalls: 0,
      budget: budget ?? null,
      configuration: ["single-no-rag", "single-rag", "adaptive-rag"],
      calibration: { tasks: 3, configurations: 3, replicates: 1, runs: 9 },
      formal: {
        tasks: 12,
        repositories: 3,
        configurations: 3,
        replicates: 2,
        runs: 72,
      },
      limitsPerRun: { toolCalls: 100, repairs: 3, durationMinutes: 30 },
      blockers: [
        "12-task real-repository evaluation set not yet finalized",
        "30 retrieval questions require human-reviewed labels",
        "Provider pricing and aggregate token/cost guard must be verified before paid execution",
        ...(budget?.paidRunsEnabled
          ? []
          : [
              "Paid runs disabled; no model request will be sent by this command",
            ]),
      ],
    },
    null,
    2,
  ),
);
