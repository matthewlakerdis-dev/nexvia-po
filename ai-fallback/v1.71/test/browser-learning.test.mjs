import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import vm from 'node:vm';
import {createAiServer} from '../backend/server.mjs';
function fixture(q=7,p=130.5){const net=Math.round(q*p*100)/100,gst=Math.round(net*10)/100;
 const i=(s,x,y,w=s.length*5)=>({page:1,s,x,y,w}),n=(s,end,y)=>i(s,end-s.length*5,y);
 return[i('ABN:',20,800),i('12345678901',65,800),i('Quantity',38,600,33),i('Description',200,600,60),i('Price',334,600,20),i('Extended',480,600,40),n(String(q),76,580),i('PROD-01',100,580),i('Insulation pack',200,580),n('$'+p.toFixed(2),363,580),i('Pack',400,580),n('$'+net.toFixed(2),520,580),i('SALE AMOUNT',390,300),n('$'+net.toFixed(2),520,300),i('GST',430,280),n('$'+gst.toFixed(2),520,280),i('TOTAL',420,260),n('$'+(Math.round((net+gst)*100)/100).toFixed(2),520,260)];}
const source=readFileSync(new URL('../../../downloads/nexvia-quote-to-po-v1.71.user.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
async function setup(){
 let aiCalls=0,requests=0;
 const handler=createAiServer({apiKey:'mock-key',proxyToken:'a'.repeat(32),allowedOrigins:['https://company.nexvia.com'],templatePath:join(await mkdtemp(join(tmpdir(),'nexvia-browser-')),'templates.json')},async()=>{aiCalls++;throw Error('AI should not be called');}).listeners('request')[0];
 const controls={qaiurl:{value:'https://proxy.example/extract'},qaitoken:{value:'a'.repeat(32)},quselearned:{checked:false},qlayoutname:{value:'Supplier quote'},qaireview:{checked:true}};
 const ctx={mode:'new',aiReviewRequired:true,learningSource:fixture(),items:[{description:'PROD-01 Insulation pack',quantity:7,unitCost:130.5,amount:913.5,measure:'Pack',tax:'GST Applied'}],cmp:[],location:{hostname:'nexvia.test'},console:{log(){}},log(){},URL,AbortSignal,structuredClone,$:id=>controls[id],localStorage:{setItem(){}},fetch:async(url,options)=>{
  requests++;assert.equal(new URL(url).pathname,'/templates');
  const req={url:'/templates',method:'POST',headers:{origin:'https://company.nexvia.com',authorization:options.headers.Authorization,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(options.body);}};
  return new Promise((resolve,reject)=>{const res={destroyed:false,setHeader(){},writeHead(s){this.status=s;},end(text){resolve({ok:this.status===200,status:this.status,text:async()=>text});}};Promise.resolve(handler(req,res)).catch(reject);});
 }};
 const start=source.indexOf('  async function readSingleDoc('),end=source.indexOf('  function clearReadPreview()',start);
 vm.runInNewContext(section('// ==UserScript==','  // ---------- NEXVIA GRID')+section('  async function layoutRequest(','  function saveAiSettings()')+section('  function aiEndpoint(','  async function readAiDoc()')+source.slice(start,end)+
 'toast=()=>{};pdfToItems=async()=>globalThis.fixture;globalThis.api={learnReviewedLayout,tryLearnedLayout,readSingleDoc};})();',ctx);
 return{ctx,controls,aiCalls:()=>aiCalls,requests:()=>requests};
}
test('confirm learning then read a changed invoice through normal PDF read without AI',async()=>{
 const {ctx,controls,aiCalls}=await setup();await ctx.api.learnReviewedLayout();assert.equal(controls.quselearned.checked,true);
 ctx.fixture=fixture(10,140);const lines=await ctx.api.readSingleDoc({name:'next.pdf'},'');assert.equal(lines[0].quantity,10);assert.equal(lines[0].unitCost,140);assert.equal(lines[0].amount,1400);assert.equal(aiCalls(),0);
});
test('learning requires the user review checkbox before any NAS request',async()=>{
 const {ctx,controls,requests}=await setup();controls.qaireview.checked=false;await assert.rejects(()=>ctx.api.learnReviewedLayout(),/review confirmation/);assert.equal(requests(),0);
});
test('changed totals for known supplier require AI review rather than a permissive generic fallback',async()=>{
 const {ctx}=await setup();await ctx.api.learnReviewedLayout();ctx.fixture=fixture(10,140).map(i=>i.y===580&&i.s==='$1400.00'?{...i,s:'$1401.00'}:i);
 await assert.rejects(()=>ctx.api.readSingleDoc({},''),/none passed the layout and total checks/);
});
test('disabling saved layouts avoids all NAS requests',async()=>{
 const {ctx,controls,requests}=await setup();controls.quselearned.checked=false;assert.equal(await ctx.api.tryLearnedLayout(fixture()),null);assert.equal(requests(),0);
});
test('failed or unsupported learning does not save a guessed layout',async()=>{
 const {ctx,requests}=await setup();ctx.learningSource=fixture().filter(i=>i.s!=='Description');await assert.rejects(()=>ctx.api.learnReviewedLayout(),/reliable reusable table/);assert.equal(requests(),0);
});
