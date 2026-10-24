import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createAiServer} from '../backend/server.mjs';
import {validateAiExtraction} from '../backend/validation.mjs';
const source='Office invoice\nWater pack | 1 | 40.00\nNo GST\nTotal | 40.00';
const doc=()=>({protocolVersion:1,ready:true,currency:'AUD',reference:'ref',issues:[],subtotal:40,gst:0,total:40,totalEvidence:'40.00',taxEvidence:'No GST',items:[{description:'Water pack',quantity:1,unitCost:40,measure:'EA',amount:40,gstAmount:0,taxRate:0,evidence:'Water pack'}]});
test('valid extraction becomes a flagged review line with explicit no-GST tax',()=>{
 const [line]=validateAiExtraction(doc(),source);assert.equal(line.tax,'No GST Applied');assert.equal(line.aiGenerated,true);assert.equal(line.check,'check');
});
for(const [name,mutate] of [
 ['ambiguous',d=>d.ready=false],['issues',d=>d.issues=['Tax unclear']],['currency',d=>d.currency='USD'],['totals',d=>d.total=44],['quantity',d=>d.items[0].quantity=2],['rate',d=>d.items[0].unitCost=41],['negative',d=>d.items[0].amount=-40],['GST',d=>d.items[0].taxRate=.1],['invented evidence',d=>d.items[0].evidence='Not printed'],['invented total',d=>d.totalEvidence='Total 40'],['markup',d=>d.items[0].description='<img src=x>'],['nonfinite',d=>d.items[0].quantity=Infinity],['zero items',d=>d.items=[]],['tax evidence',d=>d.taxEvidence='Made up']
])test('rejects '+name,()=>{const d=doc();mutate(d);assert.throws(()=>validateAiExtraction(d,source),/AI result rejected/);});
test('taxed invoice reconciles line GST and gross total',()=>{
 const d=doc();Object.assign(d,{subtotal:36.36,gst:3.64,total:40,taxEvidence:'incl GST'});Object.assign(d.items[0],{unitCost:36.36,amount:36.36,gstAmount:3.64,taxRate:.1});
 assert.equal(validateAiExtraction(d,source+' incl GST')[0].tax,'GST Applied');
});
const script=readFileSync(new URL('../../../downloads/nexvia-quote-to-po-v1.71.user.js',import.meta.url),'utf8');
const section=(a,b)=>script.slice(script.indexOf(a),script.indexOf(b,script.indexOf(a)));
function browser(overrides={}){
 const controls={qfile:{files:[{name:'sample.pdf',size:1000}]},qtext:{value:''},qinvoiceAction:{value:'append'},qaiconsent:{checked:true},qaiurl:{value:'https://proxy.example/extract'},qaitoken:{value:'a'.repeat(32)},qaireview:{checked:false},qairemember:{checked:false}};
 const saved={};let sent=0;
 const ctx={learningSource:null,location:{hostname:'nexvia.test'},console:{log(){}},log(){},URL,AbortSignal,mode:'inv',aiReviewRequired:true,$:id=>controls[id],toast(){},
 localStorage:{setItem:(k,v)=>saved[k]=v,removeItem:k=>delete saved[k]},sessionStorage:{setItem:(k,v)=>saved[k]=v},
 fetch:async()=>{sent++;return{ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({protocolVersion:1,document:doc()})};},...overrides};
 vm.runInNewContext(section('// ==UserScript==','  // ---------- NEXVIA GRID')+
 section('  function saveAiSettings(','  async function readDoc()')+
 'toast=()=>{};pdfToItems=async()=>globalThis.fixture;globalThis.api={readAiDoc,aiEndpoint,aiPreviewAllowed};})();',ctx);
 ctx.fixture=source.split('\n').map((s,n)=>({page:1,x:0,y:100-n*10,s}));
 return{ctx,controls,sent:()=>sent};
}
test('browser validates the same responses as the backend',async()=>{
 const {ctx,sent}=browser();const result=await ctx.api.readAiDoc();assert.equal(result[0].amount,40);assert.equal(sent(),1);
});
test('sharing consent is required before sending document text',async()=>{
 const {ctx,controls,sent}=browser();controls.qaiconsent.checked=false;await assert.rejects(()=>ctx.api.readAiDoc(),/Confirm sharing/);assert.equal(sent(),0);
});
test('AI cannot run Match PO or cause deletions',async()=>{
 const {ctx,controls,sent}=browser();controls.qinvoiceAction.value='match';await assert.rejects(()=>ctx.api.readAiDoc(),/cannot replace or delete/);assert.equal(sent(),0);
});
test('review checkbox is mandatory for import and append-only restriction remains enforced',()=>{
 const {ctx,controls}=browser();assert.equal(ctx.api.aiPreviewAllowed(),false);controls.qaireview.checked=true;assert.equal(ctx.api.aiPreviewAllowed(),true);controls.qinvoiceAction.value='match';assert.equal(ctx.api.aiPreviewAllowed(),false);
});
test('reject insecure endpoints and misplaced provider keys',async()=>{
 const {ctx,controls,sent}=browser();for(const endpoint of ['http://proxy.example/extract','https://user:pass@proxy.example/extract','https://proxy.example/extract?secret=1','https://proxy.example/other'])assert.throws(()=>ctx.api.aiEndpoint(endpoint));
 controls.qaitoken.value='sk-'+ 'a'.repeat(40);await assert.rejects(()=>ctx.api.readAiDoc(),/not an OpenAI/);assert.equal(sent(),0);
});
test('bad AI response cannot create a preview',async()=>{
 const d=doc();d.items[0].unitCost=400;
 const {ctx}=browser({fetch:async()=>({ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({protocolVersion:1,document:d})})});
 await assert.rejects(()=>ctx.api.readAiDoc(),/AI result rejected/);
});
const config={apiKey:'mock-provider-key',proxyToken:'a'.repeat(32),allowedOrigins:['https://company.nexvia.com']};
const handlers=new Map();
async function serve(t,fetchFn){const server=createAiServer(config,fetchFn);const url='mock:'+handlers.size;handlers.set(url,server.listeners('request')[0]);t.after(()=>handlers.delete(url));return url;}
async function httpFetch(url,{method,headers,body}){
  const req={method,url:'/extract',headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),async *[Symbol.asyncIterator](){yield Buffer.from(body||'');}};
  return new Promise((resolve,reject)=>{const responseHeaders={};const res={destroyed:false,setHeader(k,v){responseHeaders[k]=v;},writeHead(status){this.status=status;},end(text){resolve(new Response(text,{status:this.status,headers:responseHeaders}));}};Promise.resolve(handlers.get(url)(req,res)).catch(reject);});
}
const headers={Origin:config.allowedOrigins[0],Authorization:'Bearer '+config.proxyToken,'Content-Type':'application/json'};
const body=JSON.stringify({protocolVersion:1,text:source});
test('proxy sends only extraction text, no tools, store false, strict schema; returns validated result',async t=>{
 let request;const url=await serve(t,async(endpoint,options)=>{assert.equal(endpoint,'https://api.openai.com/v1/responses');request=JSON.parse(options.body);return{ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(doc())}]}]})};});
 const response=await httpFetch(url,{method:'POST',headers,body});assert.equal(response.status,200);assert.equal((await response.json()).document.total,40);
 assert.equal(request.store,false);assert.equal(request.text.format.strict,true);assert.equal(request.tools,undefined);assert.match(request.instructions,/untrusted/);assert.equal(request.input[0].content[0].text,source);
});
test('authentication and exact CORS origin are enforced before provider calls',async t=>{
 let calls=0;const url=await serve(t,async()=>{calls++;});
 assert.equal((await httpFetch(url,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
 assert.equal((await httpFetch(url,{method:'POST',headers:{...headers,Authorization:'Bearer wrong'},body})).status,401);assert.equal(calls,0);
});
test('provider errors are not exposed with secret or upstream details',async t=>{
 const url=await serve(t,async()=>({ok:false}));const response=await httpFetch(url,{method:'POST',headers,body});assert.equal(response.status,502);assert.ok(!(await response.text()).includes(config.apiKey));
});
test('refusal, truncated and mathematically wrong output are rejected by backend',async t=>{
 let reply={status:'incomplete',output:[]};const url=await serve(t,async()=>({ok:true,json:async()=>reply}));
 assert.equal((await httpFetch(url,{method:'POST',headers,body})).status,422);
 reply={status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]};assert.equal((await httpFetch(url,{method:'POST',headers,body})).status,422);
 const d=doc();d.items[0].quantity=20;reply={status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(d)}]}]};assert.equal((await httpFetch(url,{method:'POST',headers,body})).status,422);
});
test('actual Add and Apply buttons cannot mutate a PO before AI review',async()=>{
 const {ctx,controls}=browser();Object.assign(controls,{qgo:{},qapply:{},qattach:{checked:false}});
 let added=0,applied=0;
 Object.assign(ctx,{busy:false,items:[{description:'Test'}],cmp:[{inv:{description:'Test'},status:'new'}],aiPreviewAllowed:ctx.api.aiPreviewAllowed,checkSupplierRef:()=>true,
 runBusy:async(button,label,fn)=>fn(),pushToNexvia:async()=>{added++;return 1;},applyInvoice:async()=>{applied++;return true;},readPoLines:()=>[],compareAppendInvoice:()=>[],renderCmp(){}});
 vm.runInNewContext(section("  $('qgo').onclick =",'  setMode(mode);'),ctx);
 await controls.qgo.onclick();await controls.qapply.onclick();assert.equal(added,0);assert.equal(applied,0);
 controls.qaireview.checked=true;await controls.qgo.onclick();await controls.qapply.onclick();assert.equal(added,1);assert.equal(applied,1);
});
test('invalid and oversized extracted text are rejected before a paid provider request',async t=>{
 let calls=0;const url=await serve(t,async()=>{calls++;});
 for(const body of ['not json',JSON.stringify({protocolVersion:1,text:'a'.repeat(200001)}),JSON.stringify({protocolVersion:2,text:source})])assert.equal((await httpFetch(url,{method:'POST',headers,body})).status,400);
 assert.equal(calls,0);
});
test('backend returns a specific validation reason without provider details or secrets',async t=>{
 const d=doc();d.items[0].quantity=20;
 const url=await serve(t,async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(d)}]}]})}));
 const response=await httpFetch(url,{method:'POST',headers,body});assert.equal(response.status,422);const result=await response.json();assert.equal(result.errorCode,'AI_VALIDATION');assert.match(result.error,/quantity times rate differs/);assert.ok(!JSON.stringify(result).includes(config.apiKey));
});
test('browser shows the backend validation reason instead of only HTTP 422',async()=>{
 const {ctx}=browser({fetch:async()=>({ok:false,status:422,headers:{get:()=>null},text:async()=>JSON.stringify({errorCode:'AI_VALIDATION',error:'AI result rejected: an item has no matching source evidence'})})});
 await assert.rejects(()=>ctx.api.readAiDoc(),/HTTP 422: AI result rejected: an item has no matching source evidence/);
});
