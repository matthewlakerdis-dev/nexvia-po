// ==UserScript==
// @name         Lennox - Export Nexvia PO Lists
// @namespace    lennox-nexvia
// @version      1.0
// @description  Read loaded dropdown options and export a private project list for the Lennox PO request form
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==
(function () {
 'use strict';
 if (!/nexvia/i.test(location.hostname) || document.getElementById('lennox-po-list-export')) return;
 const host=document.createElement('div');host.id='lennox-po-list-export';document.body.append(host);
 const root=host.attachShadow({mode:'open'});
 root.innerHTML=`<style>
 :host{all:initial;font:13px/1.5 "Segoe UI",Arial,sans-serif;color:#243d57}*{box-sizing:border-box}button,input,select{font:inherit;border-radius:4px}button{cursor:pointer;border:1px solid #bdcddd;padding:9px 12px;background:white;color:#1a324c}button:disabled{background:#a0aab5;color:white;cursor:wait}#launch{position:fixed;left:18px;bottom:18px;z-index:100001;background:#1a324c;color:white;box-shadow:0 3px 18px #0003}#panel{position:fixed;left:18px;bottom:68px;z-index:100002;background:#f2f6fa;border:1px solid #bdcddd;border-radius:9px;width:min(480px,calc(100vw - 36px));max-height:85vh;overflow:auto;box-shadow:0 12px 50px #0004;padding:22px}#panel[hidden]{display:none}h2{font-size:19px;color:#1a324c;margin:0 0 8px}p{margin:0 0 14px}label{display:block;font-weight:600;margin-top:12px}input,select{display:block;width:100%;padding:9px;border:1px solid #bdcddd;background:white;color:#243d57;margin-top:5px}small{display:block;color:#63788b;margin-top:5px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.primary{background:#1a324c;color:white}#status{margin-top:14px;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#a92f39}</style>
 <button id="launch">Export PO lists</button><section id="panel" aria-label="Nexvia PO list exporter" hidden><h2>Export Nexvia PO lists</h2><p>Reads loaded dropdowns only. Does not select options or click Save / Create.</p><small>Open the Acct# and Breakdown Type dropdowns manually, clear any search text, then refresh after opening each list. Choose their sources below. Each export belongs to one project.</small>
 <label>Project dropdown source<select id="projectSource"></select></label><small>If a project dropdown is available, its current selected name is used.</small>
 <label>Current project name<input id="projectName" maxlength="500" placeholder="Exact selected Nexvia project name"></label><small>Check this name against the current PO. Enter it here if Nexvia does not expose a project dropdown on this page.</small>
 <label>Acct# dropdown source<select id="accountSource"></select></label>
 <label>Breakdown Type dropdown source<select id="breakdownSource"></select></label>
 <div class="actions"><button id="refresh">Refresh loaded lists</button><button id="export" class="primary">Export this project</button><button id="close">Close</button></div><div id="status" role="status" aria-live="polite"></div></section>`;
 const $=id=>root.getElementById(id);let sources=[],scopeName='';
 ['click','mousedown','pointerdown','keydown'].forEach(type=>host.addEventListener(type,e=>e.stopPropagation()));
 const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
 // Preserve source text, including account prefixes / leading zeroes.
 const label=x=>String(x??'').trim();
 const get=(record,path)=>{if(!record||!path)return null;try{if(typeof record.get==='function')return record.get(path);return String(path).split('.').reduce((v,k)=>v?.[k],record);}catch(_){return null;}};
 const placeholder=s=>!s||/^(?:select|choose|please select|select (?:an? |the )?(?:project|account|acct#|breakdown(?: type)?))\s*(?:\.{3}|…)?$/i.test(s);
 function caption(el){
  const explicit=[...document.querySelectorAll('label[for]')].find(l=>l.htmlFor===el.id)?.textContent;
  const cell=el.closest('td'),table=cell?.closest('table');
  const header=cell&&table?[...table.querySelectorAll('thead tr')].at(-1)?.children[cell.cellIndex]?.textContent:'';
  return clean(explicit||header||el.getAttribute('aria-label')||el.name||el.id||'Unnamed dropdown');
 }
 function readSources(){
  const found=[],seen=new Set();
  for(const el of document.querySelectorAll('select,input')){
   if(el.closest('#qpo'))continue;
   let w=null;
   try{const jq=window.jQuery||window.$;if(typeof jq==='function'){const e=jq(el);w=e.data('kendoDropDownList')||e.data('kendoComboBox')||null;}}catch(_){}
   if(w&&w.dataSource){
    if(seen.has(w))continue;seen.add(w);
    const ds=w.dataSource,raw=Array.from(ds.data?.()||[]),tf=w.options?.dataTextField||'text',vf=w.options?.dataValueField;
    const texts=raw.filter(r=>r!=null&&(!vf||get(r,vf)!==''&&get(r,vf)!=null)).map(r=>label(typeof r==='string'?r:get(r,tf))).filter(s=>!placeholder(s));
    const options=[...new Set(texts)];if(!options.length)continue;
    let total=0,filtered=false;try{total=Number(ds.total?.()||0);const f=ds.filter?.();filtered=!!(f&&(Array.isArray(f)?f.length:f.filters?f.filters.length:Object.keys(f).length));}catch(_){}
    const remote=!!(ds.options?.serverFiltering||ds.options?.serverPaging);
    const partial=total>raw.length||remote&&filtered;
    found.push({el,options,caption:caption(el),selected:label(w.text?.()||''),partial,reason:partial?'This source is filtered or has unloaded pages. Clear the search and load the full list before exporting.':''});
   }else if(el.tagName==='SELECT'){
    const options=[...new Set([...el.options].filter(o=>!o.disabled&&o.value!==''&&!placeholder(label(o.textContent))).map(o=>label(o.textContent)))];
    if(options.length)found.push({el,options,caption:caption(el),selected:label(el.selectedOptions[0]?.textContent),partial:false,reason:''});
   }
  }
  return found;
 }
 function status(s,error=false){$('status').textContent=s;$('status').classList.toggle('error',error);}
 function fill(id,pattern,old){const sel=$(id);sel.replaceChildren(new Option('Choose a loaded dropdown',''));sources.forEach((s,i)=>sel.add(new Option(s.caption+' — '+s.options.length+' option(s)'+(s.partial?' [partial]':''),String(i))));let index=sources.findIndex(s=>s.el===old);if(index<0)index=sources.findIndex(s=>pattern.test(s.caption));sel.value=index<0?'':String(index);}
 function refresh(){const old=['projectSource','accountSource','breakdownSource'].map(id=>sources[$(id).value]?.el);const live=readSources();const currentProject=live.find(s=>/^(?:project|job)(?:\s|$)/i.test(s.caption)&&s.options.includes(s.selected));const name=currentProject?.selected||label($('projectName').value);if(scopeName!==name){sources=[];scopeName=name;}const byCaption=new Map(sources.map(s=>[s.caption,s]));live.forEach(s=>byCaption.set(s.caption,s));sources=[...byCaption.values()];fill('projectSource',/^(?:project|job)(?:\s|$)/i,old[0]);fill('accountSource',/acct\s*#|account/i,old[1]);fill('breakdownSource',/breakdown/i,old[2]);project();status(sources.length+' readable dropdown source(s). Check the project and source selections before exporting.');}
 function project(){const p=sources[$('projectSource').value];if(p&&p.options.includes(p.selected))$('projectName').value=p.selected;else if(p)$('projectName').value='';}
 $('launch').onclick=()=>{$('panel').hidden=!$('panel').hidden;if(!$('panel').hidden)refresh();};$('close').onclick=()=>$('panel').hidden=true;$('projectSource').onchange=()=>{project();scopeName='';sources=[];refresh();};$('projectName').onchange=()=>{scopeName='';sources=[];refresh();};$('refresh').onclick=refresh;
 let pending;new MutationObserver(()=>{if($('panel').hidden)return;clearTimeout(pending);pending=setTimeout(refresh,80);}).observe(document.body,{childList:true,subtree:true});
 $('export').onclick=()=>{
  const button=$('export');button.disabled=true;button.textContent='Preparing list…';
  try{
   // Read again, without opening dropdowns, fetching data or changing selections.
   const before=sources,now=readSources();
   const pick=id=>{const old=before[$(id).value];return old?(now.find(s=>s.el===old.el||s.caption===old.caption)||old):null;};
   const p=pick('projectSource'),a=pick('accountSource'),b=pick('breakdownSource');let name=label($('projectName').value);
   if(p){if(!p.options.includes(p.selected))throw new Error('Select the project in Nexvia before exporting.');if(name!==p.selected)throw new Error('The project name differs from Nexvia’s current selection. Refresh the lists.');name=p.selected;}
   if(!name)throw new Error('Enter the exact current project name.');
   if(!a||!b)throw new Error('Open Acct# and Breakdown Type in Nexvia, refresh, then select both dropdown sources.');
   if(a.el===b.el||p&&(p.el===a.el||p.el===b.el))throw new Error('Choose a different source dropdown for each field.');
   if(a.partial||b.partial)throw new Error(a.reason||b.reason);
   const data={format:'lennox-nexvia-po-lists',version:1,exportedAtUTC:new Date().toISOString(),projects:[{name,accounts:a.options,breakdowns:b.options}],capture:{scope:'One current project; loaded options only',accountSource:a.caption,breakdownSource:b.caption}};
   const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='Nexvia-PO-Lists-'+name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,70)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
   status('Exported '+name+': '+a.options.length+' Acct# and '+b.options.length+' Breakdown options. Load this private JSON file in the PO request form. Repeat for other projects. Only loaded options can be captured; verify coverage in Nexvia.');
  }catch(e){status(e.message,true);}finally{button.disabled=false;button.textContent='Export this project';}
 };
})();
