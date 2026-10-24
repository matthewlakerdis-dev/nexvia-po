import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import vm from 'node:vm';
import {trainTemplate,applyTemplate,validateTemplate} from '../backend/layouts.mjs';import {createTemplateStore} from '../backend/template-store.mjs';import {createAiServer} from '../backend/server.mjs';
export function fixture(quantity=7,price=130.5){
 const amount=Math.round(quantity*price*100)/100,gst=Math.round(amount*10)/100,total=Math.round((amount+gst)*100)/100;
 const i=(s,x,y,w=s.length*5)=>({page:1,s,x,y,w});const n=(s,end,y)=>i(s,end-s.length*5,y);
 return[i('ABN:',20,800),i('12345678901',65,800),i('Quantity',38,600,33),i('Description',200,600,60),i('Price',334,600,20),i('Extended',480,600,40),
 n(String(quantity),76,580),i('PROD-01',100,580),i('Insulation pack',200,580),n('$'+price.toFixed(2),363,580),i('Pack',400,580),n('$'+amount.toFixed(2),520,580),
 i('SALE AMOUNT',390,300),n('$'+amount.toFixed(2),520,300),i('GST',430,280),n('$'+gst.toFixed(2),520,280),i('TOTAL',420,260),n('$'+total.toFixed(2),520,260)];
}
const reviewed=[{description:'PROD-01 Insulation pack',quantity:7,unitCost:130.5,amount:913.5,measure:'Pack',tax:'GST Applied'}];
const template=()=>trainTemplate(fixture(),reviewed,'Supplier quote');
test('learn and reuse table without storing any sample values or executable rules',()=>{
 const t=template();const json=JSON.stringify(t);for(const value of ['913.5','130.5','PROD-01','Insulation pack','eval','expression'])assert.ok(!json.includes(value));
 const [line]=applyTemplate(t,fixture());assert.equal(line.quantity,7);assert.equal(line.unitCost,130.5);assert.equal(line.amount,913.5);assert.equal(line.gstAmount,91.35);assert.equal(line.learnedLayout,true);
});
test('new quantities, prices and descriptions come from the next PDF',()=>{
 const items=fixture(10,140).map(i=>i.s==='PROD-01'?{...i,s:'PROD-02'}:i);
 const [line]=applyTemplate(template(),items);assert.equal(line.quantity,10);assert.equal(line.unitCost,140);assert.equal(line.amount,1400);assert.equal(line.gstAmount,140);assert.match(line.description,/PROD-02/);
});
test('rows below a new page header may move vertically without changing column identity',()=>{
 const items=fixture(3,120).map(i=>i.y<=600?{...i,y:i.y-20}:i);assert.equal(applyTemplate(template(),items)[0].amount,360);
});
for(const [label,change] of [
 ['different supplier',a=>a.map(i=>i.s==='12345678901'?{...i,s:'10987654321'}:i)],
 ['missing rate',a=>a.filter(i=>i.s!=='$130.50')],['wrong amount',a=>a.map(i=>i.y===580&&i.s==='$913.50'?{...i,s:'$914.50'}:i)],
 ['wrong GST',a=>a.map(i=>i.y===280?i.s==='$91.35'?{...i,s:'$91.36'}:i:i)],
 ['changed headers',a=>a.map(i=>i.s==='Price'?{...i,x:i.x+30}:i)],['missing supplier ABN',a=>a.filter(i=>i.s!=='ABN:')]
])test('reject '+label,()=>assert.throws(()=>applyTemplate(template(),change(fixture()))));
test('arbitrary parsing code is rejected by the template schema',()=>assert.throws(()=>validateTemplate({...template(),expression:'fetch(secret)'}),/Invalid declarative/));
test('unreconciled confirmation cannot train a template',()=>assert.throws(()=>trainTemplate(fixture(),[{...reviewed[0],amount:914.5}],'bad')));
test('mixed tax treatment refuses learning rather than generalising one example incorrectly',()=>assert.throws(()=>trainTemplate(fixture(),[...reviewed,{...reviewed[0],tax:'No GST Applied'}],'mixed'),/one tax treatment/));
test('ambiguous duplicated header refuses learned match',()=>{const a=fixture();a.push({...a.find(i=>i.s==='Price'),y:620});assert.throws(()=>applyTemplate(template(),a),/ambiguous/);});
test('learned layouts survive independent store instances, deduplicate and delete',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'nexvia-templates-')),'layouts.json');const a=createTemplateStore(path);const record=await a.save(template());
 const b=createTemplateStore(path);assert.equal((await b.list()).length,1);await b.save({...template(),name:'Updated label'});assert.equal((await b.list()).length,1);assert.equal((await b.list())[0].template.name,'Updated label');
 const text=await readFile(path,'utf8');assert.ok(!text.includes('913.5'));await b.remove(record.id);assert.equal((await a.list()).length,0);
});
test('concurrent template writes are serialised without lost saves',async()=>{
 const store=createTemplateStore(join(await mkdtemp(join(tmpdir(),'nexvia-templates-')),'layouts.json'));
 await Promise.all([store.save(template()),store.save({...template(),abn:'10987654321',name:'Other supplier'})]);assert.equal((await store.list()).length,2);
});
test('corrupted storage is not silently overwritten',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'nexvia-templates-')),'layouts.json');await writeFile(path,'broken');await assert.rejects(()=>createTemplateStore(path).save(template()));assert.equal(await readFile(path,'utf8'),'broken');
});
test('persistent store must be configured',async()=>assert.rejects(()=>createTemplateStore().list(),/persistent data mount/));
const config={apiKey:'mock-key',proxyToken:'a'.repeat(32),allowedOrigins:['https://company.nexvia.com']};
async function request(handler,body,token=config.proxyToken){
 const req={url:'/templates',method:'POST',headers:{origin:config.allowedOrigins[0],authorization:'Bearer '+token,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({protocolVersion:1,...body}));}};
 return new Promise((resolve,reject)=>{const res={destroyed:false,setHeader(){},writeHead(status){this.status=status;},end(text){resolve({status:this.status,body:JSON.parse(text)});}};Promise.resolve(handler(req,res)).catch(reject);});
}
test('authenticated learn, future match, listing and deletion never call the AI provider',async()=>{
 let aiCalls=0;const path=join(await mkdtemp(join(tmpdir(),'nexvia-api-')),'layouts.json');
 const handler=createAiServer({...config,templatePath:path},async()=>{aiCalls++;throw Error('AI must not run');}).listeners('request')[0];
 assert.equal((await request(handler,{action:'learn',name:'Supplier quote',items:fixture(),reviewed},'wrong')).status,401);
 const saved=await request(handler,{action:'learn',name:'Supplier quote',items:fixture(),reviewed});assert.equal(saved.status,200);
 const match=await request(handler,{action:'match',items:fixture(10,140)});assert.equal(match.status,200);assert.equal(match.body.match.lines[0].amount,1400);assert.ok(match.body.match.template);
 assert.equal((await request(handler,{action:'list'})).body.templates.length,1);
 assert.equal((await request(handler,{action:'delete',id:saved.body.id})).status,200);
 assert.equal((await request(handler,{action:'match',items:fixture()})).body.match,null);assert.equal(aiCalls,0);
});
test('layout API is unavailable without persistent storage, not silently ephemeral',async()=>{
 const handler=createAiServer(config,async()=>{throw Error('must not call AI');}).listeners('request')[0];assert.equal((await request(handler,{action:'list'})).status,503);
});
test('one confirmed row generalises to multiple new rows and changing totals',()=>{
 const all=fixture();const amount=973.5,gst=97.35,total=1070.85;
 for(const i of all){if(i.y===300&&i.s==='$913.50')i.s='$'+amount.toFixed(2);if(i.y===280&&i.s==='$91.35')i.s='$'+gst.toFixed(2);if(i.y===260&&i.s==='$1004.85')i.s='$'+total.toFixed(2);}
 const n=(s,end)=>({page:1,s,x:end-s.length*5,y:550,w:s.length*5});
 all.push(n('3',76),{page:1,s:'PROD-02',x:100,y:550,w:35},{page:1,s:'Other pack',x:200,y:550,w:50},n('$20.00',363),{page:1,s:'Pack',x:400,y:550,w:20},n('$60.00',520));
 const lines=applyTemplate(template(),all);assert.equal(lines.length,2);assert.equal(lines[1].quantity,3);assert.equal(lines[1].unitCost,20);assert.match(lines[1].description,/PROD-02/);
 assert.equal(Math.round(lines.reduce((n,i)=>n+i.amount,0)*100),97350);
});
test('changed printed measure cannot silently inherit the training measure',()=>assert.throws(()=>applyTemplate(template(),fixture().map(i=>i.s==='Pack'?{...i,s:'Roll'}:i)),/printed unit/));
test('learning refuses unprinted or unverified units',()=>assert.throws(()=>trainTemplate(fixture().filter(i=>i.s!=='Pack'),reviewed,'No units'),/reliable reusable table/));
test('a foreign-currency document does not inherit an Australian template',()=>assert.throws(()=>applyTemplate(template(),[...fixture(),{page:1,s:'Prices USD',x:20,y:750,w:50}]),/Foreign currency/));
