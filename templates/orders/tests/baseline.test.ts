import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryOrders} from '../src/orders.ts';
test('owner access and auth boundary',()=>{const orders=[{id:'1',ownerId:'a',createdAt:'2026-01-01T00:00:00Z',amount:1},{id:'2',ownerId:'b',createdAt:'2026-01-02T00:00:00Z',amount:2}];assert.equal(queryOrders(orders,'a').length,1);assert.throws(()=>queryOrders(orders,''));});
