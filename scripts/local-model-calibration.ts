import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/state/store.js";
import { PiAgent } from "../src/model-provider/pi.js";
import { Workflow } from "../src/core/workflow.js";
import { git, revision } from "../src/exec/execution.js";
import { TaskExecution } from "../src/exec/task-execution.js";

// Synthetic calibration, deliberately separate from the planned real-repository benchmark.
const cases = [
  {
    id: "owner-access",
    requirement: "Fix queryOrders so only orders belonging to the authenticated owner are returned. Reject an empty owner. Preserve the API and add a regression test.",
    files: { "orders.ts": "export function queryOrders(orders: {id:string;ownerId:string}[], owner:string) { if(!owner)throw new Error('Authentication required'); return orders; }\n" },
    check: "import {queryOrders} from './orders.ts';const rows=[{id:'1',ownerId:'a'},{id:'2',ownerId:'b'}];assert.deepEqual(queryOrders(rows,'a'),[rows[0]]);assert.deepEqual(queryOrders(rows,'c'),[]);assert.throws(()=>queryOrders(rows,''));",
  },
  {
    id: "inclusive-range",
    requirement: "Fix inRange to include both endpoints of a numeric interval. Reject reversed intervals and non-finite inputs. Preserve the API and add a regression test.",
    files: { "range.ts": "export function inRange(value:number,from:number,to:number) { return value>from && value<to; }\n" },
    check: "import {inRange} from './range.ts';assert.equal(inRange(1,1,3),true);assert.equal(inRange(3,1,3),true);assert.equal(inRange(4,1,3),false);assert.equal(inRange(2,2,2),true);assert.throws(()=>inRange(2,3,1));assert.throws(()=>inRange(NaN,1,3));assert.throws(()=>inRange(2,1,Infinity));",
  },
  {
    id: "money-cross-file",
    requirement: "Fix cross-file money units and quantity multiplication: cents(price) converts a decimal price to integer cents by rounding; total(price,quantity) returns cents times quantity. Preserve both APIs and add regression tests.",
    files: {
      "money.ts": "export function cents(price:number) { return Math.round(price); }\n",
      "total.ts": "import {cents} from './money.ts'; export function total(price:number,quantity:number) { return cents(price)+quantity; }\n",
    },
    check: "import {cents} from './money.ts';import {total} from './total.ts';assert.equal(cents(1.25),125);assert.equal(cents(0.015),2);assert.equal(total(1.25,3),375);assert.equal(total(0,3),0);assert.equal(total(2,0),0);",
  },
];
const strategies = ["single-no-rag", "single-rag", "adaptive-rag"] as const;
const base = path.resolve("../data/local-eval");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, "calibration-"));
mkdirSync(path.join(root, "data", "pi"), { recursive: true });
mkdirSync(path.join(root, "cache", "docker"), { recursive: true });
cpSync(path.resolve("../cache/docker/config.json"), path.join(root, "cache", "docker", "config.json"));
cpSync(path.resolve("../data/sandbox.json"), path.join(root, "data", "sandbox.json"));
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2));
save(path.join(root, "data", "model.json"), { provider: "local-ollama", model: "qwen3:1.7b" });
save(path.join(root, "data", "pi", "models.json"), { providers: { "local-ollama": {
  baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "local-only",
  models: [{id:"qwen3:1.7b",name:"Local Qwen3 1.7B",reasoning:false,input:["text"],contextWindow:4096,maxTokens:768,
    samplingParams:{temperature:0,reasoning_effort:"none",max_tokens:768},compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:"max_tokens"},
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
} } });
const modelResponse = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(10000) });
if (!modelResponse.ok) throw new Error("Local Ollama unavailable");
const modelMetadata: unknown = await modelResponse.json();
const profiles = [];
const revisions: Record<string,string> = {};
for (const c of cases) {
  const source = path.join(root, "sources", c.id);
  mkdirSync(source, { recursive:true });
  save(path.join(source,"package.json"),{name:c.id,type:"module",private:true});
  writeFileSync(path.join(source,"README.md"),"Small synthetic TypeScript calibration repository. Tests use node:test and --experimental-strip-types.\n");
  for (const [file,content] of Object.entries(c.files)) writeFileSync(path.join(source,file),content);
  await git(source,["init"]); await git(source,["config","user.name","Calibration"]); await git(source,["config","user.email","calibration@localhost"]);
  await git(source,["add","."]); await git(source,["commit","-m","Fixed seeded calibration defect"]);
  revisions[c.id] = await git(source,["rev-parse","HEAD"]);
  for (const strategy of strategies) profiles.push({id:`${c.id}-${strategy}`,source,base:revisions[c.id],strategy,
    checks:[{name:"independent-acceptance",file:"node",args:["--experimental-strip-types","--input-type=module","-e","import assert from 'node:assert/strict';"+c.check],timeoutMs:120000}],
    protectedPaths:["package.json","README.md","AGENTS.md"],execution:{mode:"docker"}});
}
save(path.join(root,"data","profiles.json"),profiles);
const store = new Store(path.join(root,"data"));
const flow = new Workflow(root,store,new PiAgent(root));
const output: unknown[] = [];
const manifest = {root,model:"qwen3:1.7b",modelMetadata,revisions,strategies,realModel:true,paidApiCalls:0,
  limits:{tools:100,repairs:3,durationMinutes:30,maxOutputTokensPerMessage:768,contextWindow:4096},
  limitations:["Synthetic calibration only; not 12-task real-repository benchmark","RAG arms use explicit keyword fallback unless configured","No human-labeled retrieval or Review quality metrics"],
};
save(path.join(root,"manifest.json"),manifest);
console.log(JSON.stringify({root,runs:9,limits:manifest.limits,limitations:manifest.limitations}));
try {
  // Prove the fixed independent check detects each original defect before model work.
  for (const c of cases) {
    const task=flow.create({profileId:`${c.id}-single-no-rag`,requirement:c.requirement,acceptance:["Independent acceptance must pass"]});
    task.workspace=path.join(root,"sources",c.id);
    const boundary=new TaskExecution(root,task,flow.profile(task));
    await boundary.preflight();
    const command=flow.profile(task).checks[0];
    const result=await boundary.command(command.file,command.args,new AbortController().signal,120000);
    if(result.exitCode===0||result.timedOut) throw new Error(`Invalid seeded baseline: ${c.id}`);
    store.event(task.id,"baseline_defect_detected",result);
  }
  for (const c of cases) for (const strategy of strategies) {
    const task=flow.create({profileId:`${c.id}-${strategy}`,requirement:c.requirement,acceptance:["Preserve API and independent acceptance","Add meaningful regression tests"]});
    const started=Date.now();
    console.log(JSON.stringify({event:"start",case:c.id,strategy,taskId:task.id}));
    flow.run(task.id); await flow.waitForRun();
    const result=store.get(task.id);
    const currentRevision=revision(task.workspace);
    const check=flow.profile(result).checks[0];
    const acceptance=await new TaskExecution(root,result,flow.profile(result)).command(check.file,check.args,new AbortController().signal,120000);
    const events=store.events(task.id);
    const record={caseId:c.id,strategy,taskId:task.id,task:result,durationMs:Date.now()-started,sourceRevision:currentRevision,
      functionalAcceptance:acceptance.exitCode===0&&!acceptance.timedOut,deliveryGate:result.status==="ready_for_pr",
      outcome:result.errorType==="timeout"?"incomplete_timeout":result.status,acceptance,checks:store.checks(task.id),events,
      usage:events.filter(e=>e.kind==="agent_usage").map(e=>e.body),humanCodeInterventions:0};
    output.push(record);save(path.join(root,"results.json"),{...manifest,results:output});
    console.log(JSON.stringify({event:"completed",case:c.id,strategy,status:result.status,functionalAcceptance:record.functionalAcceptance,durationMs:record.durationMs,error:result.error}));
  }
} finally { await flow.shutdown();store.close(); }
