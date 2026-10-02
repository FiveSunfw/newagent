import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import deliveryExtension from '../src/tui/terminal-extension.js';
test('natural language tool creates tasks and publication requires human UI confirmation', async () => {
  const base = path.resolve('../cache/tests');
  mkdirSync(base, {recursive:true});
  const root = mkdtempSync(path.join(base,'conversation-'));
  mkdirSync(path.join(root,'data'));
  writeFileSync(path.join(root,'data','profiles.json'),JSON.stringify([{id:'fixture',source:'synthetic-local-repo',checks:[{name:'check',file:process.execPath}]}]));
  type Handler = (event: {systemPrompt:string}, ctx: ExtensionContext) => Promise<unknown>;
  type Tool = { name: string; execute: (id:string, params: {action:string;taskId?:string;profileId?:string;requirement?:string;acceptance?:string[]}, signal:AbortSignal, update:undefined, ctx:ExtensionContext)=>Promise<{content:{type:string;text?:string}[]}> };
  const handlers = new Map<string,Handler>();
  let tool: Tool | undefined;
  const api = {on: (name:string, fn:Handler)=>handlers.set(name,fn),registerTool:(definition:Tool)=>{tool=definition;},registerCommand:()=>{},sendMessage:()=>{}} as unknown as ExtensionAPI;
  const ctx = {hasUI:false,ui:{setStatus:()=>{},notify:()=>{},setWidget:()=>{}}} as unknown as ExtensionContext;
  const previous = process.env.NEWAGENT_ROOT;
  process.env.NEWAGENT_ROOT=root;
  try {
    deliveryExtension(api);
    await handlers.get('session_start')?.({systemPrompt:''},ctx);
    assert.equal(tool?.name,'delivery_agent');
    if (!tool) throw new Error('Tool was not registered');
    const invoke = (params: Parameters<Tool['execute']>[1])=>tool!.execute('call',params,new AbortController().signal,undefined,ctx);
    const inspected = JSON.parse((await invoke({action:'inspect'})).content[0].text!);
    assert.equal(inspected.profiles[0].id,'fixture');
    const created = JSON.parse((await invoke({action:'create',profileId:'fixture',requirement:'Add feature with tests',acceptance:['test passes']})).content[0].text!);
    assert.equal(created.status,'queued');
    const status = JSON.parse((await invoke({action:'status',taskId:created.id})).content[0].text!);
    assert.equal(status.task.requirement,'Add feature with tests');
    await assert.rejects(invoke({action:'publish',taskId:created.id}),/explicit user confirmation/);
    await assert.rejects(invoke({action:'create',profileId:'missing',requirement:'Add feature with tests',acceptance:['test passes']}),/Unknown profile/);
    const prompt = await handlers.get('before_agent_start')?.({systemPrompt:'base'},ctx) as {systemPrompt:string};
    assert.match(prompt.systemPrompt,/无需用户输入 \/delivery/);
  } finally {
    await handlers.get('session_shutdown')?.({systemPrompt:''},ctx);
    if (previous === undefined) delete process.env.NEWAGENT_ROOT; else process.env.NEWAGENT_ROOT=previous;
  }
});
