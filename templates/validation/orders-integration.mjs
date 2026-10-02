import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {createOrderServer}=await import(pathToFileURL(path.join(process.cwd(),'src/server.ts')));
const server=createOrderServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{const origin='http://127.0.0.1:'+server.address().port;const denied=await fetch(origin+'/orders');assert.equal(denied.status,401);const filtered=await fetch(origin+'/orders?from=2026-01-15T00%3A00%3A00Z',{headers:{'x-user-id':'alice'}});assert.equal(filtered.status,200);assert.deepEqual((await filtered.json()).map(o=>o.id),['two']);const invalid=await fetch(origin+'/orders?from=invalid',{headers:{'x-user-id':'alice'}});assert.equal(invalid.status,400);const bob=await fetch(origin+'/orders',{headers:{'x-user-id':'bob'}});assert.deepEqual((await bob.json()).map(o=>o.id),['other']);console.log('HTTP + SQLite integration passed');}finally{await new Promise((r,j)=>server.close(e=>e?j(e):r()));}
