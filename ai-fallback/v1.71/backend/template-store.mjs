import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateTemplate} from './layouts.mjs';
export function createTemplateStore(path){
 let queue=Promise.resolve();
 async function load(){
  if(!path)throw Error('Configure TEMPLATE_STORE_PATH and a persistent data mount to enable saved layouts');
  try{
   if((await stat(path)).size>2000000)throw Error('Template storage exceeds its size limit');
   const data=JSON.parse(await readFile(path,'utf8'));
   if(data.version!==1||!Array.isArray(data.templates)||data.templates.length>100)throw Error('Invalid template store');
   return data.templates.map(record=>{
    if(!record||!/^[a-f0-9]{24}$/.test(record.id)||typeof record.updatedAt!=='string')throw Error('Invalid saved template metadata');
    return{id:record.id,updatedAt:record.updatedAt,template:validateTemplate(record.template)};
   });
  }catch(error){if(error.code==='ENOENT')return[];throw error;}
 }
 async function commit(records){
  await mkdir(dirname(path),{recursive:true});
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify({version:1,templates:records}),{mode:0o600,flag:'wx'});await rename(temporary,path);
 }
 const exclusive=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 return{
  list:()=>exclusive(load),
  save:template=>exclusive(async()=>{
   template=validateTemplate(template);const records=await load();
   const identity={...template,name:''};const id=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);
   const record={id,updatedAt:new Date().toISOString(),template};const n=records.findIndex(r=>r.id===id);
   if(n<0){if(records.length>=100)throw Error('Delete an unused layout before saving another');records.push(record);}else records[n]=record;
   await commit(records);return record;
  }),
  remove:id=>exclusive(async()=>{if(!/^[a-f0-9]{24}$/.test(id))throw Error('Invalid layout identifier');const records=await load();const kept=records.filter(r=>r.id!==id);if(kept.length===records.length)throw Error('Saved layout was not found');await commit(kept);}),
 };
}
