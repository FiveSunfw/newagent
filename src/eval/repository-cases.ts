export interface RepositoryCase {
  id: string;
  repository: "mitt" | "fast-json-stable-stringify" | "dlv";
  split: "development" | "holdout";
  category: "defect" | "cross-file" | "constraint" | "recovery";
  requirement: string;
  setup?: Record<string, string>;
  publicExport?: { file: string; line: string };
  mutation: { file: string; before: string; after: string }[];
  acceptance: string;
}
export const repositorySmoke = {
  mitt: "const {default:mitt}=await import('./src/index.ts');const e=mitt();let out=[];const h=v=>out.push(v);e.on('x',h);e.emit('x',1);e.off('x',h);e.emit('x',2);assert.deepEqual(out,[1]);assert.equal(e.all instanceof Map,true);",
  "fast-json-stable-stringify":
    "const {default:stringify}=await import('./index.js');assert.equal(stringify({b:2,a:1}),'{\"a\":1,\"b\":2}');assert.equal(stringify([1,2]),'[1,2]');assert.equal(stringify(null),'null');",
  dlv: "const {default:dlv}=await import('./index.js');assert.equal(dlv({a:{b:2}},'a.b'),2);assert.equal(dlv({},'a.b','missing'),'missing');",
};
const mittImport = "const {default:mitt}=await import('./src/index.ts');";
const stringifyImport = "const {default:stringify}=await import('./index.js');";
const dlvImport = "const {default:dlv}=await import('./index.js');";
export const repositoryCases: RepositoryCase[] = [
  {
    id: "mitt-wildcard",
    repository: "mitt",
    split: "development",
    category: "defect",
    requirement:
      "Wildcard subscribers receive payload and event type in the wrong order. Restore the documented emit contract and keep type-specific subscriptions unchanged. Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration.",
    mutation: [
      {
        file: "src/index.ts",
        before: "handler(type, evt!);",
        after: "handler(evt! as keyof Events, type as Events[keyof Events]);",
      },
    ],
    acceptance:
      mittImport +
      "const e=mitt();const got=[];e.on('*',(type,event)=>got.push([type,event]));e.emit('message',{id:7});e.emit('ready',null);assert.deepEqual(got,[['message',{id:7}],['ready',null]]);",
  },
  {
    id: "mitt-unknown-handler",
    repository: "mitt",
    split: "development",
    category: "defect",
    requirement:
      "Removing a handler that was never registered must preserve every registered handler. Fix off while preserving removal of a known handler and clearing a type when no handler is supplied.",
    mutation: [
      {
        file: "src/index.ts",
        before: "handlers.indexOf(handler) >>> 0",
        after: "handlers.indexOf(handler)",
      },
    ],
    acceptance:
      mittImport +
      "const e=mitt();let a=0,b=0;const h=()=>a++;const g=()=>b++;e.on('x',h);e.on('x',g);e.off('x',()=>{});e.emit('x',null);assert.deepEqual([a,b],[1,1]);e.off('x',h);e.emit('x',null);assert.deepEqual([a,b],[1,2]);e.off('x');e.emit('x',null);assert.equal(b,2);",
  },
  {
    id: "mitt-dispatch-snapshot",
    repository: "mitt",
    split: "holdout",
    category: "constraint",
    requirement:
      "Subscription changes during emit must not skip callbacks already scheduled for that dispatch. Preserve dispatch order and the documented wildcard behavior. Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration.",
    mutation: [{ file: "src/index.ts", before: ".slice()", after: "" }],
    acceptance:
      mittImport +
      "const e=mitt();const got=[];const first=()=>{got.push('first');e.off('x',first)};e.on('x',first);e.on('x',()=>got.push('second'));e.emit('x',null);e.emit('x',null);assert.deepEqual(got,['first','second','second']);",
  },
  {
    id: "mitt-once-integration",
    repository: "mitt",
    split: "holdout",
    category: "cross-file",
    requirement:
      "The new once helper must be exported from the public index and unsubscribe its wrapper from the correct event type before calling the user handler. Fix the cross-file integration and test re-entrant emission.",
    setup: {
      "src/once.ts":
        "type Handler = (event:unknown)=>void;\ntype Emitter = {on(type:string,handler:Handler):void;off(type:string,handler:Handler):void};\nexport function once(emitter:Emitter,type:string,handler:Handler) { const wrapped:Handler=(event)=>{emitter.off(type,wrapped);handler(event);}; emitter.on(type,wrapped); }\n",
    },
    publicExport: {
      file: "src/index.ts",
      line: "export {once} from './once.ts';\n",
    },
    mutation: [
      {
        file: "src/index.ts",
        before: "export {once} from './once.ts';\n",
        after: "",
      },
      {
        file: "src/once.ts",
        before: "emitter.off(type,wrapped)",
        after: "emitter.off('*',wrapped)",
      },
    ],
    acceptance:
      "const {default:mitt,once}=await import('./src/index.ts');assert.equal(typeof once,'function');const e=mitt();let n=0;once(e,'x',()=>{n++;if(n<3)e.emit('x',null)});e.emit('x',null);e.emit('x',null);assert.equal(n,1);",
  },
  {
    id: "stringify-nonfinite",
    repository: "fast-json-stable-stringify",
    split: "development",
    category: "defect",
    requirement:
      "Non-finite numeric values must serialize as JSON null at the root and inside objects or arrays. Fix this regression without changing finite numbers or canonical key order.",
    mutation: [
      {
        file: "index.js",
        before: "isFinite(node) ? '' + node : 'null'",
        after: "isFinite(node) ? '' + node : '' + node",
      },
    ],
    acceptance:
      stringifyImport +
      "assert.equal(stringify(NaN),'null');assert.equal(stringify(Infinity),'null');assert.equal(stringify({b:Infinity,a:3}),'{'+'\"a\":3,\"b\":null}');assert.equal(stringify([-Infinity,2]),'[null,2]');",
  },
  {
    id: "stringify-array-holes",
    repository: "fast-json-stable-stringify",
    split: "development",
    category: "defect",
    requirement:
      "Undefined and missing array elements must serialize as null while undefined object properties remain omitted. Fix the array regression and preserve array order.",
    mutation: [
      {
        file: "index.js",
        before: "stringify(node[i]) || 'null'",
        after: "stringify(node[i]) || ''",
      },
    ],
    acceptance:
      stringifyImport +
      "assert.equal(stringify([undefined,1,undefined]),'[null,1,null]');assert.equal(stringify(Array(2)),'[null,null]');assert.equal(stringify({a:undefined,b:1}),'{\"b\":1}');",
  },
  {
    id: "stringify-key-comparator",
    repository: "fast-json-stable-stringify",
    split: "holdout",
    category: "constraint",
    requirement:
      "Restore deterministic key ordering regardless of insertion order, and honor the optional comparator using key/value records. Preserve nested objects and function-form options.",
    mutation: [
      {
        file: "index.js",
        before: "Object.keys(node).sort(cmp && cmp(node))",
        after: "Object.keys(node)",
      },
    ],
    acceptance:
      stringifyImport +
      'assert.equal(stringify({z:0,a:1}),\'{"a":1,"z":0}\');assert.equal(stringify({a:1,z:0},{cmp:(a,b)=>b.key.localeCompare(a.key)}),\'{"z":0,"a":1}\');assert.equal(stringify({a:1,b:2},(a,b)=>b.value-a.value),\'{"b":2,"a":1}\');',
  },
  {
    id: "stringify-cycle-recovery",
    repository: "fast-json-stable-stringify",
    split: "holdout",
    category: "recovery",
    requirement:
      "Default circular serialization must throw TypeError, while cycles:true emits the documented cycle marker. Repair this regression. This run also exercises orchestration restart at a completed file-write checkpoint.",
    mutation: [
      {
        file: "index.js",
        before: "throw new TypeError('Converting circular structure to JSON');",
        after: "return JSON.stringify('__cycle__');",
      },
    ],
    acceptance:
      stringifyImport +
      'const circular={};circular.self=circular;assert.throws(()=>stringify(circular),TypeError);assert.equal(stringify(circular,{cycles:true}),\'{"self":"__cycle__"}\');const shared={a:1};assert.equal(stringify([shared,shared]),\'[{"a":1},{"a":1}]\');',
  },
  {
    id: "dlv-falsy-values",
    repository: "dlv",
    split: "development",
    category: "defect",
    requirement:
      "Deep lookup must return existing falsy values (0, false, empty string and null) unchanged. Use the default only for undefined or missing paths. Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration.",
    mutation: [
      {
        file: "index.js",
        before: "obj === undef ? def : obj",
        after: "obj || def",
      },
    ],
    acceptance:
      dlvImport +
      "for(const value of [0,false,'',null])assert.equal(dlv({a:{b:value}},'a.b','fallback'),value);assert.equal(dlv({a:{b:undefined}},'a.b','fallback'),'fallback');",
  },
  {
    id: "dlv-array-path",
    repository: "dlv",
    split: "development",
    category: "defect",
    requirement:
      "Restore array-form property paths, including keys containing literal dots and numeric array indexes. Keep dotted string paths working and do not mutate the caller's path array.",
    mutation: [
      {
        file: "index.js",
        before: "key.split ? key.split('.') : key",
        after: "key.split('.')",
      },
    ],
    acceptance:
      dlvImport +
      "const p=['a.b','0','c'];const data={'a.b':[{c:5}]};assert.equal(dlv(data,p),5);assert.deepEqual(p,['a.b','0','c']);assert.equal(dlv({a:{b:2}},'a.b'),2);",
  },
  {
    id: "dlv-null-traversal",
    repository: "dlv",
    split: "holdout",
    category: "defect",
    requirement:
      "Missing or null intermediate objects must return the supplied default instead of throwing. Preserve empty paths and successful deep lookup. Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration.",
    mutation: [
      {
        file: "index.js",
        before: "obj ? obj[key[p]] : undef",
        after: "obj[key[p]]",
      },
    ],
    acceptance:
      dlvImport +
      "assert.equal(dlv(null,'a.b','x'),'x');assert.equal(dlv({a:null},'a.b','x'),'x');assert.equal(dlv({},['a','b'],9),9);assert.equal(dlv({a:2},[],9).a,2);",
  },
  {
    id: "dlv-options-integration",
    repository: "dlv",
    split: "holdout",
    category: "cross-file",
    requirement:
      "Fix the new lookupWithOptions integration: export it from the public index and forward options.defaultValue while preserving present falsy values. Keep the existing default export and API unchanged.",
    setup: {
      "lookup.js":
        "import dlv from './index.js';\nexport function lookupWithOptions(obj,path,options={}) { return dlv(obj,path,options.defaultValue); }\n",
    },
    publicExport: {
      file: "index.js",
      line: "export {lookupWithOptions} from './lookup.js';\n",
    },
    mutation: [
      {
        file: "index.js",
        before: "export {lookupWithOptions} from './lookup.js';\n",
        after: "",
      },
      {
        file: "lookup.js",
        before: "options.defaultValue",
        after: "options.fallback",
      },
    ],
    acceptance:
      "const {lookupWithOptions,default:dlv}=await import('./index.js');assert.equal(typeof lookupWithOptions,'function');assert.equal(lookupWithOptions({},'a',{defaultValue:7}),7);assert.equal(lookupWithOptions({a:0},'a',{defaultValue:7}),0);assert.equal(dlv({a:1},'a'),1);",
  },
];
