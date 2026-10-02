import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, CheckResult } from "../protocol/types.js";
export class Store {
  readonly db: Database.Database;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(root, "tasks.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,body TEXT NOT NULL);",
    );
  }
  save(t: Task) {
    t.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(t.id, JSON.stringify(t));
  }
  get(id: string): Task {
    const r = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id) as
      { body: string } | undefined;
    if (!r) throw new Error("Task not found");
    return JSON.parse(r.body) as Task;
  }
  list(): Task[] {
    return (
      this.db.prepare("SELECT body FROM tasks ORDER BY rowid DESC").all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as Task);
  }
  event(id: string, kind: string, body: unknown) {
    this.db
      .prepare("INSERT INTO events(task_id,at,kind,body) VALUES(?,?,?,?)")
      .run(id, new Date().toISOString(), kind, JSON.stringify(body));
  }
  events(id: string) {
    return (
      this.db
        .prepare(
          "SELECT seq,at,kind,body FROM events WHERE task_id=? ORDER BY seq",
        )
        .all(id) as { seq: number; at: string; kind: string; body: string }[]
    ).map((r) => ({ ...r, body: JSON.parse(r.body) as unknown }));
  }
  check(id: string, c: CheckResult) {
    this.db
      .prepare("INSERT INTO checks VALUES(?,?,?)")
      .run(randomUUID(), id, JSON.stringify(c));
  }
  checks(id: string): CheckResult[] {
    return (
      this.db
        .prepare("SELECT body FROM checks WHERE task_id=? ORDER BY rowid")
        .all(id) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as CheckResult);
  }
  close() {
    this.db.close();
  }
}
