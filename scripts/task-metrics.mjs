import {Store} from '../dist/state/store.js';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const id=process.argv[2];if(!id)throw new Error('Usage: node scripts/task-metrics.mjs TASK_ID');
const store=new Store(path.join(root,'data'));
try {
 const task=store.get(id),events=store.events(id),checks=store.checks(id);
 const stages=events.filter(e=>e.kind==='stage'||e.kind==='failure');
 const active=new Set(['preparing','developing','checking','reviewing','repairing','integrating']);
 const stageMs={};
 for(let i=0;i<stages.length-1;i++){const e=stages[i];if(e.kind==='stage'&&active.has(e.body.status)){stageMs[e.body.status]=(stageMs[e.body.status]??0)+(new Date(stages[i+1].at).getTime()-new Date(e.at).getTime());}}
 const usage=events.filter(e=>e.kind==='agent_usage');
 const sumUsage=list=>list.reduce((a,e)=>{const u=e.usage??{};a.calls++;for(const k of ['input','output','cacheRead','cacheWrite','reasoning','totalTokens'])a[k]+=(u[k]??0);return a;},{calls:0,input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:0});
 const roles={};for(const role of ['developer','reviewer'])roles[role]=sumUsage(usage.filter(e=>e.body.role===role).map(e=>e.body));
 const orchestration=[];
 for(const name of readdirSync(path.join(root,'data')).filter(n=>/^valorant-natural.*\.jsonl$/.test(n))){for(const line of readFileSync(path.join(root,'data',name),'utf8').split(String.fromCharCode(10))){try{const e=JSON.parse(line);if(e.type==='message_end'&&e.message?.role==='assistant'&&e.message.usage)orchestration.push({usage:e.message.usage});}catch{}}}
 const firstReady=events.find(e=>e.kind==='stage'&&e.body.status==='ready_for_pr');
 const failures=events.filter(e=>e.kind==='failure').map(e=>({at:e.at,message:e.body.message}));
 const result={taskId:id,status:task.status,sampleCount:1,firstReadyElapsedSeconds:firstReady?(new Date(firstReady.at)-new Date(task.createdAt))/1000:null,runStarts:events.filter(e=>e.kind==='stage'&&e.body.status==='preparing').length,automaticRepairStages:events.filter(e=>e.kind==='stage'&&e.body.status==='repairing').length,recordedFailures:failures,stageSeconds:Object.fromEntries(Object.entries(stageMs).map(([k,v])=>[k,v/1000])),modelUsage:{...roles,orchestrator:sumUsage(orchestration)},modelToolCalls:events.filter(e=>e.kind==='agent_tool').length,checks:{executions:checks.length,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,totalSeconds:checks.reduce((a,c)=>a+c.durationMs,0)/1000,latestRevision:checks.filter(c=>c.revision===task.revision).map(c=>({name:c.name,kind:c.kind,passed:c.passed,seconds:c.durationMs/1000}))},review:task.review?{verdict:task.review.verdict,blocking:task.review.findings.filter(f=>f.severity==='blocking').length,suggestions:task.review.findings.filter(f=>f.severity==='suggestion').length}:null,cost:{actualBilledUsd:null,reason:'Rates not configured; zero SDK cost is not a real bill'},limitations:['Single task; no aggregate success rate or efficiency improvement claim','Human framework fixes and interrupted runs included; not fully autonomous','Usage includes completed responses only; interrupted or in-flight requests may be missing','Stage timings include local execution; durations are not pure model latency','Integration tests with real external database are skipped; HTTP acceptance uses injected dependencies']};
 writeFileSync(path.join(root,'data',id+'-metrics.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {store.close();}
