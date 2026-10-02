import { z } from "zod";
import type { Profile, Task } from "../protocol/types.js";
const pullSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
  state: z.string(),
  merged: z.boolean().default(false),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ sha: z.string() }),
});
export type Pull = z.infer<typeof pullSchema>;
const checksSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
      output: z
        .object({
          title: z.string().nullable(),
          summary: z.string().nullable(),
          text: z.string().nullable().optional(),
        })
        .optional(),
    }),
  ),
});
const statusSchema = z.object({
  state: z.string(),
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullable(),
    }),
  ),
});
const commentSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    path: z.string(),
    line: z.number().nullable().optional(),
    html_url: z.string(),
  }),
);
export class GitHub {
  constructor(
    private token = process.env.GITHUB_TOKEN,
    private baseUrl = "https://api.github.com",
  ) {}
  gitAuthEnvironment() {
    if (!this.token)
      throw new Error(
        "GITHUB_TOKEN is not configured; publish has not started",
      );
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0:
        "Authorization: Basic " +
        Buffer.from("x-access-token:" + this.token).toString("base64"),
    };
  }
  private async request(
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    if (method !== "GET" && !this.token)
      throw new Error("GITHUB_TOKEN is not configured");
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(`GitHub ${method} ${route}: HTTP ${response.status}`);
    return await response.json();
  }
  private repo(p: Profile) {
    if (!p.github) throw new Error("Profile has no GitHub repository");
    return `/repos/${encodeURIComponent(p.github.owner)}/${encodeURIComponent(p.github.repo)}`;
  }
  async create(p: Profile, t: Task) {
    const route = this.repo(p);
    const existing = z
      .array(pullSchema)
      .parse(
        await this.request(
          `${route}/pulls?state=open&head=${encodeURIComponent(p.github!.owner + ":" + t.branch)}`,
        ),
      );
    if (existing.length) return existing[0];
    return pullSchema.parse(
      await this.request(`${route}/pulls`, "POST", {
        title: t.requirement.slice(0, 100),
        head: t.branch,
        base: p.github!.base,
        draft: true,
        body: `## Requirement\n${t.requirement}\n\n## Acceptance\n${t.acceptance.map((a) => "- " + a).join("\n")}\n\n## Validation\nLocal configured checks and independent review passed for fingerprint ${t.revision}.\nTask: ${t.id}\nHuman review and merge required.`,
      }),
    );
  }
  async get(p: Profile, number: number) {
    return pullSchema.parse(
      await this.request(`${this.repo(p)}/pulls/${number}`),
    );
  }
  async ci(p: Profile, sha: string) {
    const route = this.repo(p);
    const [checks, status] = await Promise.all([
      this.request(`${route}/commits/${sha}/check-runs?per_page=100`).then(
        (v) => checksSchema.parse(v),
      ),
      this.request(`${route}/commits/${sha}/status?per_page=100`).then((v) =>
        statusSchema.parse(v),
      ),
    ]);
    return { sha, checks: checks.check_runs, status };
  }
  async comments(p: Profile, n: number) {
    return commentSchema.parse(
      await this.request(`${this.repo(p)}/pulls/${n}/comments?per_page=100`),
    );
  }
}
