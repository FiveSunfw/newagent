#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(app);
const args = process.argv.slice(2);
const plainPi = args[0] === '--plain-pi';
if (plainPi) args.shift();
// Windows compile-cache startup stalled in verification; preserve normal stdin handling.
const env = { ...process.env, ...(process.platform === 'win32' ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}), NODE_USE_SYSTEM_CA: '1', NEWAGENT_ROOT: root,
 PI_CODING_AGENT_DIR: path.join(root,'data','pi'), npm_config_cache: path.join(root,'cache','npm'),
 TEMP: path.join(root,'cache','tmp'), TMP: path.join(root,'cache','tmp') };
mkdirSync(env.TEMP,{recursive:true});
const model = JSON.parse(readFileSync(path.join(root,'data','model.json'),'utf8'));
const defaults = ['--offline','--thinking','off','--provider',model.provider,'--model',model.model];
if (!plainPi) defaults.push('--extension',path.join(app,'dist','tui','terminal-extension.js'));
const child = spawn(process.execPath,[path.join(app,'node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js'),...defaults,...args],{env,stdio:'inherit'});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code ?? 1;});
process.on('SIGINT',()=>{});
