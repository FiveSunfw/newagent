import { createHash } from "node:crypto";
import { revision } from "./execution.js";
import { z } from "zod";
export const environmentSchema = z.object({
  mode: z.enum(["docker", "trusted-host"]),
  image: z.string().min(1),
  boundaryVersion: z.string().min(1),
});
export function verificationFingerprint(
  workspace: string,
  checks: unknown,
  environment: unknown,
) {
  const execution = environmentSchema.parse(environment);
  // Canonical key ordering prevents formatting changes from invalidating identical configuration.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({ source: revision(workspace), checks, execution }),
      ),
    )
    .digest("hex");
}
