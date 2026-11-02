import { z } from "zod";
export const commandSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(600000).default(600000),
});
export const profileSchema = z.object({
  strategy: z
    .enum(["single-no-rag", "single-rag", "adaptive-rag"])
    .default("adaptive-rag"),
  reflexion: z.boolean().default(false),
  runLimits: z
    .object({
      tools: z.number().int().positive().max(100).optional(),
      repairs: z.number().int().nonnegative().max(3).optional(),
      durationMs: z.number().int().positive().max(1800000).optional(),
    })
    .optional(),
  execution: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("docker"),
        dependencies: z
          .object({
            volume: z.string().regex(/^newagent-deps-[a-f0-9]{32}$/),
            lockHash: z.string().regex(/^[a-f0-9]{64}$/),
            image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .optional(),
      }),
      z.object({
        mode: z.literal("trusted-host"),
        acknowledged: z.literal(true),
      }),
    ])
    .default({ mode: "docker" }),
  id: z.string(),
  source: z.string(),
  base: z.string().default("HEAD"),
  checks: z.array(commandSchema).min(1),
  staticChecks: z.array(commandSchema).default([]),
  integration: z.array(commandSchema).default([]),
  acceptance: z.array(commandSchema).default([]),
  protectedPaths: z
    .array(z.string())
    .default([
      "package.json",
      "package-lock.json",
      ".github",
      "AGENTS.md",
      "REVIEW_GUIDELINES.md",
    ]),
  github: z
    .object({
      owner: z.string(),
      repo: z.string(),
      base: z.string().default("main"),
    })
    .optional(),
});
export type Profile = z.infer<typeof profileSchema>;
export const taskInput = z.object({
  profileId: z.string(),
  requirement: z.string().min(5).max(20000),
  acceptance: z.array(z.string().min(1)).min(1).max(30),
});
export const reviewSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["blocking", "suggestion"]),
      file: z.string(),
      line: z.number().int().positive(),
      problem: z.string(),
      evidence: z.string(),
      recommendation: z.string(),
    }),
  ),
  verdict: z.enum(["pass", "changes_requested"]),
});
export type Review = z.infer<typeof reviewSchema>;
export const retrievalExpertSchema = z.object({
  summary: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        symbol: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        reason: z.string(),
      }),
    )
    .max(20),
  gaps: z.array(z.string()).max(20),
});
export const reflexionMemorySchema = z.object({
  diagnosis: z.string().min(1).max(320),
  evidenceIds: z
    .array(z.string().regex(/^O[1-4]$/))
    .min(1)
    .max(4),
  lessons: z.array(z.string().min(1).max(180)).min(1).max(2),
  doNotRepeat: z.array(z.string().min(1).max(180)).max(2),
  nextSteps: z.array(z.string().min(1).max(180)).max(2),
  uncertainty: z.string().max(160),
});
export const reflexionObservationSchema = z.object({
  id: z.string().regex(/^O[1-4]$/),
  source: z.enum([
    "evaluator",
    "workspace",
    "tool_failure",
    "review",
    "assistant_summary",
  ]),
  fact: z.string().min(1).max(400),
});
export const reflexionExperienceSchema = z.object({
  trial: z.number().int().positive(),
  sourceRevision: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  observations: z.array(reflexionObservationSchema).min(1).max(4),
  reflection: reflexionMemorySchema,
});
export type ReflexionMemory = z.infer<typeof reflexionMemorySchema>;
export type ReflexionObservation = z.infer<typeof reflexionObservationSchema>;
export type ReflexionExperience = z.infer<typeof reflexionExperienceSchema>;
export type Status =
  | "queued"
  | "preparing"
  | "developing"
  | "checking"
  | "reviewing"
  | "repairing"
  | "ready_for_pr"
  | "awaiting_merge"
  | "integrating"
  | "complete"
  | "blocked"
  | "paused";
export interface Task {
  verificationFingerprint?: string;
  budget?: { startedAt: number; tools: number; repairs: number };
  reflections?: ReflexionExperience[];
  id: string;
  profileId: string;
  requirement: string;
  acceptance: string[];
  status: Status;
  round: number;
  workspace: string;
  branch: string;
  baseRevision: string;
  revision: string;
  review?: Review;
  pr?: number;
  error?: string;
  errorType?: "cancelled" | "timeout" | "budget" | "validation" | "execution";
  assessment?: {
    verdict: "conditions_met" | "blocked" | "insufficient_evidence";
    revision: string;
    reasons: string[];
  };
  createdAt: string;
  updatedAt: string;
}
export interface CheckResult {
  verificationFingerprint?: string;
  name: string;
  revision: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  log: string;
  durationMs: number;
  kind: "static" | "check" | "acceptance" | "integration";
}
