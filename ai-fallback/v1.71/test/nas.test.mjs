import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,copyFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {fixture} from './layouts.test.mjs';
test('self-contained NAS server loads from an otherwise empty folder and trains/reads without AI',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'nexvia-standalone-'));const file=join(folder,'server.mjs');await copyFile(new URL('../nas/server.mjs',import.meta.url),file);
 const {createAiServer}=await import(pathToFileURL(file).href);let paid=0;
 const handler=createAiServer({apiKey:'mock-key',proxyToken:'a'.repeat(32),allowedOrigins:['https://company.nexvia.com'],templatePath:join(folder,'data/layouts.json')},async()=>{paid++;throw Error('No AI calls expected');}).listeners('request')[0];
 async function request(body){const req={method:'POST',url:'/templates',headers:{origin:'https://company.nexvia.com',authorization:'Bearer '+'a'.repeat(32),'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({protocolVersion:1,...body}));}};return new Promise((resolve,reject)=>{const res={destroyed:false,setHeader(){},writeHead(s){this.status=s;},end(t){resolve({status:this.status,data:JSON.parse(t)});}};Promise.resolve(handler(req,res)).catch(reject);});}
 const save=await request({action:'learn',name:'Supplier quote',items:fixture(),reviewed:[{description:'Insulation pack',quantity:7,unitCost:130.5,amount:913.5,measure:'Pack',tax:'GST Applied'}]});assert.equal(save.status,200);
 const result=await request({action:'match',items:fixture(10,140)});assert.equal(result.data.match.lines[0].amount,1400);assert.equal(paid,0);
});
