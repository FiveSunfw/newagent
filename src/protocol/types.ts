import { z } from "zod";
export const commandSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(600000).default(600000),
});
export const profileSchema = z.object({
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
  assessment?: {
    verdict: "conditions_met" | "blocked" | "insufficient_evidence";
    revision: string;
    reasons: string[];
  };
  createdAt: string;
  updatedAt: string;
}
export interface CheckResult {
  name: string;
  revision: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  log: string;
  durationMs: number;
  kind: "static" | "check" | "acceptance" | "integration";
}
