import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import type { Task, CheckResult } from "../src/protocol/types";
interface PublicProfile {
  id: string;
  source: string;
}
interface EventRecord {
  seq: number;
  at: string;
  kind: string;
  body: unknown;
}
interface Detail {
  task: Task;
  checks: CheckResult[];
  events: EventRecord[];
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch("/api/" + url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await r.json();
  if (!r.ok)
    throw new Error(
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : "Request failed",
    );
  return data as T;
}
function App() {
  const [profiles, setProfiles] = useState<PublicProfile[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail>(),
    [profile, setProfile] = useState(""),
    [requirement, setRequirement] = useState(""),
    [acceptance, setAcceptance] = useState(""),
    [error, setError] = useState(""),
    [diff, setDiff] = useState(""),
    [log, setLog] = useState(""),
    [feedback, setFeedback] = useState("");
  async function load() {
    setTasks(await api<Task[]>("tasks"));
    if (selected) setDetail(await api<Detail>("tasks/" + selected));
  }
  useEffect(() => {
    api<PublicProfile[]>("profiles")
      .then((p) => {
        setProfiles(p);
        setProfile(p[0]?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(
      () => load().catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [selected]);
  async function action(name: string, body: unknown = {}) {
    try {
      setError("");
      await api(`tasks/${selected}/${name}`, body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main>
      <header>
        <span className="mark">N</span>
        <div>
          <h1>研发交付 Agent</h1>
          <p>需求、开发、审查与验证，形成可追溯的交付记录</p>
        </div>
        <span className="badge">LOCAL · PI</span>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="layout">
        <aside>
          <h2>创建任务</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const t = await api<Task>("tasks", {
                  profileId: profile,
                  requirement,
                  acceptance: acceptance.split("\n").filter(Boolean),
                });
                setSelected(t.id);
                setError("");
                await load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              仓库配置
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.id}>{p.id}</option>
                ))}
              </select>
            </label>
            <label>
              功能需求
              <textarea
                required
                minLength={5}
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                placeholder="给订单查询增加时间范围筛选"
              />
            </label>
            <label>
              验收条件，每行一项
              <textarea
                required
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder="只返回当前用户的订单"
              />
            </label>
            <button>创建任务</button>
          </form>
          <h2>任务记录</h2>
          {tasks.map((t) => (
            <button
              className={"task " + (selected === t.id ? "selected" : "")}
              key={t.id}
              onClick={() => {
                setSelected(t.id);
                setDiff("");
                setLog("");
              }}
            >
              <strong>{t.requirement}</strong>
              <small>
                {t.status} · 返修 {t.round}
              </small>
            </button>
          ))}
        </aside>
        <section>
          {detail ? (
            <>
              <div className="title">
                <h2>{detail.task.requirement}</h2>
                <span className="badge">{detail.task.status}</span>
              </div>
              <p>{detail.task.acceptance.join(" · ")}</p>
              <p className="muted">
                分支 {detail.task.branch} · 代码版本{" "}
                {detail.task.revision.slice(0, 16)}
              </p>
              {detail.task.error && (
                <div className="error">{detail.task.error}</div>
              )}
              <div className="actions">
                <button
                  onClick={() =>
                    action("run", { feedback: feedback || undefined })
                  }
                >
                  开始 / 重新验证
                </button>
                <button onClick={() => action("pause")}>暂停</button>
                <button
                  disabled={detail.task.status !== "ready_for_pr"}
                  onClick={() => {
                    if (
                      confirm("这将提交代码、推送分支并创建草稿 PR，确认执行？")
                    )
                      action("publish", { approve: true });
                  }}
                >
                  提交草稿 PR
                </button>
                <button
                  disabled={!detail.task.pr}
                  onClick={() => action("refresh")}
                >
                  同步 CI / 合并结果
                </button>
                <button
                  onClick={() =>
                    api<{ diff: string }>(`tasks/${selected}/diff`)
                      .then((r) => setDiff(r.diff))
                      .catch((e) => setError(e.message))
                  }
                >
                  查看 diff
                </button>
              </div>
              <label>
                追加意见
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="补充需要开发者处理的问题"
                />
              </label>
              {detail.task.assessment && (
                <article>
                  <h3>发布评估：{detail.task.assessment.verdict}</h3>
                  <p>
                    {detail.task.assessment.reasons.join("；") ||
                      "已配置的验收和集成检查通过，正式发布仍需人工批准。"}
                  </p>
                </article>
              )}
              <h3>实际检查结果</h3>
              <div className="checks">
                {detail.checks.map((c, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      api<{ log: string }>(`tasks/${selected}/log/${i}`).then(
                        (r) => setLog(r.log),
                      )
                    }
                  >
                    <span className={c.passed ? "pass" : "fail"}>
                      {c.passed ? "通过" : "失败"}
                    </span>{" "}
                    {c.name}
                    <small>
                      {c.kind} · {c.durationMs} ms · {c.revision.slice(0, 8)}
                      {c.revision !== detail.task.revision ? " · 旧版本" : ""}
                    </small>
                  </button>
                ))}
              </div>
              {detail.task.review && (
                <>
                  <h3>Review</h3>
                  {detail.task.review.findings.length ? (
                    detail.task.review.findings.map((f) => (
                      <article key={f.id}>
                        <strong>
                          {f.severity} · {f.file}:{f.line}
                        </strong>
                        <p>{f.problem}</p>
                        <p>{f.evidence}</p>
                        <p>{f.recommendation}</p>
                      </article>
                    ))
                  ) : (
                    <p>此次审查未发现阻塞问题。</p>
                  )}
                </>
              )}
              {(diff || log) && <pre>{log || diff}</pre>}
              <h3>执行记录</h3>
              {detail.events
                .slice(-30)
                .reverse()
                .map((e) => (
                  <details key={e.seq}>
                    <summary>
                      {e.at} · {e.kind}
                    </summary>
                    <pre>{JSON.stringify(e.body, null, 2)}</pre>
                  </details>
                ))}
            </>
          ) : (
            <div className="empty">
              <h2>从一个明确的功能需求开始</h2>
              <p>执行器保存检查证据，开发者与审查者在独立会话中工作。</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
