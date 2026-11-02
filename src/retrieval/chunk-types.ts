import { createHash } from "node:crypto";

export interface Chunk {
  id: string;
  repository: string;
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  fileHash: string;
  indexVersion: string;
  content: string;
  parentId?: string;
  role?: "parent" | "leaf";
  kind?:
    | "class"
    | "method"
    | "function"
    | "branch"
    | "fragment"
    | "declaration"
    | "module";
}

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
