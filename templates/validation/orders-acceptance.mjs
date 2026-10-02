import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {queryOrders}=await import(pathToFileURL(path.join(process.cwd(),'src/orders.ts')));
const orders=[{id:'one',ownerId:'alice',createdAt:'2026-01-01T00:00:00Z',amount:10},{id:'two',ownerId:'alice',createdAt:'2026-02-01T00:00:00Z',amount:20},{id:'other',ownerId:'bob',createdAt:'2026-02-01T00:00:00Z',amount:30}];
assert.deepEqual(queryOrders(orders,'alice',{from:'2026-01-15T00:00:00Z'}).map(o=>o.id),['two']);
assert.deepEqual(queryOrders(orders,'alice',{to:'2026-01-15T00:00:00Z'}).map(o=>o.id),['one']);
assert.deepEqual(queryOrders(orders,'alice',{from:'2026-02-01T00:00:00Z',to:'2026-02-01T00:00:00Z'}).map(o=>o.id),['two']);
assert.throws(()=>queryOrders(orders,'alice',{from:'invalid'}));
assert.throws(()=>queryOrders(orders,'alice',{from:'2026-03-01T00:00:00Z',to:'2026-01-01T00:00:00Z'}));
assert.throws(()=>queryOrders(orders,''));assert.equal(queryOrders(orders,'bob').length,1);console.log('Independent acceptance passed');

assert.equal(queryOrders(orders,'alice').length,2);
assert.deepEqual(queryOrders(orders,'alice',{from:'2026-02-01T08:00:00+08:00',to:'2026-02-01T08:00:00+08:00'}).map(o=>o.id),['two']);
assert.throws(()=>queryOrders(orders,'alice',{to:'invalid'}));
assert.deepEqual(queryOrders([],'alice'),[]);
const before=JSON.stringify(orders);queryOrders(orders,'alice',{from:'2026-01-01T00:00:00Z'});assert.equal(JSON.stringify(orders),before);
