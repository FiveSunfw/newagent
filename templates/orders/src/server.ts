import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {queryOrders} from './orders.ts';
export function createOrderServer(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE orders(id TEXT, ownerId TEXT, createdAt TEXT, amount REAL)');
 const insert=db.prepare('INSERT INTO orders VALUES(?,?,?,?)');insert.run('one','alice','2026-01-01T00:00:00Z',10);insert.run('two','alice','2026-02-01T00:00:00Z',20);insert.run('other','bob','2026-02-01T00:00:00Z',30);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.method!=='GET'||!req.url?.startsWith('/orders')){res.writeHead(404).end(JSON.stringify({error:'Not found'}));return;}const owner=req.headers['x-user-id'];if(typeof owner!=='string'||!owner){res.writeHead(401).end(JSON.stringify({error:'Authentication required'}));return;}const url=new URL(req.url,'http://localhost');try{const rows=db.prepare('SELECT * FROM orders').all() as unknown as import('./orders.ts').Order[];const options={from:url.searchParams.get('from')??undefined,to:url.searchParams.get('to')??undefined};const query=queryOrders as (rows:import('./orders.ts').Order[],owner:string,options?:{from?:string;to?:string})=>import('./orders.ts').Order[];res.end(JSON.stringify(query(rows,owner,options)));}catch(error){res.writeHead(400).end(JSON.stringify({error:error instanceof Error?error.message:'Invalid query'}));}});
 server.on('close',()=>db.close());return server;
}
