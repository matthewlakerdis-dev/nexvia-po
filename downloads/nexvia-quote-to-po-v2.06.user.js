// ==UserScript==
// @name         Nexvia - Quote to PO Lines
// @namespace    lennox-nexvia
// @version      2.06
// @description  Import supplier quote lines into a Nexvia PO, or update an existing PO from the supplier invoice
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (!/nexvia/i.test(location.hostname)) return;
  console.log('[Quote→PO] v2.06 starting on', location.href);

  // ---------- SETTINGS ----------
  const CFG = {
    cols: {
      description: 'Item Description',
      measure: 'Measure',
      unitCost: 'Unit Cost',
      quantity: 'Quantity',
      supplierRef: 'Supplier R',
      acct: 'Acct#',
      amount: 'Amount (Ex Tax)',
      tax: 'Tax',
      costCat: 'Cost Category',
      breakdown: 'Breakdown Type',
    },
    addRowText: 'Click To Add New Row',
    stepDelay: 300,               // ms between actions - increase if Nexvia is slow
    skipLine: /\b(sub\s*-?total|total|gst|tax|balance|amount due|deposit|page \d)/i,
  };

  // pdf.js is only loaded when you pick a PDF (keeps the script from failing to start)
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = PDFJS + 'pdf.min.js';
      sc.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        res(window.pdfjsLib);
      };
      sc.onerror = () => rej(new Error('Could not load the PDF reader (blocked by network?). Paste the lines instead.'));
      document.head.appendChild(sc);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (s) => {
    if (s == null) return NaN;
    const t = String(s).replace(/[$,\s]/g, '');
    return /^-?(\d+(\.\d+)?|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
  };
  const isNum = (s) => !isNaN(num(s));
  const isUom = (s) => /^(ea|each|m|lm|l\/m|m2|m²|sqm|mm|pcs?|pc|no|nr|item|set|lot|kg|hr|hrs|len|lengths?|sht|sheet|box|pk|pack|roll)$/i.test(s);
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.01);
  const cents = (a, b) => Math.abs(a - b) < 0.005;
  const r2 = (v) => Math.round(v * 100) / 100;
  const mk = (description, quantity, unitCost, measure) =>
    ({ description: description.trim(), quantity, unitCost, measure: measure || '', check: 'ok' });

  // On-screen notification (bottom centre). Click to dismiss; fades after 6 seconds.
  function toast(msg, ok = true) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100000;' +
      'background:' + (ok ? '#2e9e5b' : '#c0392b') + ';color:#fff;padding:14px 22px;border-radius:8px;' +
      'font:600 15px Segoe UI,Arial;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;transition:opacity .4s;max-width:80vw';
    t.onclick = () => t.remove();
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 6000);
  }

const AI_PROTOCOL_VERSION = 1;
function validateAiExtraction(data, sourceText) {
  const fail = message => { const error = new Error('AI result rejected: ' + message); error.code = 'AI_VALIDATION'; throw error; };
  const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e8 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-5;
  const equal = (a,b) => Math.abs(a-b) < 0.005;
  const text = s => typeof s === 'string' && s.trim() && s.length <= 4000;
  const normalize = s => s.replace(/\s*\|\s*/g,' ').replace(/\$\s+(?=\d)/g,'$').replace(/\s+/g,' ').trim();
  if (!data || data.protocolVersion !== 1 || data.ready !== true || data.currency !== 'AUD') fail('the document is ambiguous, unsupported or not AUD');
  if (!text(sourceText) && !(typeof sourceText === 'string' && sourceText.length > 4000)) fail('source text is missing');
  const source = normalize(sourceText);
  const proof = s => text(s) && source.includes(normalize(s));
  if (!Array.isArray(data.issues) || data.issues.length) fail('the model reported an unresolved issue');
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 200) fail('invalid item count');
  if (![data.subtotal,data.gst,data.total].every(money) || !equal(round(data.subtotal+data.gst),data.total)) fail('document totals do not reconcile');
  // Compare complete numeric tokens, permitting only currency/thousands
  // formatting differences. Never match a substring or join separate columns.
  const evidenceToken = text(data.totalEvidence) ? normalize(data.totalEvidence) : '';
  const moneyToken = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
  if (!moneyToken.test(evidenceToken)) fail('total evidence must be a numeric amount, without labels or commentary');
  const numericEvidence = Number(evidenceToken.replace(/[$,]/g,''));
  if (numericEvidence !== data.total) fail('the total evidence differs from the extracted total');
  const printedAmounts = [...source.matchAll(/(?<![\w.,])\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\w.,])/g)]
    .map(match => Number(match[0].replace(/[$,]/g,'')));
  if (!printedAmounts.includes(data.total)) fail('the total amount is absent from the OCR text; check the scanned total');
  if (!proof(data.taxEvidence)) fail('the tax treatment has no source evidence');
  let net=0,tax=0;
  const lines=data.items.map(item => {
    if (!item || !text(item.description) || /[\u0000-\u001f<>]/.test(item.description)) fail('invalid description');
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1e6 || !Number.isFinite(item.unitCost) || item.unitCost < 0 || item.unitCost > 1e8) fail('invalid quantity or rate');
    if (![item.amount,item.gstAmount].every(money) || !equal(round(item.quantity*item.unitCost),item.amount)) fail('quantity times rate differs from the line amount');
    if (![0,0.1].includes(item.taxRate) || !equal(round(item.amount*item.taxRate),item.gstAmount)) fail('line tax is inconsistent');
    if (typeof item.measure !== 'string' || !/^[a-zA-Z0-9²/ ]{0,20}$/.test(item.measure)) fail('invalid measure');
    if (!proof(item.evidence)) fail('an item has no matching source evidence');
    net+=item.amount;tax+=item.gstAmount;
    return {description:item.description.trim(),quantity:item.quantity,unitCost:item.unitCost,measure:item.measure,
      amount:item.amount,gstAmount:item.gstAmount,grossAmount:round(item.amount+item.gstAmount),tax:item.taxRate===0?'No GST Applied':'GST Applied',check:'check',aiGenerated:true};
  });
  if (!equal(round(net),data.subtotal) || !equal(round(tax),data.gst)) fail('line totals do not match the document');
  return lines;
}

// Declarative table templates: supplier ABN, column geometry and headings only.
// No executable expressions, sample descriptions, quantities or prices are saved.
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const equal=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<.005;
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).toLowerCase();
const number=s=>/^\$?\s*-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(clean(s))?Number(clean(s).replace(/[$,\s]/g,'')):NaN;
const right=i=>i.x+i.w;
const canonicalUnit=s=>{
 const n=norm(s);
 if(/^(pack|packs|pk)(?:\b|$)/.test(n))return 'pack';
 if(/^(each|ea|piece|pieces|pc|pcs)(?:\b|$)/.test(n))return 'ea';
 if(/^(hour|hours|hr|hrs)(?:\b|$)/.test(n))return 'hr';
 if(/^(m2|m²|sqm|square metre|square meter)(?:\b|$)/.test(n))return 'm2';
 if(/^(lm|m|linear|lineal|metre|meter)(?:\b|$)/.test(n))return 'lm';
 return n;
};
function checkItems(all){
 if(!Array.isArray(all)||!all.length||all.length>12000)throw Error('Layout learning needs 1–12000 text fragments');
 if(all.some(i=>/(?:\b(?:USD|NZD|EUR|GBP|CAD|JPY|CNY|SGD|HKD)\b|US\$|NZ\$|€|£|¥)/i.test(i.s||'')))throw Error('Foreign currency requires AI review');
 if(new Set(all.map(i=>i.page)).size!==1)throw Error('Learning currently supports one-page tables');
 return all.map(i=>{
  if(typeof i.s!=='string'||!i.s.trim()||i.s.length>1000||!Number.isInteger(i.page)||i.page<1||!['x','y','w'].every(k=>Number.isFinite(i[k])&&i[k]>=0&&i[k]<=5000))throw Error('Invalid layout text geometry');
  return {page:i.page,x:i.x,y:i.y,w:i.w,s:i.s};
 });
}
function rowsOf(all){const rows=[];for(const i of [...all].sort((a,b)=>b.y-a.y||a.x-b.x)){const row=rows.find(r=>Math.abs(r.y-i.y)<3);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});}for(const r of rows)r.t.sort((a,b)=>a.x-b.x);return rows;}
function abn(all){
 const text=rowsOf(all).map(r=>r.t.map(i=>i.s).join(' ')).join('\n');
 const found=[...text.matchAll(/\bA\.?B\.?N\.?\s*:?\s*((?:\d[ \t]*){11})(?!\d)/gi)].map(m=>m[1].replace(/\s/g,''));
 const unique=[...new Set(found)];if(unique.length!==1)throw Error('A unique printed supplier ABN is needed to learn this layout');return unique[0];
}
function footers(all,amountRight){
 const kinds={subtotal:[],gst:[],total:[]};
 for(const row of rowsOf(all)){
  const nums=row.t.filter(i=>Number.isFinite(number(i.s)));
  if(nums.length!==1||Math.abs(right(nums[0])-amountRight)>14)continue;
  const label=norm(row.t.filter(i=>i!==nums[0]&&i.s!=='$').map(i=>i.s).join(' '));
  if(/\b(sub\s*total|sale amount|total exclusive|total ex(?:cluding)?\.? gst)\b/.test(label))kinds.subtotal.push({y:row.y,value:number(nums[0].s)});
  else if(/^(?:total\s+)?gst(?:\s*\(?10(?:\.0+)?%\)?)?$/.test(label))kinds.gst.push({y:row.y,value:number(nums[0].s)});
  else if(/^(?:invoice\s+)?total(?:\s+(?:inclusive|inc\.? gst|amount(?: payable)?))?$/.test(label))kinds.total.push({y:row.y,value:number(nums[0].s)});
 }
 if(Object.values(kinds).some(a=>a.length!==1))throw Error('Unique printed subtotal, GST and total are required for a learned table');
 const f=Object.fromEntries(Object.entries(kinds).map(([k,v])=>[k,v[0]]));
 if(!equal(round(f.subtotal.value+f.gst.value),f.total.value))throw Error('Printed layout totals do not reconcile');return f;
}
function headerWords(all,first,columns){
 const roles={quantity:/^(qty|quantity)$/i,description:/^(description|details)$/i,price:/^(price|rate|cost)$/i,amount:/^(amount|extended|extd|total)$/i};
 const anchors=[];
 for(const [role,re] of Object.entries(roles)){
  let candidates=all.filter(i=>i.y>first.y+3&&i.y<first.y+65&&re.test(clean(i.s)));
  if(role!=='description')candidates=candidates.filter(i=>Math.abs(right(i)-columns[role])<45).sort((a,b)=>Math.abs(right(a)-columns[role])-Math.abs(right(b)-columns[role]));
  else candidates=candidates.filter(i=>i.x>columns.quantity&&i.x<columns.price);
  if(!candidates.length)throw Error('This layout lacks clear quantity, description, price and amount headings');
  anchors.push({role,text:norm(candidates[0].s),x:candidates[0].x,w:candidates[0].w});
 }
 return anchors;
}
function validateTemplate(t){
 const keys=['version','name','abn','basis','taxRate','measure','columns','descriptionLeft','descriptionRight','headers','unit'];
 if(!t||Object.keys(t).some(k=>!keys.includes(k))||t.version!==1||typeof t.name!=='string'||!t.name.trim()||t.name.length>80||/[<>\x00-\x1f]/.test(t.name)||!/^\d{11}$/.test(t.abn)||!['net','gross'].includes(t.basis)||![0,.1].includes(t.taxRate)||typeof t.measure!=='string'||t.measure.length>80||/[<>\x00-\x1f]/.test(t.measure))throw Error('Invalid declarative template');
 if(!t.columns||Object.keys(t.columns).sort().join(',')!=='amount,price,quantity'||!Object.values(t.columns).every(n=>Number.isFinite(n)&&n>=0&&n<=5000)||!(t.columns.quantity+15<t.columns.price&&t.columns.price+15<t.columns.amount))throw Error('Invalid template columns');
 if(![t.descriptionLeft,t.descriptionRight].every(n=>Number.isFinite(n)&&n>=0&&n<=5000)||!(t.descriptionLeft<t.descriptionRight&&t.descriptionRight<t.columns.price))throw Error('Invalid description bounds');
 if(!t.unit||Object.keys(t.unit).sort().join(',')!=='text,x'||typeof t.unit.text!=='string'||!/^[a-z²/ ]{1,30}$/.test(t.unit.text)||!Number.isFinite(t.unit.x)||t.unit.x<t.columns.price||t.unit.x>t.columns.amount)throw Error('Invalid printed unit rule');
 if(!Array.isArray(t.headers)||t.headers.length!==4||new Set(t.headers.map(h=>h.role)).size!==4||!t.headers.every(h=>Object.keys(h).sort().join(',')==='role,text,w,x'&&['quantity','description','price','amount'].includes(h.role)&&typeof h.text==='string'&&/^[a-z ]{2,30}$/.test(h.text)&&[h.x,h.w].every(n=>Number.isFinite(n)&&n>=0&&n<=5000)))throw Error('Invalid header anchors');
 return structuredClone(t);
}
function applyTemplate(template,input){
 const t=validateTemplate(template),all=checkItems(input);
 if(abn(all)!==t.abn)throw Error('Supplier does not match');
 const matches=t.headers.map(h=>all.filter(i=>norm(i.s)===h.text&&Math.abs(i.x-h.x)<10&&Math.abs(i.w-h.w)<20));
 if(matches.some(a=>a.length!==1))throw Error('Table headings changed or are ambiguous');
 const header=matches.map(a=>a[0]);if(Math.max(...header.map(i=>i.y))-Math.min(...header.map(i=>i.y))>25)throw Error('Header geometry changed');
 const f=footers(all,t.columns.amount),top=Math.min(...header.map(i=>i.y))-3,bottom=Math.max(f.subtotal.y,f.gst.y,f.total.y)+3;
 if(top<=bottom)throw Error('Charge band is invalid');
 const rows=rowsOf(all).filter(r=>r.y<top&&r.y>bottom),anchors=[];
 for(const row of rows){
  const nums=row.t.filter(i=>Number.isFinite(number(i.s)));
  const pick=key=>nums.filter(i=>Math.abs(right(i)-t.columns[key])<6);
  const q=pick('quantity'),p=pick('price'),a=pick('amount');
  if(!q.length&&!p.length&&!a.length)continue;
  if(q.length!==1||p.length!==1||a.length!==1||new Set([q[0],p[0],a[0]]).size!==3)throw Error('An incomplete or ambiguous charge requires AI review');
  const quantity=number(q[0].s),price=number(p[0].s),amount=number(a[0].s);
  if(quantity<=0||quantity>1e6||price<0||price>1e8||amount<0||amount>1e8||!equal(round(quantity*price),amount))throw Error('Learned quantity times rate does not match printed line amount');
  const units=row.t.filter(i=>norm(i.s)===t.unit.text&&Math.abs(i.x-t.unit.x)<10);
  if(units.length!==1)throw Error('The printed unit changed or is missing; use AI review');
  anchors.push({y:row.y,quantity,price,amount,tokens:[q[0],p[0],a[0]]});
 }
 if(!anchors.length||anchors.length>200)throw Error('No supported charge rows');
 const lines=anchors.map((a,n)=>{
  const low=Math.max(bottom,anchors[n+1]?.y+3||bottom,a.y-60);
  const tokens=all.filter(i=>i.y<=a.y+3&&i.y>low&&i.x>=t.descriptionLeft&&i.x<t.descriptionRight&&!a.tokens.includes(i));
  const description=rowsOf(tokens).map(r=>r.t.map(i=>i.s).join(' ')).join(' ').trim();
  if(!description||/[<>\x00-\x1f]/.test(description))throw Error('Learned description is incomplete');
  const amount=t.basis==='gross'&&t.taxRate===.1?round(a.amount/1.1):a.amount;
  const gstAmount=t.taxRate===.1?round(amount*.1):0;
  return {description,quantity:a.quantity,unitCost:t.basis==='net'?a.price:amount/a.quantity,amount,measure:t.measure,gstAmount,grossAmount:round(amount+gstAmount),tax:t.taxRate===.1?'GST Applied':'No GST Applied',check:'check',learnedLayout:true};
 });
 const sum=k=>round(lines.reduce((n,i)=>n+i[k],0));
 if(!equal(sum('amount'),f.subtotal.value)||!equal(sum('gstAmount'),f.gst.value)||!equal(sum('grossAmount'),f.total.value))throw Error('Learned charges do not reconcile to printed net, GST and total');
 return lines;
}
function trainTemplate(input,reviewed,name){
 const all=checkItems(input);
 if(!Array.isArray(reviewed)||!reviewed.length||reviewed.length>200)throw Error('Review 1–200 charge lines first');
 if(reviewed.some(i=>!i||!Number.isFinite(i.quantity)||i.quantity<=0||!Number.isFinite(i.unitCost)||i.unitCost<0||!Number.isFinite(i.amount)||i.amount<0||!equal(round(i.quantity*i.unitCost),i.amount)||!['GST Applied','No GST Applied'].includes(i.tax)))throw Error('Reviewed charge values or tax are invalid');
 const taxes=new Set(reviewed.map(i=>i.tax)),measures=new Set(reviewed.map(i=>i.measure||''));
 if(taxes.size!==1||measures.size!==1)throw Error('This first learning release supports tables with one tax treatment and one measure; use AI for mixed tables');
 const candidates=[];
 for(const basis of ['net','gross']){
  if(basis==='gross'&&reviewed[0].tax==='No GST Applied')continue;
  const selected=[];
  for(const line of reviewed){
   const target=basis==='net'?line.amount:round(line.amount+round(line.amount*(line.tax==='GST Applied'?.1:0)));
   const matches=[];
   for(const row of rowsOf(all)){
    const nums=row.t.filter(i=>Number.isFinite(number(i.s)));
    if(nums.length>30)throw Error('Too many numeric columns to learn this table reliably');
    for(const q of nums.filter(i=>Math.abs(number(i.s)-line.quantity)<1e-6))for(const p of nums)for(const a of nums){
     if(!(right(q)+15<right(p)&&right(p)+15<right(a))||!equal(number(a.s),target)||!equal(round(number(q.s)*number(p.s)),target))continue;
     if(basis==='net'&&!equal(number(p.s),line.unitCost))continue;
     matches.push({y:row.y,q,p,a});
    }
   }
   if(matches.length!==1){selected.length=0;break;}selected.push(matches[0]);
  }
  if(selected.length!==reviewed.length||new Set(selected.map(r=>r.y)).size!==selected.length)continue;
  const first=[...selected].sort((a,b)=>b.y-a.y)[0];
  const columns={quantity:right(first.q),price:right(first.p),amount:right(first.a)};
  if(selected.some(r=>Math.abs(right(r.q)-columns.quantity)>5||Math.abs(right(r.p)-columns.price)>5||Math.abs(right(r.a)-columns.amount)>5))continue;
  try{
   const headers=headerWords(all,first,columns),priceHead=headers.find(h=>h.role==='price');
   const units=selected.map(r=>all.filter(i=>Math.abs(i.y-r.y)<3&&i.x>right(r.p)&&right(i)<r.a.x&&canonicalUnit(i.s)===canonicalUnit(reviewed[0].measure)));
   if(units.some(a=>a.length!==1)||units.some(a=>norm(a[0].s)!==norm(units[0][0].s)||Math.abs(a[0].x-units[0][0].x)>10))continue;
   const unit={text:norm(units[0][0].s),x:units[0][0].x};
   const t=validateTemplate({version:1,name,abn:abn(all),basis,taxRate:reviewed[0].tax==='GST Applied'?.1:0,measure:reviewed[0].measure||'',columns,descriptionLeft:columns.quantity+5,descriptionRight:priceHead.x-5,headers,unit});
   const parsed=applyTemplate(t,all);
   if(parsed.length!==reviewed.length||parsed.some((i,n)=>!equal(i.amount,reviewed[n].amount)||Math.abs(i.quantity-reviewed[n].quantity)>1e-6||!equal(i.unitCost,reviewed[n].unitCost)))continue;
   candidates.push(t);
  }catch{}
 }
 if(candidates.length!==1)throw Error('A reliable reusable table could not be inferred from this read. Keep using AI for this layout; no template was saved.');
 return candidates[0];
}

function readSupplierAbn(input){return abn(checkItems(input));}

  // ---------- PARSING (pasted text) ----------
  function parseLines(lines) {
    const items = [];
    let started = false;
    for (const raw of lines) {
      const line = raw.replace(/\u00a0/g, ' ').trim();
      if (!line) continue;

      if (line.includes('\t')) {   // Excel paste
        const c = line.split('\t').map((x) => x.trim());
        const idx = c.map((x, i) => (isNum(x) ? i : -1)).filter((i) => i >= 0);
        if (idx.length >= 2 && !CFG.skipLine.test(c[0])) {
          const desc = c.filter((x, i) => !idx.includes(i) && !isUom(x)).join(' ');
          items.push(mk(desc, num(c[idx[0]]), num(c[idx[1]]), c.find(isUom) || ''));
          started = true;
        }
        continue;
      }

      const tok = line.split(/\s+/);
      const nums = [];
      let uom = '';
      while (tok.length && (isNum(tok[tok.length - 1]) || (nums.length && !uom && isUom(tok[tok.length - 1])))) {
        const t = tok.pop();
        if (isNum(t)) nums.unshift(num(t)); else uom = t;
        if (nums.length >= 4) break;
      }
      const desc = tok.join(' ');

      if (CFG.skipLine.test(line) && nums.length <= 2) continue;
      if (/^(ph|phone|tel|fax|mob(ile)?|abn|acn|bsb|acc(ount)?|a\/c)\b[\s.:#]*/i.test(desc) ||
        /^(telephone|facsimile)\s*:/i.test(desc) || /:$/.test(desc)) continue;

      if (nums.length >= 3) {
        let [q, u, t] = nums.slice(-3);
        if (!near(q * u, t)) [q, u, t] = nums.slice(0, 3);
        if (!near(q * u, t)) {
          const [a, b, c] = nums.slice(-3);
          if (near(a * b, c)) { q = b; u = a; t = c; }
        }
        const it = mk(desc, q, u, uom);
        it.amount = t;
        it.check = near(q * u, t) ? 'ok' : 'check';
        items.push(it); started = true;
      } else if (nums.length === 2 && desc && isNum(tok[0]) && near(num(tok[0]) * nums[0], nums[1])) {
        // "Qty  Code/Description  UnitRate  Amount" (Knotwood quote style)
        const it = mk(tok.slice(1).join(' '), num(tok[0]), nums[0], uom);
        it.amount = nums[1];
        items.push(it); started = true;
      } else if (nums.length === 2 && desc) {
        const [a, b] = nums;
        const it = a === b ? mk(desc, 1, a, uom) : mk(desc, a, b, uom);
        it.check = 'check';
        items.push(it); started = true;
      } else if (started && !nums.length && items.length && !CFG.skipLine.test(line)) {
        items[items.length - 1].description += ' ' + line;
      }
    }
    return items.filter((i) => i.description && !isNaN(i.quantity) && !isNaN(i.unitCost));
  }

  // ---------- PARSING (PDF) ----------
  let ocrLoader = null;
  const OCR_CDN = 'https://cdn.jsdelivr.net/npm/';
  function loadOcr() {
    if (window.Tesseract && typeof window.Tesseract.createWorker === 'function') return Promise.resolve(window.Tesseract);
    if (ocrLoader) return ocrLoader;
    let timer;
    // Use the package's ESM build so a page's AMD/RequireJS loader cannot
    // capture its UMD export and leave window.Tesseract undefined.
    ocrLoader = Promise.race([
      import(OCR_CDN + 'tesseract.js@5.1.1/dist/tesseract.esm.min.js'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR reader download timed out')), 30000); }),
    ]).then((module) => {
      const engine = typeof module.createWorker === 'function' ? module : module.default;
      if (!engine || typeof engine.createWorker !== 'function') throw new Error('OCR reader loaded without createWorker');
      return engine;
    }).catch((error) => {
      ocrLoader = null;
      throw new Error('Could not initialise the OCR reader. Check whether Nexvia or the browser blocks the OCR module download, then retry. ' + error.message);
    }).finally(() => clearTimeout(timer));
    return ocrLoader;
  }

  function needsOcr(items) {
    const useful = items.filter((i) => !/^page\s+\d+(\s+of\s+\d+)?$/i.test(i.s));
    const smallTable = useful.some((i) => /^(qty|quantity|description|product description)$/i.test(i.s)) &&
      useful.some((i) => /^(amount|total)$/i.test(i.s)) && useful.some((i) => isNum(i.s));
    return !smallTable && useful.map((i) => i.s).join('').replace(/\s/g, '').length < 40;
  }

  function ocrWordsToItems(data, page, scale, height) {
    const out = [];
    for (const line of data.lines || []) {
      for (const word of line.words || []) {
        const s = word.text.trim();
        if (s) out.push({ page, x: word.bbox.x0 / scale, y: height - line.bbox.y1 / scale,
          w: (word.bbox.x1 - word.bbox.x0) / scale, s });
      }
    }
    return out;
  }

  async function ocrPdfPages(pdf, pages) {
    let worker;
    try {
      log('Scanned PDF detected. Reading it with OCR in this browser; the PDF is not uploaded.');
      const engine = await loadOcr();
      if (!engine || typeof engine.createWorker !== 'function') throw new Error('OCR reader is unavailable. Refresh Nexvia and retry.');
      worker = await engine.createWorker('eng', 1, {
        workerPath: OCR_CDN + 'tesseract.js@5.1.1/dist/worker.min.js',
        corePath: OCR_CDN + 'tesseract.js-core@5.1.1',
        langPath: OCR_CDN + '@tesseract.js-data/eng@1.0.0/4.0.0',
      });
      // Sparse-text mode preserves isolated prices inside large invoice boxes.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const out = [];
      for (const p of pages) {
        log(`OCR: reading page ${p} of ${pdf.numPages}...`);
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, Math.sqrt(8000000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        try {
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const { data } = await worker.recognize(canvas);
          out.push(...ocrWordsToItems(data, p, scale, base.height));
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      if (!out.length) throw new Error('OCR found no readable text in the scanned pages. Try a clearer PDF or paste its item lines.');
      return out;
    } catch (e) {
      throw new Error('Scanned PDF OCR could not finish. Clear the PDF and paste the item lines, or retry. ' + e.message);
    } finally { if (worker) await worker.terminate(); }
  }

  async function pdfToItems(file) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      tc.items.forEach((it) => {
        const t = it.str.trim();
        if (t) out.push({ page: p, x: it.transform[4], y: it.transform[5], w: it.width || 0, s: t });
      });
    }
    const scanned = [];
    for (let p = 1; p <= pdf.numPages; p++) if (needsOcr(out.filter((i) => i.page === p))) scanned.push(p);
    try {
      if (scanned.length) {
        const read = await ocrPdfPages(pdf, scanned);
        const kept = out.filter((i) => !scanned.includes(i.page));
        kept.push(...read);
        kept.ocr = true;
        return kept;
      }
      return out;
    } finally { if (pdf.destroy) await pdf.destroy(); }
  }

  // Nut & Bolt Factory prints zero-valued NOTE rows inside its product table.
  // These remain document annotations, never billable PO lines or tax instructions.
  function parseBydAspleyService(all) {
    if(!all.some(i=>/Zupps Aspley PTY LTD t\/as BYD Aspley/i.test(i.s)))return null;
    const fail=why=>{throw Error('Could not read the BYD Aspley service invoice: '+why+'. Review the PDF before adding lines.');};
    const clean=s=>String(s).replace(/\s+/g,' ').trim();
    const one=(values,label)=>{if(values.length!==1)fail(label+' is missing or duplicated');return values[0];};
    const find=(items,re)=>one(items.filter(i=>re.test(clean(i.s))),'a required heading');
    const moneyValue=s=>{const v=num(s);if(!Number.isFinite(v)||Math.abs(v)>1e8||Math.abs(v*100-Math.round(v*100))>1e-6)fail('an amount is invalid');return v;};
    const pages=[...new Set(all.map(i=>i.page))].sort((a,b)=>a-b);
    if(pages.length!==2||pages[0]!==1||pages[1]!==2)fail('expected both pages of the service invoice');
    let identity=null;const pageItems=[];
    for(const page of pages){
      const items=all.filter(i=>i.page===page);
      find(items,/^Service TAX Invoice$/i);find(items,new RegExp('^Page '+page+' of 2$'));
      const abn=find(items,/^ABN\s*:/i);if(abn.s.replace(/\D/g,'')!=='65009900298')fail('the supplier ABN changed');
      const doc=find(items,/^Doc #:\s*$/i);
      const invoice=clean(one(items.filter(i=>Math.abs(i.y-doc.y)<2&&i.x>doc.x+doc.w+2),'the invoice number').s);
      if(!/^[A-Za-z0-9-]{3,40}$/.test(invoice))fail('the invoice number is invalid');
      const below=(label,right)=>{
        const h=find(items,label);return clean(one(items.filter(i=>i.y<h.y-2&&i.y>h.y-16&&i.x>=h.x-2&&i.x<right),'a vehicle identity field').s);
      };
      const reg=below(/^Reg\. No\.$/i,80),vin=below(/^Vehicle ID\.$/i,190),date=below(/^Doc\. Date$/i,80);
      if(!/^[A-Za-z0-9 -]{3,15}$/.test(reg)||!/^\w{17}$/.test(vin)||!/^\d{2}\/\d{2}\/\d{2}$/.test(date))fail('vehicle or date fields are invalid');
      const [day,month,year]=date.split('/'),iso='20'+year+'-'+month+'-'+day;
      const calendar=new Date(iso+'T12:00:00Z');
      if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==iso)fail('document date is not a valid calendar date');
      const current={invoice,reg,vin,date};
      if(identity&&Object.keys(current).some(k=>current[k]!==identity[k]))fail('invoice, vehicle or date differs between pages');
      identity=current;
      const desc=find(items,/^Description$/i),operation=find(items,/^Operation$/i),amount=find(items,/^Amount$/i),labour=find(items,/^Labour$/i);
      if([operation,amount,labour].some(i=>Math.abs(i.y-desc.y)>2)||!(labour.x<operation.x&&operation.x<desc.x&&desc.x<amount.x))fail('service table columns changed');
      pageItems.push({items,desc,operation,amount});
    }
    const first=pageItems[0],last=pageItems[1],sameRow=(items,h)=>items.filter(i=>Math.abs(i.y-h.y)<2);
    const totalValue=(items,re)=>{const h=find(items,re);return moneyValue(one(sameRow(items,h).filter(i=>i.x>h.x+h.w+4&&isNum(i.s)),'a printed total').s);};
    const labourTotalHead=find(first.items,/^Total - Labour$/i),partsTotalHead=find(last.items,/^Total - Parts$/i);
    const labourTotal=totalValue(first.items,/^Total - Labour$/i),partsTotal=totalValue(last.items,/^Total - Parts$/i);
    const jobs=first.items.filter(i=>/^Job#$/i.test(clean(i.s))).sort((a,b)=>b.y-a.y),out=[];
    if(!jobs.length||first.desc.y<=jobs[0].y||jobs[jobs.length-1].y<=labourTotalHead.y)fail('labour job positions changed');
    let printedLabour=0;
    for(let n=0;n<jobs.length;n++){
      const h=jobs[n],row=sameRow(first.items,h),bottom=n+1<jobs.length?jobs[n+1].y:labourTotalHead.y;
      const index=num(one(row.filter(i=>i.x>h.x+h.w&&i.x<first.operation.x-3&&isNum(i.s)),'a job index').s);
      if(index!==n+1)fail('job indices are missing or out of order');
      const code=clean(one(row.filter(i=>i.x>=first.operation.x-2&&i.x<first.desc.x-2),'an operation code').s);
      const title=clean(one(first.items.filter(i=>Math.abs(i.x-first.desc.x)<3&&i.y<h.y-2&&i.y>h.y-15),'a job description').s);
      const prices=row.filter(i=>i.x>=first.amount.x-3);
      const printed=one(prices,'a job amount');
      if(first.items.filter(i=>i.y<h.y-2&&i.y>bottom+2&&i.x>=first.amount.x-3&&isNum(i.s)).length)fail('an extra job amount needs review');
      if(/^Internal$/i.test(clean(printed.s))){
        log('Unbilled internal job (excluded from PO charges): '+code+' '+title);continue;
      }
      const net=moneyValue(printed.s);if(net<=0)fail('a billed job has an unsupported amount');
      printedLabour+=net;
      out.push({...mk(code+' '+title+' - vehicle '+identity.reg,1,net,'EA'),amount:net,tax:'GST Applied',supplierRef:identity.invoice});
    }
    if(!out.length||!cents(r2(printedLabour),labourTotal))fail('billed labour jobs do not reconcile to Total Labour');
    const labourCount=out.length;
    if(first.items.filter(i=>i.y<first.desc.y-2&&i.y>labourTotalHead.y+2&&i.x>=first.amount.x-3&&isNum(i.s)).length!==labourCount)fail('a labour amount has no matched billed job');
    let printedParts=0;
    for(const [n,page] of pageItems.entries()){
      const top=n===0?labourTotalHead.y:page.desc.y,bottom=n===0?0:partsTotalHead.y;
      const body=page.items.filter(i=>i.y<top-2&&i.y>bottom+2);
      const codes=body.filter(i=>/^BY[A-Z0-9-]+$/i.test(clean(i.s))&&i.x>first.operation.x-20&&i.x<page.desc.x-2).sort((a,b)=>b.y-a.y);
      for(const code of codes){
        const row=sameRow(body,code),detail=clean(one(row.filter(i=>Math.abs(i.x-page.desc.x)<3),'a parts description').s);
        const quantity=num(one(row.filter(i=>i.x>450&&i.x<500&&isNum(i.s)),'a parts quantity').s);
        const net=moneyValue(one(row.filter(i=>i.x>=page.amount.x-3&&isNum(i.s)),'an extended parts amount').s);
        if(quantity<=0||quantity>1e5||net<=0)fail('a parts quantity or extended amount is invalid');
        const unitCost=net/quantity;
        if(!cents(r2(unitCost*quantity),net))fail('parts quantities and extended amounts do not reconcile');
        printedParts+=net;
        out.push({...mk(clean(code.s)+' '+detail+' - vehicle '+identity.reg,quantity,unitCost,'EA'),amount:net,tax:'GST Applied',supplierRef:identity.invoice});
      }
      const printedAmounts=body.filter(i=>i.x>=page.amount.x-3&&isNum(i.s));
      if(printedAmounts.length!==codes.length)fail('a parts amount has no matched product row');
    }
    if(out.length===labourCount||!cents(r2(printedParts),partsTotal))fail('parts charges do not reconcile to Total Parts');
    const summary={labour:totalValue(last.items,/^Total Labour$/i),parts:totalValue(last.items,/^Total Parts$/i),pol:totalValue(last.items,/^Total POL$/i),sublet:totalValue(last.items,/^Total Sublet$/i),misc:totalValue(last.items,/^Total Misc$/i),gst:totalValue(last.items,/^Total GST$/i),total:totalValue(last.items,/^Total Invoice$/i)};
    find(last.items,/^TOTAL INCLUDES GST$/i);
    if(!cents(summary.labour,labourTotal)||!cents(summary.parts,partsTotal)||summary.pol!==0||summary.sublet!==0)fail('labour, parts or unsupported charge sections changed');
    const miscTotal=totalValue(last.items,/^Total - Misc$/i),miscHead=find(last.items,/^Total - Misc$/i);
    const miscBody=last.items.filter(i=>i.y<partsTotalHead.y-2&&i.y>miscHead.y+2);
    const roundingCode=find(miscBody,/^RND$/i),roundingDesc=find(miscBody,/^ROUNDING$/i);
    if(Math.abs(roundingCode.y-roundingDesc.y)>2)fail('rounding row is incomplete');
    const rounding=moneyValue(one(sameRow(miscBody,roundingCode).filter(i=>i.x>=last.amount.x-3&&isNum(i.s)),'the printed rounding amount').s);
    if(Math.abs(rounding)>.1||!cents(rounding,miscTotal)||!cents(rounding,summary.misc)||miscBody.filter(i=>i.x>=last.amount.x-3&&isNum(i.s)).length!==1)fail('miscellaneous charges are not a small printed rounding amount');
    const net=r2(labourTotal+partsTotal+rounding);
    if(!cents(r2(net+summary.gst),summary.total))fail('printed category totals, GST and total invoice do not reconcile');
    if(rounding!==0){
      const line=out[0],original=line.amount,adjusted=r2(original+rounding);
      if(adjusted<=0)fail('rounding cannot be combined with a positive service charge');
      line.description+=' (printed labour $'+original.toFixed(2)+'; invoice rounding '+(rounding<0?'-$':'$')+Math.abs(rounding).toFixed(2)+' applied; PO line $'+adjusted.toFixed(2)+')';
      line.amount=line.unitCost=adjusted;
    }
    for(const line of out){line.gstAmount=r2(line.amount*.1);line.grossAmount=r2(line.amount+line.gstAmount);}
    if(!cents(r2(out.reduce((s,i)=>s+i.amount,0)),net)||!cents(r2(out.reduce((s,i)=>s+i.gstAmount,0)),summary.gst))fail('per-line GST does not reconcile to the printed invoice');
    if(rounding!==0){
      const audit='Printed invoice rounding '+(rounding<0?'-$':'$')+Math.abs(rounding).toFixed(2)+' combined with first labour charge. Printed labour $'+labourTotal.toFixed(2)+', parts $'+partsTotal.toFixed(2)+'. Printed and PO totals: ex GST $'+net.toFixed(2)+', GST $'+summary.gst.toFixed(2)+', total $'+summary.total.toFixed(2)+'. Parts quantities and extended amounts retained; unit rates derived from extended amounts.';
      for(const line of out){line.roundingNote=audit;line.roundingExpectedCount=out.length;line.roundingOriginal={description:line.description,quantity:line.quantity,unitCost:line.unitCost};}
      log(audit);
    }
    const [day,month,year]=identity.date.split('/');
    const metadata={supplier:'Zupps Aspley Pty Ltd t/as BYD Aspley',invoiceNumber:identity.invoice,date:'20'+year+'-'+month+'-'+day};
    out.forEach(line=>line.documentMetadata=metadata);
    log('Read BYD Aspley: '+labourCount+' billed labour jobs and '+(out.length-labourCount)+' parts charges; $'+net.toFixed(2)+' ex GST + $'+summary.gst.toFixed(2)+' GST = $'+summary.total.toFixed(2)+'. Printed rounding included; unbilled Internal jobs excluded.');
    return out;
  }

  function parseMiddayAluminium(all) {
    if(!all.some(i=>/^Midday Aluminium$/i.test(i.s.trim())))return null;
    const fail=why=>{throw Error('Could not read the Midday Aluminium quote: '+why+'. Review the PDF before adding lines.');};
    const clean=s=>String(s).replace(/\s+/g,' ').trim();
    const one=(a,label)=>{if(a.length!==1)fail(label+' is missing or duplicated');return a[0];};
    const find=re=>one(all.filter(i=>re.test(clean(i.s))),'a required heading');
    if(new Set(all.map(i=>i.page)).size!==1)fail('multi-page quotes need review');
    const abn=find(/^ABN:/i);if(abn.s.replace(/\D/g,'')!=='77717989236')fail('supplier ABN changed');
    find(/^QUOTE$/);find(/^5\. GOODS AND SERVICES TAX - GST has been applied to this quotation\.$/i);
    const description=find(/^Description of Works$/i),amount=find(/^Amount$/i),gstHead=find(/^GST Amount$/i),totalHead=find(/^TOTAL this Quote$/i);
    if(!(description.x<amount.x&&Math.abs(description.y-amount.y)<2&&description.y>gstHead.y&&gstHead.y>totalHead.y))fail('table or totals positions changed');
    const money=h=>num(one(all.filter(i=>Math.abs(i.y-h.y)<2&&i.x>h.x+h.w&&isNum(i.s)),'a printed total').s);
    const gst=money(gstHead),total=money(totalHead);
    const body=all.filter(i=>i.y<description.y-2&&i.y>gstHead.y+10);
    const charges=body.filter(i=>isNum(i.s)&&i.x>amount.x-5&&i.x<amount.x+amount.w+40).sort((a,b)=>b.y-a.y);
    if(!charges.length)fail('no printed charges found');
    const out=[];
    for(let n=0;n<charges.length;n++){
      const charge=charges[n],upper=n?charges[n-1].y-2:description.y-2,lower=n+1<charges.length?charges[n+1].y+2:gstHead.y+10;
      const row=body.filter(i=>i.y<upper&&i.y>lower);
      const fragments=row.filter(i=>i.x<amount.x-10&&!isNum(i.s)).sort((a,b)=>b.y-a.y||a.x-b.x);
      const detail=clean(fragments.map(i=>i.s).join(' '));
      const tax=row.filter(i=>i.x>charge.x+charge.w+3);
      if(!detail||tax.length!==1||clean(tax[0].s)!=='GST')fail('a charge description or GST marker is missing');
      const net=num(charge.s);
      if(net<=0||net>1e8||Math.abs(net*100-Math.round(net*100))>1e-6)fail('a charge amount is invalid');
      const gstAmount=r2(net*.1);
      out.push({...mk(detail,1,net,'EA'),amount:net,gstAmount,grossAmount:r2(net+gstAmount),tax:'GST Applied'});
    }
    const net=r2(out.reduce((s,i)=>s+i.amount,0)),calculatedGst=r2(out.reduce((s,i)=>s+i.gstAmount,0));
    if(!cents(calculatedGst,gst)||!cents(r2(net+gst),total))fail('charges, GST and total do not reconcile');
    if(body.filter(i=>isNum(i.s)).length!==charges.length)fail('unassigned numeric table values need review');
    log('Read Midday Aluminium: '+out.length+' lump-sum charge(s); $'+net.toFixed(2)+' ex GST + $'+gst.toFixed(2)+' GST = $'+total.toFixed(2)+'. Work quantities retained in descriptions; deposit and payment terms excluded.');
    return out;
  }

  function parsePremierScaffolds(all) {
    if(!all.some(i=>/^Premier Scaffolds Brisbane Pty Ltd$/i.test(i.s.trim())))return null;
    const fail=why=>{throw Error('Could not read the Premier Scaffolds invoice: '+why+'. Review the PDF before adding lines.');};
    const clean=s=>String(s).replace(/\uE081/g,'(').replace(/\uE088/g,'-').replace(/\s+/g,' ').trim();
    const one=(a,label)=>{if(a.length!==1)fail(label+' is missing or duplicated');return a[0];};
    const find=re=>one(all.filter(i=>re.test(clean(i.s))),'a required heading');
    if(new Set(all.map(i=>i.page)).size!==1)fail('multi-page invoices need review');
    find(/^28687536483$/);find(/^Tax Invoice$/i);
    const heading=find(/^Description$/i),band=all.filter(i=>Math.abs(i.y-heading.y)<2);
    const col=re=>one(band.filter(i=>re.test(clean(i.s))),'a table column');
    const qty=col(/^Quantity$/i),price=col(/^Price$/i),tax=col(/^Tax$/i),amount=col(/^Amount$/i);
    if(!(heading.x<qty.x&&qty.x<price.x&&price.x<tax.x&&tax.x<amount.x))fail('column order changed');
    const subtotalHead=find(/^Subtotal$/i),gstHead=find(/^Total GST 10%$/i),totalHead=find(/^Total$/i);
    if(!(heading.y>subtotalHead.y&&subtotalHead.y>gstHead.y&&gstHead.y>totalHead.y))fail('total positions changed');
    const money=h=>num(one(all.filter(i=>Math.abs(i.y-h.y)<2&&i.x>h.x+h.w&&isNum(i.s)),'a printed total').s);
    const subtotal=money(subtotalHead),gst=money(gstHead),total=money(totalHead);
    if(subtotal<=0||gst<0||total<=0||!cents(r2(subtotal+gst),total))fail('printed totals do not reconcile');
    const body=all.filter(i=>i.y<heading.y-2&&i.y>subtotalHead.y+2);
    const anchors=body.filter(i=>isNum(i.s)&&Math.abs(i.x+i.w-amount.x-amount.w)<2).sort((a,b)=>b.y-a.y);
    if(!anchors.length)fail('no item amounts found');
    let stage='';const out=[];
    for(let n=0;n<anchors.length;n++){
      const anchor=anchors[n],upper=n?(anchors[n-1].y+anchor.y)/2:heading.y-2,lower=n+1<anchors.length?(anchor.y+anchors[n+1].y)/2:subtotalHead.y+2;
      const row=body.filter(i=>i.y<upper&&i.y>lower);
      const desc=clean(row.filter(i=>i.x<qty.x-3).sort((a,b)=>b.y-a.y||a.x-b.x).map(i=>i.s).join(' '));
      const values=h=>row.filter(i=>isNum(i.s)&&Math.abs(i.x+i.w-h.x-h.w)<2);
      const rates=values(price),quantities=values(qty),taxes=row.filter(i=>i.x>=price.x+price.w+2&&i.x<tax.x+tax.w+3);
      const net=num(anchor.s),rate=num(one(rates,'an item price').s);
      if(!desc||net<0||rate<0)fail('an item is incomplete');
      if(!quantities.length){
        if(net!==0||rate!==0||taxes.length||!/^Stage\s+\d+\s*[-–—]/i.test(desc))fail('an unquantified row is not a zero-valued stage heading');
        stage=desc;continue;
      }
      const quantity=num(one(quantities,'an item quantity').s);
      if(quantity<=0||quantity>1e6||!cents(r2(quantity*rate),net)||Math.abs(net*100-Math.round(net*100))>1e-6)fail('quantity, price and amount do not reconcile');
      if(taxes.length!==1||clean(taxes[0].s)!=='10%'||Math.abs(taxes[0].x+taxes[0].w-tax.x-tax.w)>2)fail('an item tax rate is missing or unsupported');
      const gstAmount=r2(net*.1);
      out.push({...mk((stage?stage+' - ':'')+desc,quantity,rate,'EA'),amount:net,gstAmount,grossAmount:r2(net+gstAmount),tax:'GST Applied'});
    }
    if(!out.length||!cents(r2(out.reduce((s,i)=>s+i.amount,0)),subtotal)||!cents(r2(out.reduce((s,i)=>s+i.gstAmount,0)),gst))fail('item charges do not reconcile to subtotal and GST');
    // Account for every numeric table token, so an omitted row cannot pass silently.
    const numeric=body.filter(i=>isNum(i.s));
    if(numeric.length!==anchors.length*2+out.length)fail('unassigned item quantities or amounts need review');
    log('Read Premier Scaffolds: '+out.length+' charges; $'+subtotal.toFixed(2)+' ex GST + $'+gst.toFixed(2)+' GST = $'+total.toFixed(2)+'. Zero-valued stage heading retained in descriptions.');
    return out;
  }

  function parseNutBolt(all) {
    if(!all.some(i=>/^Nut\s*&\s*Bolt Factory$/i.test(i.s.trim())))return null;
    const fail=why=>{throw Error('Could not read the Nut & Bolt Factory order: '+why+'. Review the PDF before adding any lines.');};
    const clean=s=>String(s).replace(/\s+/g,' ').trim();
    const one=(values,label)=>{if(values.length!==1)fail(label+' is missing or duplicated');return values[0];};
    const find=re=>one(all.filter(i=>re.test(clean(i.s))),'a required heading');
    const pages=[...new Set(all.map(i=>i.page))].sort((a,b)=>a-b);
    if(pages.length>1){
      if(pages.length>10||pages.some((p,n)=>p!==n+1))fail('multi-page order sequence is incomplete');
      const first=all.filter(i=>i.page===1);
      const orderLabel=one(first.filter(i=>/^Order No\.:$/i.test(clean(i.s))),'first-page order number label');
      const order=clean(one(first.filter(i=>Math.abs(i.y-orderLabel.y)<2&&i.x>orderLabel.x+orderLabel.w&&/^\d+$/.test(clean(i.s))),'first-page order number').s);
      const flat=[],columns=[/^Barcode\s*\/\s*Description$/i,/^Tax$/i,/^Qty$/i,/^Price\s*\$$/i,/^Total\s*\$$/i];
      let firstColumns;
      for(const page of pages){
        const items=all.filter(i=>i.page===page),last=page===pages.length;
        const heading=one(items.filter(i=>columns[0].test(clean(i.s))),'a multi-page table heading');
        const band=items.filter(i=>Math.abs(i.y-heading.y)<2);
        const heads=columns.map(re=>one(band.filter(i=>re.test(clean(i.s))),'a multi-page product column'));
        if(firstColumns&&heads.some((h,n)=>Math.abs(h.x-firstColumns[n].x)>2||Math.abs(h.w-firstColumns[n].w)>2))fail('multi-page columns changed');
        firstColumns=firstColumns||heads;
        one(items.filter(i=>clean(i.s)==='Page '+page+'/'+pages.length),'a page number');
        if(page>1){
          one(items.filter(i=>/^Nut\s*&\s*Bolt Factory$/i.test(clean(i.s))),'continuation supplier');
          one(items.filter(i=>clean(i.s)==='Order No.: '+order),'continuation order number');
        }
        const footer=one(items.filter(i=>/^Page \d+\/\d+$/.test(clean(i.s))),'a page footer');
        const count=items.filter(i=>/^No\. of Items\s*\(\s*\d+\s*\)$/i.test(clean(i.s)));
        if(last&&count.length!==1||!last&&count.length)fail('item count is not on the final page');
        const bottom=last?count[0].y+2:footer.y+10;
        const kept=items.filter(i=>page===1&&i.y>=heading.y-2||i.y<heading.y-2&&i.y>bottom||last&&i.y<=count[0].y+2);
        for(const item of kept)flat.push({...item,y:item.y+(pages.length-page)*1000,page:1});
      }
      all=flat;
    }
    const abns=all.filter(i=>/^A\.?B\.?N\.?\s*:/i.test(clean(i.s)));
    if(abns.length!==1||clean(abns[0].s).replace(/[.\s:]/g,'').toUpperCase()!=='ABN69162023538')fail('the supplier ABN is not recognised');
    find(/^Sales Order$/i);
    const combined=all.some(i=>/^Barcode\s*\/\s*Description$/i.test(clean(i.s)));
    const description=find(combined?/^Barcode\s*\/\s*Description$/i:/^Description$/i),band=all.filter(i=>Math.abs(i.y-description.y)<2);
    const head=re=>one(band.filter(i=>re.test(clean(i.s))),'a product column');
    const code=combined?description:head(/^Bar code$/i),tax=head(/^Tax$/i),qty=head(/^Qty$/i),price=head(/^Price\s*\$$/i),amount=head(/^Total\s*\$$/i);
    if(!((combined?code.x===description.x:code.x<description.x)&&description.x<tax.x&&tax.x<qty.x&&qty.x<price.x&&price.x<amount.x))fail('the product column order changed');
    const countHead=find(/^No\. of Items\s*\(\s*\d+\s*\)$/i);
    const subtotalHead=find(/^Subtotal$/i),gstHead=one(all.filter(i=>/^Tax$/i.test(clean(i.s))&&i.y<subtotalHead.y),'printed tax total'),totalHead=find(/^TOTAL inc GST$/i);
    if(!(description.y>countHead.y&&countHead.y>subtotalHead.y&&subtotalHead.y>gstHead.y&&gstHead.y>totalHead.y))fail('the product and total bands changed');
    const money=label=>{
      const value=num(one(all.filter(i=>Math.abs(i.y-label.y)<(combined&&/^Subtotal$/i.test(clean(label.s))?3:2)&&i.x>label.x+label.w+3&&isNum(i.s)),'a printed amount').s);
      if(!Number.isFinite(value)||Math.abs(value)>1e8||Math.abs(value*100-Math.round(value*100))>1e-6)fail('a printed amount has invalid precision');return value;
    };
    const subtotal=money(subtotalHead),gst=money(gstHead),total=money(totalHead);
    if(subtotal<0||gst<0||total<0||!cents(r2(subtotal+gst),total))fail('subtotal, GST and total do not reconcile');
    for(const re of [/^Discount$/i,/^Rounding$/i])if(money(find(re))!==0)fail('discount or rounding needs manual review');
    const body=all.filter(i=>i.y<description.y-2&&i.y>countHead.y+2),rows=[];
    for(const i of [...body].sort((a,b)=>b.y-a.y||a.x-b.x)){const row=rows.find(r=>Math.abs(r.y-i.y)<2);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});}
    if(combined){
      const merged=[];
      for(const row of rows){
        if(row.t.some(i=>isNum(i.s)&&Math.abs(i.x+i.w-qty.x-qty.w)<2))merged.push(row);
        else {
          const prior=merged[merged.length-1];
          if(!prior||row.t.some(i=>i.x>=tax.x-3)||prior.y-row.y>25)fail('a wrapped description is not attached to a product');
          prior.t.push(...row.t);
        }
      }
      rows.splice(0,rows.length,...merged);
    }
    const out=[],notes=[];let printedQuantity=0;
    for(const row of rows){
      row.t.sort((a,b)=>a.x-b.x);
      const text=(left,right)=>clean(row.t.filter(i=>i.x>=left.x-3&&i.x<right.x-3).map(i=>i.s).join(' '));
      const left=combined?row.t.filter(i=>i.x<tax.x-3).sort((a,b)=>b.y-a.y||a.x-b.x):[];
      const productCode=combined?clean(left[0]?.s||''):text(code,description),detail=combined?clean(left.slice(1).map(i=>i.s).join(' ')):text(description,tax),taxCode=combined?clean(row.t.filter(i=>Math.abs(i.x-tax.x)<4).map(i=>i.s).join(' ')):text(tax,qty);
      const value=h=>num(one(row.t.filter(i=>isNum(i.s)&&Math.abs(i.x+i.w-h.x-h.w)<2),'a product quantity, price or amount').s);
      const quantity=value(qty),unitCost=value(price),net=value(amount);
      if(!productCode||!detail||quantity<=0||quantity>1e6||unitCost<0||unitCost>1e8||net<0||net>1e8||Math.abs(net*10000-Math.round(net*10000))>1e-5)fail('a product row is incomplete or invalid');
      if(!cents(r2(quantity*unitCost),r2(net)))fail('quantity times unit price differs from the line amount');
      printedQuantity+=quantity;
      if(/^NOTES?$/i.test(productCode)){
        if(unitCost!==0||net!==0)fail('a NOTE row has a nonzero charge');
        notes.push(detail);continue;
      }
      if(taxCode!=='GST')fail('a product tax code is unsupported');
      const gstAmount=r2(net*.1);
      out.push({...mk(productCode+' '+detail,quantity,unitCost,'EA'),amount:r2(net),gstAmount,grossAmount:r2(r2(net)+gstAmount),tax:'GST Applied'});
    }
    const printedCount=Number(clean(countHead.s).match(/\(\s*(\d+)\s*\)/)[1]);
    if(Math.abs(printedQuantity-printedCount)>1e-6)fail('the printed item quantity does not match the table');
    const calculatedNet=r2(out.reduce((n,i)=>n+i.amount,0)),expectedGst=r2(out.reduce((n,i)=>n+i.gstAmount,0)),calculatedTotal=r2(calculatedNet+expectedGst);
    const differences=[calculatedNet-subtotal,expectedGst-gst,calculatedTotal-total].map(v=>Math.abs(Math.round(v*100)));
    if(!out.length)fail('no product charges found');
    if(differences.some(Boolean)){
      const enabled=typeof $==='function'&&$('qrounding')?.checked;
      if(!enabled||differences.some(v=>v>10))fail('totals do not reconcile: product charges total $'+calculatedNet.toFixed(2)+' ex GST but printed subtotal is $'+subtotal.toFixed(2)+'; calculated line GST $'+expectedGst.toFixed(2)+', printed GST $'+gst.toFixed(2)+'. Use calculated totals only for differences up to $0.10');
      const audit='Small rounding discrepancy; PO calculated from printed quantities and unit prices. Supplier printed: ex GST $'+subtotal.toFixed(2)+', GST $'+gst.toFixed(2)+', total $'+total.toFixed(2)+'. PO calculated: ex GST $'+calculatedNet.toFixed(2)+', GST $'+expectedGst.toFixed(2)+', total $'+calculatedTotal.toFixed(2)+'. Total difference $'+r2(calculatedTotal-total).toFixed(2)+'. Supplier document unchanged.';
      out.forEach(i=>{i.roundingNote=audit;i.roundingExpectedCount=out.length;i.roundingOriginal={description:i.description,quantity:i.quantity,unitCost:i.unitCost};});log('CALCULATED TOTALS: '+audit);
    }
    for(const note of notes)log('Document note (excluded from PO lines): '+note);
    log('Read Nut & Bolt Factory: '+out.length+' product charge(s); $'+calculatedNet.toFixed(2)+' ex GST + $'+expectedGst.toFixed(2)+' GST = $'+calculatedTotal.toFixed(2)+'. Zero-valued NOTE rows excluded.');
    return out;
  }

  // Jobfit service invoices put descriptions before Qty and print GST separately.
  // Keep medical appointment context; never infer charges from payment details.
  function parseJobfit(all) {
    if (!all.some(i => /Jobfit Health Group/i.test(i.s))) return null;
    const fail = why => { throw new Error('Could not read the Jobfit invoice: ' + why + '. Review the PDF before continuing.'); };
    const clean = s => String(s).replace(/\s+/g, ' ').trim();
    if (new Set(all.map(i => i.page)).size !== 1) fail('multi-page Jobfit invoices need review');
    const one = (list, label) => { if (list.length !== 1) fail(label + ' is missing or duplicated'); return list[0]; };
    const unique = re => one(all.filter(i => re.test(clean(i.s))), 'a required heading');
    const desc = unique(/^Description$/i);
    const band = all.filter(i => Math.abs(i.y - desc.y) < 2);
    const head = re => one(band.filter(i => re.test(clean(i.s))), 'a table column');
    const code = head(/^Item no\.$/i), date = head(/^Appt\. Date$/i), site = head(/^Conducted At$/i), type = head(/^Charge type$/i);
    const qty = head(/^Qty$/i), rate = head(/^Unit price$/i), gst = head(/^GST$/i), total = head(/^Total$/i);
    const heads = [code, desc, date, site, type, qty, rate, gst, total];
    if (heads.some((h,n) => n && h.x <= heads[n-1].x)) fail('the table column order changed');
    const rows = [];
    for (const i of [...all].sort((a,b) => b.y-a.y || a.x-b.x)) {
      const row = rows.find(r => Math.abs(r.y-i.y) < 2);
      if (row) row.t.push(i); else rows.push({y:i.y,t:[i]});
    }
    rows.forEach(r => r.t.sort((a,b) => a.x-b.x));
    const field = re => {
      const label = unique(re);
      const values = all.filter(i => Math.abs(i.y-label.y)<2 && i.x > label.x+label.w+2);
      return clean(one(values, 'an invoice identity field').s);
    };
    const abn = field(/^ABN$/i).replace(/\s/g,'');
    if (abn !== '40083014340') fail('the supplier ABN changed');
    const applicant = field(/^Applicant:$/i), reference = field(/^Invoice number:$/i);
    if (!/^SIN\d+$/.test(reference) || !applicant || /[<>\x00-\x1f]/.test(applicant)) fail('the applicant or invoice reference is invalid');
    const moneyAt = label => {
      const values = all.filter(i => Math.abs(i.y-label.y)<2 && i.x > label.x+label.w+2 && isNum(i.s));
      const value = num(one(values, 'a printed total').s);
      if (!Number.isFinite(value) || value<0 || value>1e8) fail('a printed total is invalid');
      return value;
    };
    const subtotalHead = unique(/^SUB-TOTAL$/i), gstHead = unique(/^ADD: GST$/i), totalHead = one(all.filter(i => i.y < desc.y-2 && /^TOTAL$/i.test(clean(i.s))), 'invoice total');
    const subtotal = moneyAt(subtotalHead), taxTotal = moneyAt(gstHead), grandTotal = moneyAt(totalHead);
    if (!(desc.y > subtotalHead.y && subtotalHead.y > gstHead.y && gstHead.y > totalHead.y)) fail('the totals order changed');
    if (!cents(r2(subtotal+taxTotal),grandTotal)) fail('the printed totals do not reconcile');
    for (const re of [/^WEEKEND SURCHARGE$/i,/^OTHER CHARGES$/i,/^CREDIT CARD FEE$/i]) {
      if (moneyAt(unique(re)) !== 0) fail('additional charges require review');
    }
    if (!cents(moneyAt(unique(/^TOTAL AMOUNT DUE INCLUDING CREDIT CARD FEE$/i)),grandTotal)) fail('the amount due differs from the invoice total');
    const chargeRows = rows.filter(r => r.y < desc.y-2 && r.y > subtotalHead.y+2);
    const out=[];
    for (const row of chargeRows) {
      if (row.t.some(i => /^(WEEKEND SURCHARGE|OTHER CHARGES)$/i.test(clean(i.s)))) continue;
      const cell = (left,right) => clean(row.t.filter(i => i.x>=left.x-2 && i.x<right.x-2).map(i=>i.s).join(' '));
      const itemCode=cell(code,desc), description=cell(desc,date), appointment=cell(date,site), location=cell(site,type), chargeType=cell(type,qty);
      const value = h => {
        const tokens=row.t.filter(i=>isNum(i.s)&&Math.abs(i.x+(i.w||0)-h.x-h.w)<3);
        return num(one(tokens,'a charge value').s);
      };
      const quantity=value(qty), unitCost=value(rate), gstAmount=value(gst), amount=value(total);
      if (!itemCode || !description || !/^\d{2}\/\d{2}\/\d{4}$/.test(appointment) || !location || !chargeType) fail('a charge description or appointment is incomplete');
      if (!(quantity>0 && quantity<=1e6 && unitCost>=0 && unitCost<=1e8 && amount>=0 && amount<=1e8 && gstAmount>=0)) fail('a charge value is invalid');
      if (!cents(r2(quantity*unitCost),amount)) fail('quantity times unit price differs from the printed charge');
      if (!cents(r2(amount*.1),gstAmount)) fail('a charge GST amount differs from 10%');
      out.push({...mk(`${itemCode} - ${description} - ${applicant} - ${appointment} - ${location} (${chargeType})`,quantity,unitCost,'EA'),
        amount,gstAmount,grossAmount:r2(amount+gstAmount),tax:'GST Applied',supplierRef:reference});
    }
    if (!out.length || !cents(r2(out.reduce((n,i)=>n+i.amount,0)),subtotal) || !cents(r2(out.reduce((n,i)=>n+i.gstAmount,0)),taxTotal)) fail('the charge lines do not reconcile to subtotal and GST');
    log('Read Jobfit service charges, retaining applicant and appointment details. Charges reconcile to subtotal, GST and total; AI is not required.');
    return out;
  }

  // Mainfreight consignment measurements are not billable quantities. Charges
  // sit in a separate right-hand dollar column beside the quote conditions.
  function parseMainfreight(all) {
    if(!all.some(i=>/mainfreight/i.test(i.s))||!all.some(i=>/^consignment\s+quote$/i.test(i.s)))return null;
    const fail=why=>{throw new Error('Could not read the Mainfreight quote: '+why+'. Check the PDF or paste the charge lines manually.');};
    const clean=s=>s.replace(/\s+/g,' ').trim(),out=[];
    for(const page of [...new Set(all.map(i=>i.page))]){
      const its=all.filter(i=>i.page===page),exclusive=its.filter(i=>/^total\s+exclusive$/i.test(clean(i.s)));
      if(!exclusive.length)continue;
      if(exclusive.length!==1)fail('Total Exclusive is duplicated');
      const readMoney=label=>{
        const symbols=its.filter(i=>Math.abs(i.y-label.y)<2&&i.x>label.x&&i.s==='$');
        if(symbols.length!==1)fail('a charge currency column is missing or duplicated');
        const values=its.filter(i=>Math.abs(i.y-label.y)<2&&i.x>symbols[0].x&&isNum(i.s));
        if(values.length!==1)fail('a charge amount is missing or duplicated');
        const value=num(values[0].s);if(value<0)fail('negative charges require review');
        return {value,x:symbols[0].x};
      };
      const subtotal=readMoney(exclusive[0]);
      const unique=re=>{const found=its.filter(i=>re.test(clean(i.s)));if(found.length!==1)fail('a charge or total is missing or duplicated');return found[0];};
      const gstHead=unique(/^gst\s*\(10(?:\.0+)?%\)$/i),totalHead=unique(/^total\s+inclusive$/i),freight=unique(/^freight$/i);
      const gst=readMoney(gstHead).value,total=readMoney(totalHead).value;
      if(subtotal.value<=0||!cents(r2(subtotal.value*.1),gst)||!cents(r2(subtotal.value+gst),total))fail('subtotal, GST and inclusive total do not reconcile');
      if(!(freight.y>exclusive[0].y&&exclusive[0].y>gstHead.y&&gstHead.y>totalHead.y))fail('the charge and total order is unrecognised');
      const dollars=its.filter(i=>i.s==='$'&&Math.abs(i.x-subtotal.x)<3&&i.y<=freight.y+2&&i.y>exclusive[0].y+2).sort((a,b)=>b.y-a.y);
      const lines=[];
      for(const dollar of dollars){
        const labelParts=its.filter(i=>Math.abs(i.y-dollar.y)<2&&i.x>=subtotal.x-150&&i.x<dollar.x).sort((a,b)=>a.x-b.x);
        const description=clean(labelParts.map(i=>i.s).join(' '));
        if(!description)fail('a charge amount has no description');
        const {value}=readMoney({x:Math.min(...labelParts.map(i=>i.x)),y:dollar.y});
        lines.push({...mk(description,1,value,'EA'),amount:value,tax:'GST Applied'});
      }
      if(!lines.length||!cents(r2(lines.reduce((s,i)=>s+i.amount,0)),subtotal.value))fail('charge amounts do not match Total Exclusive');
      const fuel=lines.filter(i=>/^faf\b/i.test(i.description));
      for(const line of fuel){
        const percent=line.description.match(/^faf\s*\((\d+(?:\.\d+)?)%\)$/i);
        const bases=lines.filter(i=>/^freight$/i.test(i.description));
        if(!percent||bases.length!==1||!cents(r2(bases[0].amount*num(percent[1])/100),line.amount))fail('fuel adjustment does not match the printed freight percentage');
      }
      const lineTax=r2(lines.reduce((s,i)=>s+r2(i.amount*.1),0));
      if(cents(lineTax,gst))out.push(...lines);
      else{
        const description='Mainfreight - '+lines.map(i=>i.description+' ($'+i.amount.toFixed(2)+' ex GST)').join('; ');
        out.push({...mk(description,1,subtotal.value,'EA'),amount:subtotal.value,gstAmount:gst,grossAmount:total,tax:'GST Applied'});
        log('Mainfreight: per-charge GST rounding differs from the printed GST. Kept the full charge breakdown in one PO line to match the quoted subtotal and inclusive total exactly.');
      }
    }
    if(!out.length)fail('the freight charge summary was not found');
    log('Read Mainfreight freight charges separately from consignment weights, volumes and dimensions. Charges reconcile to Total Exclusive, GST and Total Inclusive.');
    return out;
  }

  // Officeworks separates ordered/supplied quantities and prints unpriced
  // bundle contents followed by an explicit '(for ... parent code)' reference.
  // Its % marker identifies taxable charges; inclusive headings alone do not.
  function parseOfficeworks(all) {
    if(!all.some(i=>/officeworks/i.test(i.s)))return null;
    const fail=why=>{throw new Error('Could not read the Officeworks invoice: '+why+'. Check the PDF or paste the charge lines manually.');};
    const clean=s=>s.replace(/\s+/g,' ').trim(),out=[];
    for(const page of [...new Set(all.map(i=>i.page))]){
      const its=all.filter(i=>i.page===page),descHeads=its.filter(i=>/^description$/i.test(clean(i.s)));
      if(!descHeads.length)continue;
      if(descHeads.length!==1)fail('the description heading is duplicated');
      const desc=descHeads[0],band=its.filter(i=>Math.abs(i.y-desc.y)<3);
      const head=re=>{const f=band.filter(i=>re.test(clean(i.s)));if(f.length!==1)fail('a charge heading is missing or duplicated');return f[0];};
      const code=head(/^product\s+code$/i),rate=head(/^unit\s+price$/i),amount=head(/^total\s+amount$/i);
      const quantities=band.filter(i=>/^quantity$/i.test(clean(i.s))).sort((a,b)=>a.x-b.x);
      if(quantities.length!==2)fail('ordered and supplied quantities are missing or duplicated');
      const [ordered,supplied]=quantities;
      for(const [h,re] of [[ordered,/^ordered$/i],[supplied,/^supplied$/i]]){
        if(!its.some(i=>Math.abs(i.x-h.x)<5&&i.y<h.y&&h.y-i.y<18&&re.test(clean(i.s))))fail('the quantity subheadings are ambiguous');
      }
      if(!(code.x<desc.x&&desc.x<ordered.x&&ordered.x<supplied.x&&supplied.x<rate.x&&rate.x<amount.x))fail('the column order is unrecognised');
      const gstHeads=its.filter(i=>i.y<desc.y&&/^total\s+gst$/i.test(clean(i.s)));
      const totals=its.filter(i=>i.y<desc.y-20&&/^total\s+amount$/i.test(clean(i.s)));
      if(gstHeads.length!==1||totals.length!==1)fail('invoice totals are missing or duplicated');
      const footerValues=h=>its.filter(i=>Math.abs(i.y-h.y)<3&&i.x>=amount.x&&isNum(i.s));
      const totalValues=footerValues(totals[0]),gstValues=footerValues(gstHeads[0]);
      if(totalValues.length!==1||gstValues.length>1)fail('invoice totals are unreadable or duplicated');
      const total=num(totalValues[0].s),gst=gstValues.length?num(gstValues[0].s):0;
      if(total<=0||gst<0)fail('invoice totals are invalid');
      const rows=[],top=desc.y-18;
      its.filter(i=>i.y<top&&i.y>gstHeads[0].y+3).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{
        const row=rows.find(r=>Math.abs(r.y-i.y)<3);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      const fields=['code','desc','ordered','supplied','rate','amount'];
      const bounds=[(code.x+desc.x)/2,ordered.x-5,supplied.x-4,rate.x-8,amount.x-8];
      const lines=[],parents=new Map();let pending=null;
      for(const row of rows){
        row.t.sort((a,b)=>a.x-b.x);
        const cells=Object.fromEntries(fields.map(k=>[k,[]]));
        row.t.forEach(i=>{let n=0;while(n<bounds.length&&i.x>=bounds[n])n++;cells[fields[n]].push(i.s);});
        const text=k=>clean(cells[k].join(' '));
        if(!text('code')&&!cells.ordered.length&&!cells.supplied.length&&!cells.rate.length&&!cells.amount.length){
          if(!pending||!/^\(for\s+.+\)$/i.test(text('desc')))fail('a bundle reference has no unpriced component');
          const matches=[...parents.entries()].filter(([key])=>text('desc').endsWith(' '+key+')'));
          if(matches.length!==1)fail('a bundle component has no unique charged parent');
          matches[0][1].description+=' (includes '+pending.quantity+' x '+pending.code+' '+pending.description+')';
          pending=null;continue;
        }
        if(pending)fail('an unpriced component has no explicit parent reference');
        if(!text('code')||!text('desc')||!['ordered','supplied'].every(k=>cells[k].length===1&&isNum(cells[k][0])))fail('a product or quantity is missing or ambiguous');
        const quantity=num(text('supplied')),requested=num(text('ordered'));
        if(quantity<=0||requested<quantity)fail('the supplied quantity is invalid or requires back-order review');
        if(/\*\*/.test(text('code')+' '+text('desc')))fail('back-ordered items require review');
        if(!cells.rate.length&&!cells.amount.length){pending={code:text('code'),description:text('desc'),quantity};continue;}
        if(!['rate','amount'].every(k=>cells[k].length===1&&isNum(cells[k][0])))fail('a product price or amount is missing or ambiguous');
        const price=num(text('rate')),gross=num(text('amount')),taxable=/%/.test(text('code')+' '+text('desc'));
        if(price<0||gross<0||!cents(r2(quantity*price),gross))fail('supplied quantity times price does not match a product amount');
        const net=taxable?r2(gross/1.1):gross,tax=taxable?r2(gross-net):0;
        const key=text('code').replace(/%/g,'').trim();
        if(parents.has(key))fail('a charged product code is duplicated');
        const line={...mk(key+' '+text('desc').replace(/%/g,'').trim(),quantity,net/quantity,'EA'),amount:net,grossAmount:gross,gstAmount:tax,tax:taxable?'GST Applied':'No GST Applied'};
        parents.set(key,line);lines.push(line);
      }
      if(pending)fail('an unpriced component has no explicit parent reference');
      const sum=k=>r2(lines.reduce((s,i)=>s+i[k],0));
      if(!lines.length||!cents(sum('grossAmount'),total)||!cents(sum('gstAmount'),gst)||!cents(r2(sum('amount')+gst),total))fail('charged products and taxable markers do not reconcile to invoice total and GST');
      if(!cents(r2(lines.reduce((s,i)=>s+(i.tax==='GST Applied'?r2(i.amount*.1):0),0)),gst))fail('per-line GST rounding requires review');
      out.push(...lines);
    }
    if(!out.length)fail('the product table was not found');
    log('Read Officeworks supplied quantities and charged products. Kept explicitly linked bundle contents in the parent description. Used taxable markers and printed GST; reconciled invoice total.');
    return out;
  }

  // K1 prints a GST-inclusive invoice total without per-charge tax amounts.
  // If splitting its net/tax creates a cent mismatch, retain all printed detail
  // in one invoice charge instead of inventing a tax allocation across jobs.
  function parseK1Invoice(all) {
    if(!all.some(i=>/^k1\s+auto\s+motors$/i.test(i.s)))return null;
    const fail=why=>{throw new Error('Could not read the K1 invoice: '+why+'. Check the PDF or paste the charge lines manually.');};
    const clean=s=>s.replace(/\s+/g,' ').trim();
    const lines=[];let printedTotal=null;
    for(const page of [...new Set(all.map(i=>i.page))]){
      const its=all.filter(i=>i.page===page),heads=its.filter(i=>/^description$/i.test(clean(i.s)));
      if(!heads.length)continue;
      if(heads.length!==1)fail('the description heading is duplicated');
      const hDesc=heads[0],band=its.filter(i=>Math.abs(i.y-hDesc.y)<3);
      const head=re=>{const found=band.filter(i=>re.test(clean(i.s)));if(found.length!==1)fail('a column heading is missing or duplicated');return found[0];};
      const hQty=head(/^qty$/i),hRate=head(/^rate$/i),hAmount=head(/^amount$/i);
      if(!(hDesc.x<hQty.x&&hQty.x<hRate.x&&hRate.x<hAmount.x))fail('the charge column order is unrecognised');
      const totalHeads=its.filter(i=>/^total\s+inc(?:l(?:uding)?)?\.?\s+gst$/i.test(clean(i.s)));
      if(totalHeads.length!==1||printedTotal!==null)fail('the GST-inclusive total is missing or duplicated');
      const totalHead=totalHeads[0];
      const amounts=its.filter(i=>Math.abs(i.y-totalHead.y)<3&&i.x>totalHead.x&&(isNum(i.s)));
      if(amounts.length!==1)fail('the GST-inclusive total is unreadable');
      printedTotal=num(amounts[0].s);
      if(printedTotal<=0)fail('the total is not positive');
      const rows=[];
      its.filter(i=>i.y<hDesc.y-3&&i.y>totalHead.y+3).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{
        const row=rows.find(r=>Math.abs(r.y-i.y)<3);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      const bounds=[hQty.x-8,hRate.x-8,hAmount.x-8],fields=['desc','qty','rate','amount'];
      let current=null;
      for(const row of rows){
        // The template's unused rows contain dash placeholders, not charges.
        if(row.t.every(i=>/^[-–—]+$/.test(clean(i.s))))continue;
        const cells=Object.fromEntries(fields.map(k=>[k,[]]));
        row.t.sort((a,b)=>a.x-b.x).forEach(i=>{let n=0;while(n<bounds.length&&i.x>=bounds[n])n++;cells[fields[n]].push(i.s);});
        const text=k=>clean(cells[k].join(' '));
        if(!['qty','rate','amount'].some(k=>cells[k].length)){
          if(!current||!text('desc'))fail('an incomplete charge row was found');
          current.description+=' '+text('desc');continue;
        }
        if(!text('desc')||!['qty','rate','amount'].every(k=>cells[k].length===1&&isNum(cells[k][0])))fail('a charge quantity, rate or amount is missing or ambiguous');
        const quantity=num(text('qty')),unitCost=num(text('rate')),amount=num(text('amount'));
        if(quantity<=0||unitCost<0||amount<0||!cents(r2(quantity*unitCost),amount))fail('quantity times rate does not match a charge amount');
        current={...mk(text('desc'),quantity,unitCost,'EA'),amount};lines.push(current);
      }
    }
    if(!lines.length||printedTotal===null||!cents(r2(lines.reduce((s,i)=>s+i.amount,0)),printedTotal))fail('charge amounts do not match the GST-inclusive total');
    const net=r2(printedTotal/1.1),tax=r2(printedTotal-net);
    const converted=lines.map(i=>{
      const amount=r2(i.amount/1.1);
      return {...i,unitCost:amount/i.quantity,amount,grossAmount:i.amount,gstAmount:r2(i.amount-amount),tax:'GST Applied'};
    });
    const sum=k=>r2(converted.reduce((s,i)=>s+i[k],0));
    const perLineTax=r2(converted.reduce((s,i)=>s+r2(i.amount*0.1),0));
    if(cents(sum('amount'),net)&&cents(sum('gstAmount'),tax)&&cents(perLineTax,tax)){
      log('Read K1 invoice charges and converted GST-inclusive prices to ex GST. Excluded empty template rows; subtotal plus GST matches the printed total.');
      return converted;
    }
    const description='K1 Auto Motors - '+lines.map(i=>i.quantity+' x '+i.description+' ($'+i.unitCost.toFixed(2)+' each incl GST)').join('; ');
    log('K1 invoice: separate ex-GST charges would create a cent-rounding mismatch. Combined into one invoice charge, retaining each printed job, quantity and GST-inclusive rate in its description. Ex GST $'+net.toFixed(2)+' + GST $'+tax.toFixed(2)+' = $'+printedTotal.toFixed(2)+'.');
    return [{...mk(description,1,net,'EA'),amount:net,grossAmount:printedTotal,gstAmount:tax,tax:'GST Applied'}];
  }

  // Capral tax invoices have staggered S/O Item, Quantity, Value and Line Total
  // headings. Value includes $/UOM, while item sequence is not a quantity.
  function parseCapralInvoice(all) {
    if (!all.some(i=>/^capral\s+limited$/i.test(i.s)) || !all.some(i=>/^tax\s+invoice$/i.test(i.s))) return null;
    const fail=why=>{throw new Error('Could not read the Capral invoice: '+why+'. Check the PDF or paste the charge lines manually.');};
    const out=[],clean=s=>s.replace(/\s+/g,' ').trim();
    for(const page of [...new Set(all.map(i=>i.page))]){
      const its=all.filter(i=>i.page===page);
      const qtyHeads=its.filter(i=>/^quantity$/i.test(clean(i.s)));
      if(!qtyHeads.length)continue;
      if(qtyHeads.length!==1)fail('the quantity heading is duplicated');
      const hQty=qtyHeads[0],band=its.filter(i=>Math.abs(i.y-hQty.y)<12);
      const head=re=>{const found=band.filter(i=>re.test(clean(i.s)));if(found.length!==1)fail('a column heading is missing or duplicated');return found[0];};
      const hItem=head(/^item$/i),hDesc=head(/^product\s+description$/i),hRate=head(/^value$/i),hAmount=head(/^line\s+total$/i);
      if(!(hItem.x<hQty.x&&hQty.x<hDesc.x&&hDesc.x<hRate.x&&hRate.x<hAmount.x))fail('the column order is unrecognised');
      const money=re=>{
        const labels=its.filter(i=>re.test(clean(i.s)));
        if(labels.length!==1)fail('an invoice total is missing or duplicated');
        const values=its.filter(i=>Math.abs(i.y-labels[0].y)<3&&i.x>=hAmount.x&&isNum(i.s));
        if(values.length!==1)fail('an invoice total is unreadable or duplicated');
        return {value:num(values[0].s),y:labels[0].y};
      };
      const subtotal=money(/^sub\s*total\s*\(aud\)$/i),gst=money(/^total\s*gst\s*\(aud\)$/i),total=money(/^invoice\s*total\s*\(aud\)$/i);
      if(!cents(r2(subtotal.value*0.1),gst.value)||!cents(r2(subtotal.value+gst.value),total.value))fail('subtotal, GST and invoice total do not reconcile');
      const rows=[],top=Math.min(...band.map(i=>i.y))-3;
      its.filter(i=>i.y<top&&i.y>subtotal.y+3).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{
        const row=rows.find(r=>Math.abs(r.y-i.y)<3);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      const bounds=[hQty.x-10,hQty.x+(hQty.w||35)+5,hRate.x-12,hAmount.x-8];
      const fields=['sequence','qty','desc','rate','amount'],lines=[],seen=new Set();
      let current=null,lastY=top;
      const canonical=u=>/^(ea|each)$/i.test(u)?'EA':/^(m|lm|l\/m)$/i.test(u)?'LM':/^(m2|m²|sqm)$/i.test(u)?'M2':u.toUpperCase();
      for(const row of rows){
        if(row.t.some(i=>/^(security\s+alert|terms\s+of\s+payment:|how\s+to\s+pay)$/i.test(clean(i.s))))break;
        row.t.sort((a,b)=>a.x-b.x);
        const cells=Object.fromEntries(fields.map(k=>[k,[]]));
        row.t.forEach(i=>{let n=0;while(n<bounds.length&&i.x>=bounds[n])n++;cells[fields[n]].push(i.s);});
        const text=k=>clean(cells[k].join(' '));
        if(!['sequence','qty','rate','amount'].some(k=>cells[k].length)){
          if(!current||!text('desc')||lastY-row.y>24)fail('a wrapped description has no charge');
          current.description+=' '+text('desc');lastY=row.y;continue;
        }
        const q=text('qty').match(/^([\d,]+(?:\.\d+)?)\s*([a-z²\/]+)$/i);
        const rate=text('rate').match(/^(\$?[\d,]+(?:\.\d+)?)\s*\$?\s*\/\s*([a-z²\/]+)$/i);
        if(cells.sequence.length!==1||!/^\d+$/.test(text('sequence'))||seen.has(text('sequence')))fail('an item sequence is missing or duplicated');
        seen.add(text('sequence'));
        if(!q||!rate||!isUom(q[2])||!isUom(rate[2])||canonical(q[2])!==canonical(rate[2]))fail('a quantity, rate or unit is missing or ambiguous');
        if(cells.amount.length!==1||!isNum(text('amount'))||!text('desc'))fail('a description or line amount is unreadable');
        const quantity=num(q[1]),unitCost=num(rate[1]),amount=num(text('amount'));
        if(quantity<=0||unitCost<0||amount<0||!cents(r2(quantity*unitCost),amount))fail('quantity times rate does not match a line amount');
        current={...mk(text('desc'),quantity,unitCost,canonical(q[2])),amount};
        lines.push(current);lastY=row.y;
      }
      if(!lines.length||!cents(r2(lines.reduce((s,i)=>s+i.amount,0)),subtotal.value))fail('charge amounts do not match the subtotal');
      out.push(...lines);
    }
    if(!out.length)fail('the invoice charge table was not found');
    log('Read Capral tax invoice quantities, Value / UOM and Line Total. Excluded item sequences, security notices and payment details. Charges reconcile to subtotal, GST and invoice total.');
    return out;
  }

  // Velocity service orders list parts inside each job, labour only in the job
  // summary, and shop supplies only in the billed totals on a separate page.
  function parseVelocityService(all) {
    if (!all.some(i => /^velocity\s+truck\s+centres$/i.test(i.s))) return null;
    const fail = why => { throw new Error('Could not read the Velocity service order: '+why+'. Check the PDF or paste the charge lines manually.'); };
    const clean = s => s.replace(/\s+/g,' ').trim();
    const pages = [...new Set(all.map(i => i.page))].map(page => {
      const rows=[];
      all.filter(i => i.page===page).sort((a,b) => b.y-a.y || a.x-b.x).forEach(i => {
        const row=rows.find(r => Math.abs(r.y-i.y)<3);
        if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      rows.forEach(r => r.t.sort((a,b) => a.x-b.x));
      return {page,rows};
    });
    const summaryPages=pages.filter(p => p.rows.some(r => r.t.some(i => /^billed$/i.test(clean(i.s)))) &&
      p.rows.some(r => r.t.some(i => /^shop\s+supplies$/i.test(clean(i.s)))));
    if(summaryPages.length!==1)fail('the billed totals page is missing or duplicated');
    const summary=summaryPages[0];
    const billed=summary.rows.flatMap(r => r.t).filter(i => /^billed$/i.test(clean(i.s)));
    if(billed.length!==1)fail('the Billed column is ambiguous');
    const readTotal = re => {
      const found=summary.rows.flatMap(r => r.t).filter(i => re.test(clean(i.s)) && i.x < billed[0].x);
      if(found.length!==1)fail('a billed total is missing or duplicated');
      const amounts=summary.rows.flatMap(r => r.t).filter(i => Math.abs(i.y-found[0].y)<3 && i.x>billed[0].x-25 && isNum(i.s));
      if(amounts.length!==1)fail('a billed total is unreadable or duplicated');
      return num(amounts[0].s);
    };
    const billedTotals={parts:readTotal(/^parts$/i),labor:readTotal(/^labor$/i),misc:readTotal(/^misc$/i),sublet:readTotal(/^sublet$/i)};
    const shop=readTotal(/^shop\s+supplies$/i),miscSupplies=readTotal(/^misc\s+supplies$/i);
    const subtotal=readTotal(/^subtotal$/i),gst=readTotal(/^gst$/i),total=readTotal(/^total$/i);
    const prepay=readTotal(/^prepay$/i),due=readTotal(/^total\s+due$/i);
    if(!cents(r2(Object.values(billedTotals).reduce((s,v)=>s+v,0)+shop+miscSupplies),subtotal) ||
      !cents(r2(subtotal*0.1),gst) || !cents(r2(subtotal+gst),total) || !cents(r2(total-prepay),due)) fail('billed categories, subtotal, GST or total due do not reconcile');
    const out=[],sums={parts:0,labor:0,misc:0,sublet:0};
    let job=null,table=null,jobLines=[],lastPart=null,aggregateCount=0;
    const jobs=new Set();
    const categoryValues = row => {
      const values={};
      for(const key of ['prepay','parts','labor','misc','sublet']){
        const matches=row.t.map(i=>clean(i.s).match(new RegExp('^'+key+':\\s*(\\$?[\\d,]+(?:\\.\\d+)?)$','i'))).filter(Boolean);
        if(matches.length!==1)fail('a job summary category is missing or duplicated');
        values[key]=num(matches[0][1]);
      }
      const amount=row.t.filter(i=>isNum(i.s)).pop();
      if(!amount)fail('a job total is unreadable');
      values.total=num(amount.s);
      if(!cents(r2(values.parts+values.labor+values.misc+values.sublet),values.total))fail('a job total does not reconcile');
      return values;
    };
    for(const p of pages.filter(p=>p.page<summary.page))for(const row of p.rows){
      const jobToken=row.t.find(i=>/^job\s*#\d+\b/i.test(clean(i.s)));
      if(jobToken){
        if(table || jobLines.length)fail('a job has no closing summary');
        const id=clean(jobToken.s).match(/^job\s*#(\d+)\b/i)[1];
        if(jobs.has(id))fail('a job number is duplicated');
        jobs.add(id);job=id;lastPart=null;
      }
      const header=res=>row.t.find(i=>res.test(clean(i.s)));
      if(header(/^qty$/i)&&header(/^item$/i)&&header(/^description$/i)&&header(/^unit\s+price$/i)&&header(/^extd\s+price$/i)){
        if(!job)fail('a parts table has no job number');
        table={qty:header(/^qty$/i),code:header(/^item$/i),desc:header(/^description$/i),price:header(/^unit\s+price$/i),amount:header(/^extd\s+price$/i)};
        continue;
      }
      if(row.t.some(i=>/^parts:\s*\$/i.test(clean(i.s)))){
        const values=categoryValues(row);
        if(row.t.some(i=>/^sold\s+operations\s+totals$/i.test(clean(i.s)))){
          aggregateCount++;
          if(table||jobLines.length||!Object.keys(sums).every(k=>cents(r2(sums[k]),values[k])))fail('sold operations totals do not match the jobs');
          continue;
        }
        if(!job||!table||!jobLines.length)fail('a job summary has no parts table');
        // Misc rows (e.g. grease and environmental levy) already appear in the
        // table. Never add that summary value again. Sublet needs its own layout.
        if(values.sublet!==0)fail('nonzero sublet charges require review');
        if(!cents(r2(jobLines.reduce((s,i)=>s+i.amount,0)),r2(values.parts+values.misc)))fail('parts and levies do not match their job summary');
        if(values.labor){const line=mk('Job '+job+' - Labour',1,values.labor,'EA');line.amount=values.labor;out.push(line);}
        Object.keys(sums).forEach(k=>{sums[k]+=values[k];});
        jobLines=[];table=null;lastPart=null;
        continue;
      }
      if(!table)continue;
      if(row.t.every(i=>/^page\s+\d+\s+of\s+\d+$/i.test(clean(i.s))))continue;
      const cells={qty:[],code:[],desc:[],price:[],amount:[]};
      const bounds=[table.code.x-8,table.desc.x-8,table.price.x-15,table.amount.x-8];
      const fields=['qty','code','desc','price','amount'];
      row.t.forEach(i=>{let n=0;while(n<bounds.length&&i.x>=bounds[n])n++;cells[fields[n]].push(i.s);});
      const text=k=>clean(cells[k].join(' '));
      if(!cells.qty.length&&!cells.price.length&&!cells.amount.length){
        if(!lastPart||!text('desc')||cells.code.length)fail('an incomplete parts row was found');
        lastPart.description+=' '+text('desc');continue;
      }
      if(!['qty','price','amount'].every(k=>cells[k].length===1&&isNum(cells[k][0]))||!text('code')||!text('desc'))fail('a parts quantity, price or description is missing or ambiguous');
      const quantity=num(text('qty')),price=num(text('price')),amount=num(text('amount'));
      if(quantity<=0||price<0||amount<0||!cents(r2(quantity*price),amount))fail('quantity times unit price does not match a parts amount');
      lastPart={...mk(text('code')+' - Job '+job+' - '+text('desc'),quantity,price,'EA'),amount};
      out.push(lastPart);jobLines.push(lastPart);
    }
    if(table||jobLines.length||!jobs.size||aggregateCount!==1)fail('the job tables or sold operations totals are incomplete');
    if(!Object.keys(sums).every(k=>cents(r2(sums[k]),billedTotals[k])))fail('job categories do not match the billed totals');
    for(const [label,amount] of [['Shop supplies',shop],['Misc supplies',miscSupplies]]){
      if(amount){const line=mk(label,1,amount,'EA');line.amount=amount;out.push(line);}
    }
    if(!cents(r2(out.reduce((s,i)=>s+i.amount,0)),subtotal))fail('the imported charges do not match the billed subtotal');
    log('Read Velocity service order parts, levies, job labour and billed supplies. Excluded job subtotals, payment amounts and terms. Charges reconcile to subtotal, GST and total.');
    return out;
  }

  // East Coast Apprenticeships invoices include wrapped worker/period/item
  // columns and supporting timesheets. Only the invoice charge table is billed.
  function parseEastCoast(all) {
    if (!all.some(i => /east\s+coast\s+apprenticeships/i.test(i.s))) return null;
    const fail = why => { throw new Error('Could not read the East Coast invoice: ' + why + '. Check the PDF or paste the invoice charge lines manually.'); };
    const out = [];
    const clean = s => s.replace(/\s+/g, ' ').trim();
    for (const page of [...new Set(all.map(i => i.page))]) {
      const rows = [];
      all.filter(i => i.page === page).sort((a,b) => b.y-a.y || a.x-b.x).forEach(i => {
        const row = rows.find(r => Math.abs(r.y-i.y) < 3);
        if (row) row.t.push(i); else rows.push({y:i.y,t:[i]});
      });
      rows.forEach(r => r.t.sort((a,b) => a.x-b.x));
      const hdr = rows.find(r => [/^contractor\s+name$/i, /^period$/i, /^item$/i, /^qty$/i, /^rate$/i]
        .every(re => r.t.some(i => re.test(clean(i.s)))));
      if (!hdr) continue; // Supporting timesheets have no invoice charge headings.
      const heading = re => {
        const found = hdr.t.filter(i => re.test(clean(i.s)));
        if (found.length !== 1) fail('an invoice column is missing or duplicated');
        return found[0];
      };
      const h = {
        worker:heading(/^contractor\s+name$/i), period:heading(/^period$/i),
        position:heading(/^position$/i), po:heading(/^number$/i),
        item:heading(/^item$/i), qty:heading(/^qty$/i), rate:heading(/^rate$/i),
      };
      const amountHeads = rows.filter(r => Math.abs(r.y-hdr.y) < 22).flatMap(r => r.t)
        .filter(i => i.x > h.rate.x && /^amount\s*\(ex(?:\s+gst\))?$/i.test(clean(i.s)));
      if (amountHeads.length !== 1) fail('the ex-GST amount heading is missing or duplicated');
      h.amount = amountHeads[0];
      if (!/gst\)/i.test(h.amount.s) && !hdr.t.some(i => i.x > h.rate.x && /^gst\)$/i.test(clean(i.s)))) fail('amounts are not labelled ex GST');
      const keys = ['worker','period','position','po','item','qty','rate','amount'];
      if (!keys.every((key,n) => !n || h[keys[n-1]].x < h[key].x)) fail('the column order is unrecognised');
      const bounds = [h.period.x-4,h.position.x-4,h.po.x-4,h.item.x-4,
        h.qty.x-12,(h.qty.x+h.rate.x)/2,(h.rate.x+h.amount.x)/2];
      const subtotalRows = rows.filter(r => r.y < hdr.y && r.t.some(i => /^subtotal:$/i.test(clean(i.s))));
      if (subtotalRows.length !== 1) fail('the subtotal is missing or duplicated');
      const bottom = subtotalRows[0];
      const footer = re => {
        const found = rows.filter(r => r.y <= bottom.y+3 && r.t.some(i => re.test(clean(i.s))));
        if (found.length !== 1) fail('an invoice total is missing or duplicated');
        const values = found[0].t.filter(i => i.x > h.rate.x && isNum(i.s));
        if (values.length !== 1) fail('an invoice total is unreadable or duplicated');
        return num(values[0].s);
      };
      const subtotal = footer(/^subtotal:$/i), gst = footer(/^gst\s*-\s*10(?:\.0+)?%:$/i), total = footer(/^total:$/i);
      if (!cents(r2(subtotal * 0.1),gst) || !cents(r2(subtotal+gst),total)) fail('subtotal, GST and total do not reconcile');
      const blocks = [];
      let current = null;
      for (const row of rows.filter(r => r.y < hdr.y-3 && r.y > bottom.y+3)) {
        const cells = Object.fromEntries(keys.map(key => [key,[]]));
        row.t.forEach(i => {
          let n = 0; while (n < bounds.length && i.x >= bounds[n]) n++;
          cells[keys[n]].push(i.s);
        });
        const numeric = ['qty','rate','amount'].some(key => cells[key].length);
        if (numeric) {
          if (!['qty','rate','amount'].every(key => cells[key].length === 1 && isNum(cells[key][0]))) fail('a charge quantity, rate or amount is missing or ambiguous');
          current = {cells,quantity:num(cells.qty[0]),unitCost:num(cells.rate[0]),amount:num(cells.amount[0])};
          if (current.quantity <= 0 || current.unitCost < 0 || current.amount < 0 || !cents(r2(current.quantity*current.unitCost),current.amount)) fail('quantity times rate does not match a charge amount');
          blocks.push(current);
        } else {
          if (!current) fail('a wrapped description has no charge');
          for (const key of ['worker','period','position','po','item']) current.cells[key].push(...cells[key]);
        }
      }
      const lines = blocks.map(b => {
        const text = key => clean(b.cells[key].join(' '));
        if (!text('worker') || !/^\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}$/.test(text('period')) || !text('item')) fail('a worker, billing period or charge description is incomplete');
        const description = [text('worker'),text('period'),text('position'),text('po') ? 'PO '+text('po') : '',text('item')].filter(Boolean).join(' - ');
        const measure = /\b(hourly|hours?)\b/i.test(text('item')) ? 'HR' : /\ballowance\b/i.test(text('item')) ? 'EA' : '';
        return {...mk(description,b.quantity,b.unitCost,measure),amount:b.amount};
      });
      if (!lines.length || !cents(r2(lines.reduce((sum,line) => sum+line.amount,0)),subtotal)) fail('charge amounts do not match the subtotal');
      out.push(...lines);
    }
    if (!out.length) fail('the invoice charge table was not found');
    log('Read East Coast Apprenticeships invoice charges, retaining worker names and billing periods. Excluded supporting timesheets; ex-GST charges reconcile to subtotal, GST and total.');
    return out;
  }

  // Order acknowledgements use Value as a unit price, with a $/UOM suffix.
  // The item sequence and estimated delivery date have their own columns;
  // centred Description headings do not mark that column's left edge.
  function parseOrderAcknowledgement(all) {
    const out=[];
    const clean=(s)=>s.replace(/\s+/g,' ').trim();
    for (const page of [...new Set(all.map(i=>i.page))]) {
      const rows=[];
      all.filter(i=>i.page===page).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{
        const row=rows.find(r=>Math.abs(r.y-i.y)<3);
        if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      rows.forEach(r=>r.t.sort((a,b)=>a.x-b.x));
      const hdr=rows.find(r=>[/^item\s*#$/i,/^quantity(?:\s+ordered)?$/i,/^product\s+description$/i,/^line\s+total(?:\s*\(aud\))?$/i]
        .every(re=>r.t.some(i=>re.test(clean(i.s)))));
      if(!hdr)continue;
      const fail=why=>{throw new Error('Could not read the order acknowledgement safely: '+why+'. Check the PDF or paste the item lines manually.');};
      const unique=(items,re,label)=>{
        const matches=items.filter(i=>re.test(clean(i.s)));
        if(matches.length!==1)fail(label+' is missing or duplicated');
        return matches[0];
      };
      const h={item:unique(hdr.t,/^item\s*#$/i,'Item #'),qty:unique(hdr.t,/^quantity(?:\s+ordered)?$/i,'Quantity Ordered'),
        desc:unique(hdr.t,/^product\s+description$/i,'Product Description'),
        date:unique(hdr.t,/^estimated(?:\s+del\.?\s*date)?$/i,'Estimated Del. Date'),
        price:unique(hdr.t,/^value(?:\s*\(aud\))?$/i,'Value'),amount:unique(hdr.t,/^line\s+total(?:\s*\(aud\))?$/i,'Line Total')};
      if(!['item','qty','desc','date','price','amount'].every((key,index,list)=>!index||h[list[index-1]].x<h[key].x))fail('unrecognised column order');
      const band=rows.filter(r=>Math.abs(r.y-hdr.y)<16).flatMap(r=>r.t);
      if(!/ordered/i.test(h.qty.s)&&!band.some(i=>/^ordered$/i.test(clean(i.s))&&Math.abs(i.x-h.qty.x)<12))fail('Quantity is not labelled Ordered');
      if(!/date/i.test(h.date.s)&&!band.some(i=>/^del\.?\s*date$/i.test(clean(i.s))&&Math.abs(i.x-h.date.x)<12))fail('the delivery date heading is incomplete');
      const headerTokens=band.filter(i=>['ordered','del. date','(aud)'].includes(clean(i.s).toLowerCase()));
      const top=Math.min(hdr.y,...headerTokens.map(i=>i.y))-3;
      const subtotals=rows.filter(r=>r.y<top&&r.t.some(i=>/^sub\s*total\s*\(aud\)$/i.test(clean(i.s))));
      if(subtotals.length!==1)fail('the AUD subtotal is missing or duplicated');
      const bottom=subtotals[0];
      const footer=(re,label)=>{
        const found=rows.filter(r=>r.y<=bottom.y+3&&r.t.some(i=>re.test(clean(i.s))));
        if(found.length!==1)fail(label+' is missing or duplicated');
        const values=found[0].t.filter(i=>i.x>h.amount.x&&isNum(i.s));
        if(values.length!==1)fail(label+' is unreadable or duplicated');
        return num(values[0].s);
      };
      const subtotal=footer(/^sub\s*total\s*\(aud\)$/i,'Subtotal');
      const gst=footer(/^total\s*gst\s*\(aud\)$/i,'GST');
      const total=footer(/^invoice\s*total\s*\(aud\)$/i,'Invoice Total');
      if(!cents(r2(subtotal+gst),total))fail('subtotal plus GST does not match Invoice Total');
      const bounds=[(h.item.x+(h.item.w||0)+h.qty.x)/2,h.qty.x+(h.qty.w||0)+8,
        h.date.x-12,(h.date.x+(h.date.w||0)+h.price.x)/2,(h.price.x+(h.price.w||0)+h.amount.x)/2];
      const fields=['item','qty','desc','date','price','amount'];
      const canonical=u=>/^(ea|each)$/i.test(u)?'EA':/^(m|lm|l\/m)$/i.test(u)?'LM':/^(m2|m²|sqm)$/i.test(u)?'M2':u.toUpperCase();
      const lines=[],seen=new Set();
      let current=null;
      for(const row of rows.filter(r=>r.y<top&&r.y>bottom.y+3)) {
        const cells=Object.fromEntries(fields.map(key=>[key,[]]));
        row.t.forEach(i=>{
          let index=0;while(index<bounds.length&&i.x>=bounds[index])index++;
          cells[fields[index]].push(i.s);
        });
        const text=key=>clean(cells[key].join(' '));
        if(!['item','qty','price','amount'].some(key=>cells[key].length)) {
          if(!current||!text('desc')||cells.date.length)fail('an item row is incomplete');
          current.description+=' '+text('desc');continue;
        }
        if(cells.item.length!==1||!/^\d+$/.test(text('item'))||seen.has(text('item')))fail('the item sequence is missing or duplicated');
        seen.add(text('item'));
        const qty=text('qty').match(/^(-?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*([a-z²\/]+)$/i);
        const rate=text('price').match(/^(\$?-?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*\$?\s*\/\s*([a-z²\/]+)$/i);
        if(!qty||!rate||!isUom(qty[2])||!isUom(rate[2]))fail('Quantity Ordered or Value / UOM is missing or ambiguous');
        if(canonical(qty[2])!==canonical(rate[2]))fail('the ordered quantity and price use different units');
        if(cells.amount.length!==1||!isNum(text('amount'))||!text('desc'))fail('a line amount or description is missing or ambiguous');
        const quantity=num(qty[1]),unitCost=num(rate[1]),amount=num(text('amount'));
        if(quantity<=0||unitCost<0||amount<0||!cents(r2(quantity*unitCost),amount))fail('quantity times unit price does not match Line Total');
        current={...mk(text('desc'),quantity,unitCost,canonical(qty[2])),amount};
        lines.push(current);
      }
      if(!lines.length||!cents(r2(lines.reduce((sum,line)=>sum+line.amount,0)),subtotal))fail('item amounts do not match the AUD subtotal');
      out.push(...lines);
    }
    if(out.length)log('Read order acknowledgement using Quantity Ordered, Value / UOM and Line Total. Kept product descriptions and finish; excluded item numbers, delivery dates, GST and terms. Item totals reconcile to the AUD subtotal.');
    return out.length?out:null;
  }

  // Panel quotes can carry both a sheet count and a separately billed M²
  // quantity. Read Per before choosing a quantity, and bound wrapped text by
  // the next item row rather than the nearest numeric baseline.
  function parseAreaPriceTable(all) {
    const out = [];
    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    for (const page of [...new Set(all.map((i) => i.page))]) {
      const rows = [];
      all.filter((i) => i.page === page).sort((a,b) => b.y-a.y || a.x-b.x).forEach((i) => {
        const row = rows.find((r) => Math.abs(r.y-i.y) < 3);
        if (row) row.t.push(i); else rows.push({ y:i.y, t:[i] });
      });
      rows.forEach((r) => r.t.sort((a,b) => a.x-b.x));
      const hdr = rows.find((r) => [/^(qty|quantity)$/i, /^stock\s*code$/i, /^description$/i, /^(m²|m2|sqm)$/i, /^per$/i]
        .every((re) => r.t.some((i) => re.test(normalize(i.s)))));
      if (!hdr) continue;
      const fail = (why) => { throw new Error('Could not read the Quantity / M² / Per quotation safely: '+why+'. Check the PDF or paste the item lines manually.'); };
      const unique = (list, re, label) => {
        const matches = list.filter((i) => re.test(normalize(i.s)));
        if (matches.length !== 1) fail(label+' is missing or duplicated');
        return matches[0];
      };
      const h = {
        qty:unique(hdr.t,/^(qty|quantity)$/i,'Quantity'), code:unique(hdr.t,/^stock\s*code$/i,'Stock Code'),
        desc:unique(hdr.t,/^description$/i,'Description'), area:unique(hdr.t,/^(m²|m2|sqm)$/i,'M²'),
        unit:unique(hdr.t,/^per$/i,'Per'),
      };
      const band = rows.filter((r) => Math.abs(r.y-hdr.y) < 14).flatMap((r) => r.t);
      h.price=unique(band,/^(ex\s*gst\s+)?price$/i,'Price');
      h.amount=unique(band,/^(ex\s*gst\s+)?amount$/i,'Amount');
      for (const key of ['price','amount']) {
        if (!/^ex\s*gst\s/i.test(h[key].s) && !band.some((i) => /^ex\s*gst$/i.test(normalize(i.s)) && Math.abs(i.x-h[key].x) < 14)) fail(key+' is not labelled Ex GST');
      }
      if (!['qty','code','desc','area','price','unit','amount'].every((key,index,list) => !index || h[list[index-1]].x < h[key].x)) fail('unrecognised column order');
      const dataTop = Math.min(hdr.y,h.price.y,h.amount.y)-3;
      const subtotals=rows.filter((r) => r.y < dataTop && r.t.some((i) => /^sub\s*total\s*\(excluding\s*gst\):?$/i.test(normalize(i.s))));
      if (subtotals.length !== 1) fail('the ex-GST subtotal is missing or duplicated');
      const bottom=subtotals[0];
      const totalCells=bottom.t.filter((i) => i.x > h.unit.x && isNum(i.s));
      if (totalCells.length !== 1) fail('the ex-GST subtotal is unreadable');
      // Numeric columns are right aligned; the description takes the broad
      // middle area, including dimensions and numbers in wrapped paragraphs.
      const bounds=[(h.qty.x+h.code.x)/2, h.desc.x-2,
        h.area.x-(h.price.x-h.area.x)/2,
        (h.area.x+(h.area.w||0)+h.price.x)/2,
        (h.price.x+(h.price.w||0)+h.unit.x)/2,
        (h.unit.x+(h.unit.w||0)+h.amount.x)/2];
      const fields=['qty','code','desc','area','price','unit','amount'];
      const lines=[];
      let current=null;
      for (const row of rows.filter((r) => r.y < dataTop && r.y > bottom.y+3)) {
        const cells=Object.fromEntries(fields.map((key) => [key,[]]));
        row.t.forEach((i) => {
          let index=0;
          while (index < bounds.length && i.x >= bounds[index]) index++;
          cells[fields[index]].push(i.s);
        });
        const text=(key) => normalize(cells[key].join(' '));
        const number=(key,optional=false) => {
          if (optional && !cells[key].length) return null;
          if (cells[key].length !== 1 || !isNum(cells[key][0])) fail(key+' contains a missing, duplicated or invalid value');
          return num(cells[key][0]);
        };
        const numeric= ['qty','area','price','amount'].some((key) => cells[key].length);
        if (!numeric) {
          if (cells.code.length || cells.unit.length || !current || !text('desc')) fail('an item row is incomplete');
          current.description+=' '+text('desc');
          continue;
        }
        const quantity=number('qty'), area=number('area',true), price=number('price'), amount=number('amount');
        const per=text('unit');
        if (!text('code') || !text('desc') || cells.unit.length !== 1 || !per) fail('an item is missing its code, description or Per value');
        if (quantity <= 0 || price < 0 || amount < 0) fail('an item has an unsupported quantity or negative charge');
        const byArea=/^(m2|m²|sqm)$/i.test(per);
        if (byArea ? !(area > 0) : area !== null) fail('M² and Per do not identify a single billing quantity');
        if (!byArea && !/^(ea|each|box|half litre)$/i.test(per)) fail('unsupported Per value "'+per+'"');
        const billed=byArea?area:quantity;
        if (!near(billed*price,amount)) fail('the quantity and printed rate do not reconcile with the line amount');
        // Supplier rates/areas are rounded for display. Preserve the printed
        // amount at the actual billing quantity, retaining the quoted rate for
        // review. Six decimals avoids losing cents on large item quantities.
        const adjusted=!cents(r2(billed*price),amount);
        const unitCost=adjusted?+(amount/billed).toFixed(6):price;
        if (!cents(r2(billed*unitCost),amount)) fail('the printed amount cannot be represented at this quantity');
        current={...mk(text('code')+' '+text('desc'),billed,unitCost,byArea?'M2':/^box$/i.test(per)?'BOX':'EA'),
          amount, sourceQuantity:quantity, sourceUnitPrice:price, sourcePer:per, check:byArea||adjusted?'check':'ok'};
        lines.push(current);
      }
      if (!lines.length || !cents(r2(lines.reduce((sum,line) => sum+line.amount,0)),num(totalCells[0].s))) fail('the item amounts do not match the ex-GST subtotal');
      const footerAmount = (re, label) => {
        const found=rows.filter((r) => r.y < bottom.y && r.t.some((i) => re.test(normalize(i.s))));
        if (!found.length) return null;
        if (found.length !== 1) fail(label+' is duplicated');
        const values=found[0].t.filter((i) => i.x > h.unit.x && isNum(i.s));
        if (values.length !== 1) fail(label+' is unreadable');
        return num(values[0].s);
      };
      const printedGst=footerAmount(/^gst\s*total:?$/i,'GST Total');
      const printedTotal=footerAmount(/^total:$/i,'Total');
      if (printedGst !== null || printedTotal !== null) {
        if (printedGst === null || printedTotal === null || !cents(r2(num(totalCells[0].s)+printedGst),printedTotal)) fail('the subtotal, GST and inclusive total do not reconcile');
        const lineGst=r2(lines.reduce((sum,line) => sum+r2(line.amount*0.1),0));
        const subtotalGst=r2(num(totalCells[0].s)*0.1);
        if (!cents(printedGst,lineGst) && !cents(printedGst,subtotalGst)) log('Check GST: PDF lists $'+printedGst.toFixed(2)+'; standard 10% GST gives $'+subtotalGst.toFixed(2)+'. The ex-GST item amounts are preserved; check tax in Nexvia before submitting.');
      }
      for (const line of lines) {
        const notes=[];
        if (/^half litre$/i.test(line.sourcePer)) notes.push('per Half Litre');
        if (/^(m2|m²|sqm)$/i.test(line.sourcePer)) notes.push('sheet quantity '+line.sourceQuantity+'; billed '+line.quantity+' m²');
        if (line.unitCost !== line.sourceUnitPrice) notes.push('quoted $'+line.sourceUnitPrice.toFixed(2)+'/'+line.sourcePer+'; rate adjusted to printed amount');
        if (notes.length) line.description+=' ['+notes.join('; ')+']';
      }
      out.push(...lines);
    }
    if (out.length) log('Read Quantity / Stock Code / Description / M² / Ex GST Price / Per / Ex GST Amount columns. M²-priced items use their area; sheet counts remain in the description. Item amounts reconcile to the ex-GST subtotal. Check yellow area/rate adjustments against the PDF.');
    return out.length?out:null;
  }

  // Hire quotes offer alternative Daily / Weekly rates rather than an Amount
  // column. Pick a rate schedule only when it reconciles to Rental Total.
  function parseHireTable(all) {
    const out = [];
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const page of [...new Set(all.map((i) => i.page))]) {
      const rows = [];
      all.filter((i) => i.page === page).sort((a,b) => b.y-a.y || a.x-b.x).forEach((i) => {
        const row = rows.find((r) => Math.abs(r.y-i.y) < 3);
        if (row) row.t.push(i); else rows.push({ y:i.y, t:[i] });
      });
      rows.forEach((r) => r.t.sort((a,b) => a.x-b.x));
      const header = rows.find((r) => ['qty','rental no','description','daily','weekly','items']
        .every((name) => r.t.some((i) => normalize(i.s) === name)));
      if (!header) continue;
      const fail = (reason) => { throw new Error('Could not read the hire quotation safely: ' + reason + '. Check the quoted rental period and charges, or paste the item lines manually.'); };
      const h = Object.fromEntries(['qty','rental no','description','daily','weekly','items']
        .map((name) => [name, header.t.find((i) => normalize(i.s) === name)]));
      if (!(h.qty.x < h['rental no'].x && h['rental no'].x < h.description.x &&
        h.description.x < h.daily.x && h.daily.x < h.weekly.x && h.weekly.x < h.items.x)) fail('unrecognised column order');
      const rentalRow = rows.find((r) => r.y < header.y && r.t.some((i) => i.x >= h.daily.x && /^rental total:?$/i.test(i.s)));
      if (!rentalRow) fail('Rental Total is missing');
      const rentalHeading = rentalRow.t.find((i) => i.x >= h.daily.x && /^rental total:?$/i.test(i.s));
      // Contract terms can repeat Environmental Levy / Damage Waiver on the
      // same page. Financial summary labels align with Rental Total at right.
      const summaryRows = rows.filter((r) => r.y <= rentalRow.y+3);
      const summaryHeading = (i, re) => Math.abs(i.x-rentalHeading.x) < 24 && re.test(i.s);
      const summary = (re, label) => {
        const found = summaryRows.filter((r) => r.t.some((i) => summaryHeading(i,re)));
        if (found.length !== 1) fail(label + ' is missing or duplicated');
        const heading = found[0].t.find((i) => summaryHeading(i,re));
        const amounts = found[0].t.filter((i) => i.x > heading.x && isNum(i.s));
        if (amounts.length !== 1) fail(label + ' has an unreadable or duplicated amount');
        return num(amounts[0].s);
      };
      const totals = {
        rental:summary(/^rental total:?$/i,'Rental Total'),
        transport:summary(/^transport:?$/i,'Transport'),
        additional:summary(/^additional charges:?$/i,'Additional Charges'),
        environmental:summary(/^environmental levy:?$/i,'Environmental Levy'),
        waiver:summary(/^damage waiver:?$/i,'Damage Waiver'),
        gst:summary(/^gst:?$/i,'GST'), total:summary(/^total:?$/i,'Total'),
      };
      const centre = (i) => i.x+(i.w || i.s.length*5)/2;
      const limits = [(centre(h.qty)+centre(h['rental no']))/2,
        (centre(h['rental no'])+h.description.x)/2,
        (h.description.x+(h.description.w || 0)+h.daily.x)/2,
        (centre(h.daily)+centre(h.weekly))/2, (centre(h.weekly)+centre(h.items))/2];
      const fields = ['qty','code','description','daily','weekly','items'];
      const rentals = [], charges = [];
      let last;
      for (const row of rows.filter((r) => r.y < header.y-3 && r.y > rentalRow.y+3)) {
        const cells = Object.fromEntries(fields.map((key) => [key, []]));
        row.t.forEach((i) => {
          let index=0;
          while (index < limits.length && i.x >= limits[index]) index++;
          cells[fields[index]].push(i.s);
        });
        const text = (key) => cells[key].join(' ').trim();
        const number = (key) => {
          if (!cells[key].length) return NaN;
          if (cells[key].length !== 1 || !isNum(cells[key][0])) fail(key + ' contains multiple or invalid values');
          return num(cells[key][0]);
        };
        const quantity=number('qty'), daily=number('daily'), weekly=number('weekly'), amount=number('items');
        if (!Number.isFinite(quantity)) {
          if ([daily,weekly,amount].some(Number.isFinite)) fail('an item quantity is missing');
          if (last && text('description') && row.y > last.y-22) { last.description += ' ' + text('description'); continue; }
          if (row.t.length) fail('an item description has no quantity');
          continue;
        }
        const description = [text('code'),text('description')].filter(Boolean).join(' ').trim();
        if (!description || quantity <= 0) fail('an item has no description or a non-positive quantity');
        const item={description,quantity,daily,weekly,amount,y:row.y};
        if (Number.isFinite(amount)) {
          if (Number.isFinite(daily) || Number.isFinite(weekly)) fail('an item has both rental rates and an Items amount');
          // This layout does not label Items as a unit price or extended amount.
          // Quantities above one require review rather than guessing the basis.
          if (quantity !== 1) fail('the basis of a multiple-quantity Items charge is ambiguous');
          charges.push(item);
        } else {
          if (!Number.isFinite(daily) && !Number.isFinite(weekly)) fail('a rental rate is missing');
          rentals.push(item);
        }
        last=item;
      }
      if (!rentals.length) fail('no equipment rental lines were found');
      const sum = (list, amount) => r2(list.reduce((total,item) => total+amount(item),0));
      const dateCells = rentalRow.t.filter((i) => i.x < rentalHeading.x && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(i.s));
      const parseDate = (value) => {
        const [day,month,year] = value.split('/').map(Number);
        const stamp = Date.UTC(year,month-1,day), date = new Date(stamp);
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) return NaN;
        return stamp;
      };
      if (dateCells.length !== 2) fail('the quoted start/end dates are missing or duplicated');
      const days = (parseDate(dateCells[1].s)-parseDate(dateCells[0].s))/86400000;
      if (!Number.isInteger(days) || days <= 0) fail('the quoted rental dates are invalid or not in increasing order');
      const periods = { daily:days, weekly:days%7 === 0 ? days/7 : NaN };
      const schedules = ['daily','weekly'].filter((key) => Number.isFinite(periods[key]) &&
        rentals.every((item) => Number.isFinite(item[key])) &&
        cents(sum(rentals,(item) => r2(item.quantity*item[key]*periods[key])),totals.rental));
      if (!schedules.length || schedules.length > 1 && rentals.some((item) => !cents(item.daily*periods.daily,item.weekly*periods.weekly))) {
        fail('Daily / Weekly rates do not uniquely reconcile with Rental Total for the quoted dates');
      }
      const basis=schedules[0], count=periods[basis], periodName=basis==='weekly'?'week':'day';
      const lines=rentals.map((item) => {
        const rate=item[basis], periodPrice=+(rate*count).toFixed(4);
        const details=count > 1 ? ` (${count} ${periodName}s @ $${rate.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:4})}/${periodName}; ${dateCells[0].s} to ${dateCells[1].s})` : '';
        const line=mk(item.description+details,item.quantity,periodPrice,'EA');
        line.amount=r2(item.quantity*periodPrice);line.check='check';return line;
      });
      const chargeLines=charges.map((item) => ({...mk(item.description,1,item.amount,'EA'),amount:item.amount}));
      const isEnvironmental=(line) => /environmental\s+levy/i.test(line.description);
      const isWaiver=(line) => /damage\s+waiver/i.test(line.description);
      const isTransport=(line) => !/fuel\s+levy/i.test(line.description) && /^(delivery|pickup|pick up)\b/i.test(line.description);
      if (!cents(sum(chargeLines.filter(isTransport),(item)=>item.amount),totals.transport)) fail('Transport does not match the itemised charges');
      if (!cents(sum(chargeLines.filter((item)=>!isTransport(item)&&!isEnvironmental(item)&&!isWaiver(item)),(item)=>item.amount),totals.additional)) fail('Additional Charges do not match the itemised charges');
      for (const [label, amount, match] of [['Environmental Levy',totals.environmental,isEnvironmental],['Damage Waiver',totals.waiver,isWaiver]]) {
        const existing=chargeLines.filter(match);
        if (existing.length) { if (!cents(sum(existing,(item)=>item.amount),amount)) fail(label+' does not match the itemised charge'); }
        else if (amount) chargeLines.push({...mk(label,1,amount,'EA'),amount,check:'check'});
      }
      lines.push(...chargeLines);
      if (!cents(sum(lines,(item)=>item.amount),r2(totals.total-totals.gst))) fail('the item sum does not match Total less GST');
      out.push(...lines);
      log('Read hire quotation using '+basis+' rates reconciled to Rental Total for '+dateCells[0].s+' to '+dateCells[1].s+' ('+count+' '+periodName+(count===1?'':'s')+'). Equipment quantity is preserved; the unit price covers the quoted period. Included itemised charges and summary-only levies once.');
    }
    return out.length ? out : null;
  }

  // Some service invoices print per-charge GST beside a GST-inclusive Amount.
  // Use the printed tax, including zero, rather than applying a document-wide rate.
  function parseGstAmountTable(all) {
    const out = [];
    const end = (i) => i.x + (i.w || i.s.length * 5);
    for (const page of [...new Set(all.map((i) => i.page))]) {
      const rows = [];
      all.filter((i) => i.page === page).sort((a,b) => b.y-a.y || a.x-b.x).forEach((i) => {
        const row = rows.find((r) => Math.abs(r.y-i.y) < 3);
        if (row) row.t.push(i); else rows.push({y:i.y,t:[i]});
      });
      rows.forEach((r) => r.t.sort((a,b) => a.x-b.x));
      const hdr = rows.find((r) => ['description','gst','amount'].every((s) => r.t.some((i) => i.s.toLowerCase() === s)) &&
        !r.t.some((i) => /^(qty|quantity|rate|unit\s*(price|cost))$/i.test(i.s)));
      if (!hdr) continue;
      if (all.some((i) => i.page === page && Math.abs(i.y-hdr.y) < 12 && /^(qty|quantity|rate|price|unit\s*(price|cost))$/i.test(i.s))) continue;
      const desc = hdr.t.find((i) => /^description$/i.test(i.s));
      const gst = hdr.t.find((i) => /^gst$/i.test(i.s));
      const amount = hdr.t.find((i) => /^amount$/i.test(i.s));
      if (!(desc.x < gst.x && gst.x < amount.x)) continue;
      const fail = (why) => { throw new Error('Could not read the Description / GST / Amount invoice: '+why+'. Check the PDF or paste the lines manually.'); };
      const tol = Math.min(25, (end(amount)-end(gst))/3);
      const readMoney = (tokens, field) => {
        if (!tokens.length) return null;
        const value = tokens.map((i) => i.s).join('').replace(/\s/g,'');
        if (!isNum(value)) fail('the '+field+' value is missing or ambiguous');
        return num(value);
      };
      const printedTotals = rows.map((row,index) => {
        const text = row.t.map((i) => i.s).join(' ');
        if (!/^total\s+amount\b/i.test(text)) return null;
        const nearby = [text,...rows.slice(index+1,index+3).filter((r) => row.y-r.y < 18).map((r) => r.t.map((i) => i.s).join(' '))].join(' ');
        if (!/\b(?:incl(?:uding)?\.?|inc\.?)\s*gst\b/i.test(nearby) || /\bpaid\b/i.test(text)) return null;
        const values=row.t.filter((i) => Math.abs(end(i)-end(amount)) < tol && isNum(i.s));
        if (values.length !== 1) fail('the inclusive total is ambiguous');
        return num(values[0].s);
      }).filter((v) => v !== null);
      if (printedTotals.length !== 1) fail('a single GST-inclusive total could not be identified');
      let cur = null, lastY = hdr.y, pending = [], stopped = false;
      const lines=[];
      for (const row of rows.filter((r) => r.y < hdr.y-3)) {
        const text=row.t.map((i) => i.s).join(' ');
        if (/^(?:total\b|sub[\s-]*total\b|balance\b|receipt\b|payment\b|notes?\b|bank\b|bsb\b|account\b|the total price)/i.test(text)) {stopped=true;break;}
        const taxTokens=row.t.filter((i) => (isNum(i.s)||/^\$$/.test(i.s)) && Math.abs(end(i)-end(gst)) < tol);
        const amountTokens=row.t.filter((i) => (isNum(i.s)||/^\$$/.test(i.s)) && Math.abs(end(i)-end(amount)) < tol);
        const d=row.t.filter((i) => i.x >= desc.x-2 && end(i) < gst.x-tol).map((i) => i.s).join(' ').trim();
        if (taxTokens.length || amountTokens.length) {
          const tax=readMoney(taxTokens,'GST'), gross=readMoney(amountTokens,'Amount');
          if (tax === null || gross === null) fail('each charge needs both a GST and an Amount value');
          if (tax < 0 || gross < tax) fail('the printed GST does not fit the charge amount');
          const description=[...pending,d].filter(Boolean).join(' ');
          if (!description) fail('a charge has no description');
          const net=r2(gross-tax);
          if (tax && !cents(r2(net*0.1),tax)) fail('the printed GST is not a supported 10% charge');
          cur={...mk(description,1,net,'EA'),amount:net,gstAmount:tax,grossAmount:gross,tax:tax===0?'No GST Applied':'GST Applied',check:'check'};
          lines.push(cur);pending=[];lastY=row.y;
        } else if (d) {
          if (cur && lastY-row.y < 24) {cur.description+=' '+d;lastY=row.y;} else pending.push(d);
        }
      }
      if (pending.length || !lines.length || !stopped) fail('the charge table is incomplete');
      const sum=(key) => r2(lines.reduce((total,line) => total+line[key],0));
      if (!cents(sum('grossAmount'),printedTotals[0])) fail('the charges do not reconcile to the inclusive total');
      const totalGst=rows.map((row) => row.t.map((i) => i.s).join(' ')).filter((text) => /total price includes gst\s*:/i.test(text));
      for (const text of totalGst) {
        const match=text.match(/total price includes gst\s*:\s*(\$?[\d,]+\.\d{2})\s*$/i);
        if (!match || !cents(num(match[1]),sum('gstAmount'))) fail('the printed total GST does not match the charge GST');
      }
      out.push(...lines);
      log('Read Description / GST / Amount charges as quantity 1. Subtracted the printed GST from each inclusive amount; kept $0 GST charges unchanged. Excluded receipts, payments and balances. Check the lump-sum lines and tax choices.');
    }
    return out.length ? out : null;
  }

  // Service invoices may print only Description / Amount, with no quantity/rate.
  // Each charge becomes one lump-sum line and is marked for review.
  function parseAmountTable(all) {
    const out = [];
    for (const pg of [...new Set(all.map((i) => i.page))]) {
      const rows = [];
      all.filter((i) => i.page === pg).sort((a, b) => b.y - a.y || a.x - b.x).forEach((i) => {
        const row = rows.find((r) => Math.abs(r.y - i.y) < 3);
        if (row) row.t.push(i); else rows.push({ y: i.y, t: [i] });
      });
      rows.forEach((r) => r.t.sort((a, b) => a.x - b.x));
      const hdr = rows.find((r) => r.t.some((i) => /^(item\s+|product\s+)?description$/i.test(i.s)) &&
        r.t.some((i) => /^amount$/i.test(i.s)) && !r.t.some((i) => /^(qty|quantity|unit\s*(price|rate)|rate|price)$/i.test(i.s)));
      if (!hdr) continue;
      if (all.some((i) => i.page === pg && Math.abs(i.y - hdr.y) < 12 &&
        /^(qty|quantity|total\s+quantity|unit\s*(price|rate|cost)|rate|price|cost)$/i.test(i.s))) continue;
      const amount = hdr.t.find((i) => /^amount$/i.test(i.s));
      const desc = hdr.t.find((i) => /description$/i.test(i.s));
      const code = hdr.t.find((i) => /^(code|tax|gst)$/i.test(i.s) && i.x > amount.x);
      if (desc.x >= amount.x) continue;
      let pending = [], cur = null, lastY = hdr.y;
      for (const row of rows.filter((r) => r.y < hdr.y - 3)) {
        const text = row.t.map((i) => i.s).join(' ');
        if (/^(gst[\s:.,]|tax[\s:]|sub[\s-]*total|total\b|balance\b|amount applied|please\s+eft|bank\b|bsb\b|account\b)/i.test(text)) break;
        const values = row.t.filter((i) => i.x >= amount.x - 70 && (!code || i.x < code.x - 8) && isNum(i.s));
        if (values.length > 1) throw new Error('Multiple amounts were read in a service-invoice row. Check the PDF before continuing.');
        const d = row.t.filter((i) => i.x < (values[0] ? values[0].x - 4 : amount.x - 70)).map((i) => i.s).join(' ').trim();
        if (values.length) {
          const description = [...pending, d].filter(Boolean).join(' ');
          if (!description) throw new Error('A service-invoice amount has no description. Check the PDF before continuing.');
          const it = mk(description, 1, num(values[0].s), 'EA');
          it.amount = it.unitCost; it.check = 'check';
          out.push(it); cur = it; pending = []; lastY = row.y;
        } else if (d) {
          if (cur && lastY - row.y < 22) { cur.description += ' ' + d; lastY = row.y; }
          else pending.push(d);
        }
      }
      if (pending.length) throw new Error('A service-invoice description has no readable amount. Check the PDF before continuing.');
    }
    return out.length ? out : null;
  }

  // Delivery invoices with stacked Total Quantity / Pricing Unit headings.
  // Items and the cut list below Product Description are not the priced quantity.
  function parseDeliveryTable(all) {
    const out = [];
    let recognised = false;
    const wOf = (i) => i.w || i.s.length * 5;
    const centre = (i) => i.x + wOf(i) / 2;
    const fail = () => { throw new Error('Could not read the delivery invoice item quantities and prices unambiguously. Check the PDF or paste the item lines manually.'); };
    for (const pg of [...new Set(all.map((i) => i.page))]) {
      const its = all.filter((i) => i.page === pg);
      const desc = its.find((i) => /^product\s+description$/i.test(i.s));
      if (!desc) continue;
      const band = its.filter((i) => Math.abs(i.y - desc.y) < 12);
      const find = (re) => band.find((i) => re.test(i.s));
      const qty = find(/^(total\s+)?quantity$/i), unit = find(/^pricing(\s+unit)?$/i);
      const rate = find(/^rate$/i), items = find(/^items$/i), delivery = find(/^delivery(\s+unit)?$/i);
      const total = band.filter((i) => /^total$/i.test(i.s) && rate && i.x > rate.x).sort((a, b) => b.x - a.x)[0];
      if (!qty || !unit || !rate || !items || !delivery || !total) continue;
      if (!(delivery.x < desc.x && desc.x < items.x && items.x < qty.x && qty.x < unit.x && unit.x < rate.x && rate.x < total.x)) continue;
      recognised = true;
      const top = Math.min(...[desc, qty, unit, rate, items, delivery, total].map((i) => i.y)) - 3;
      const stops = its.filter((i) => i.y < top && /^(sub[\s-]*total|invoice\s+total|gst\b|please refer to terms|discount adjustment)/i.test(i.s));
      const bottom = stops.length ? Math.max(...stops.map((i) => i.y)) + 3 : -Infinity;
      const rows = [];
      its.filter((i) => i.y < top && i.y > bottom).sort((a, b) => b.y - a.y || a.x - b.x).forEach((i) => {
        const row = rows.find((r) => Math.abs(r.y - i.y) < 3);
        if (row) row.t.push(i); else rows.push({ y: i.y, t: [i] });
      });
      const qtyLeft = (centre(items) + centre(qty)) / 2;
      const unitLeft = (centre(qty) + centre(unit)) / 2;
      const rateLeft = (centre(unit) + centre(rate)) / 2;
      const totalLeft = (centre(rate) + centre(total)) / 2;
      const descLeft = (centre(delivery) + desc.x) / 2;
      const inBand = (i, left, right) => centre(i) >= left && centre(i) < right;
      let pending = [], anchored = false;
      for (const row of rows) {
        row.t.sort((a, b) => a.x - b.x);
        const numberIn = (left, right) => {
          const values = row.t.filter((i) => inBand(i, left, right) && isNum(i.s));
          if (values.length > 1) fail();
          return values.length ? num(values[0].s) : NaN;
        };
        const q = numberIn(qtyLeft, unitLeft), price = numberIn(rateLeft, totalLeft), amount = numberIn(totalLeft, Infinity);
        const priced = !isNaN(q) || !isNaN(price) || !isNaN(amount);
        const counted = row.t.some((i) => inBand(i, items.x - 8, qtyLeft) && isNum(i.s));
        const description = row.t.filter((i) => i.x >= descLeft && i.x < items.x - 4 &&
          (!priced || (!isNum(i.s) && !isUom(i.s) &&
            !(pending.length && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(i.s))))).map((i) => i.s).join(' ').trim();
        if (!priced) {
          if (description) {
            if (counted) {
              if (anchored) fail();
              pending = [description]; anchored = true; // start the product, excluding preceding delivery-location text
            } else pending.push(description);
          }
          continue;
        }
        if ([q, price, amount].some(isNaN)) fail();
        if (counted && description) {
          if (anchored) fail();
          pending = [];
        }
        const text = [...pending, description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        pending = []; anchored = false;
        if (!q && !amount && !text) continue;
        if (!text) fail();
        const measure = row.t.filter((i) => inBand(i, unitLeft, rateLeft) && !isNum(i.s)).map((i) => i.s).join(' ');
        const it = mk(text, q, price, measure);
        it.amount = amount;
        it.check = near(q * price, amount) ? 'ok' : 'check';
        out.push(it);
      }
      if (pending.length) fail();
    }
    if (recognised && !out.length) fail();
    return out.length ? out : null;
  }

  // Lysaght-style quotes: "Line | Description | Qty | Length | ... | Sales Qty | RRP | Discount | Unit Pr | Line Amount"
  // Each item is a block; its price row holds Sales Qty, Unit Pr (e.g. 104.76LM) and Line Amount.
  // The Qty/Length columns are a cut list, so they're ignored.
  function parseLineBlocks(all) {
    const out = [];
    const pages = [...new Set(all.map((i) => i.page))];
    for (const pg of pages) {
      const its = all.filter((i) => i.page === pg);
      const sameY = (a, b) => Math.abs(a.y - b.y) < 2.5;
      const hLine = its.find((i) => /^line$/i.test(i.s) &&
        its.some((j) => sameY(i, j) && /^unit/i.test(j.s)) && its.some((j) => sameY(i, j) && /^amount$/i.test(j.s)));
      if (!hLine) continue;
      const hdr = its.filter((j) => sameY(j, hLine)).sort((a, b) => a.x - b.x);
      const hUnit = hdr.find((j) => /^unit/i.test(j.s));
      const hAmt = hdr.filter((j) => /^amount$/i.test(j.s)).pop();
      const hSales = hdr.find((j, k) => /^sales$/i.test(j.s) && hdr[k + 1] && /^qty$/i.test(hdr[k + 1].s));
      const rows = [];
      its.filter((i) => i.y < hLine.y - 2).sort((a, b) => b.y - a.y || a.x - b.x).forEach((i) => {
        const r = rows.find((r) => Math.abs(r.y - i.y) < 2.5);
        if (r) r.t.push(i); else rows.push({ y: i.y, t: [i] });
      });
      rows.forEach((r) => r.t.sort((a, b) => a.x - b.x));
      const txt = (r) => r.t.map((i) => i.s).join(' ');
      const isAnchor = (r) => r.t.length > 1 && /^\d{1,3}$/.test(r.t[0].s) && Math.abs(r.t[0].x - hLine.x) < 12 &&
        /^[A-Z0-9][A-Z0-9.\-\/]{2,}$/i.test(r.t[1].s);
      const isStop = (r) => /^(cutting|freight|gst|total|sub\s*total)/i.test(txt(r));
      let cur = null;
      const blocks = [];
      for (const r of rows) {
        if (isAnchor(r)) { cur = { anchor: r, rows: [r] }; blocks.push(cur); continue; }
        if (isStop(r)) { cur = null; continue; }
        if (cur) cur.rows.push(r);
      }
      for (const b of blocks) {
        let unit = NaN, uom = '', amount = NaN, qty = NaN;
        for (const r of b.rows) {
          const u = r.t.find((i) => Math.abs(i.x - hUnit.x) < 30 && /^-?[\d,]*\.?\d+[A-Za-z]{0,4}$/.test(i.s) && /\d/.test(i.s));
          const a = r.t.filter((i) => i.x >= hAmt.x - 70 && isNum(i.s)).pop();
          if (u && a) {
            const m = u.s.match(/^(-?[\d,]*\.?\d+)([A-Za-z]*)$/);
            unit = num(m[1]); uom = m[2] || '';
            amount = num(a.s);
            if (hSales) {
              const q = r.t.find((i) => Math.abs(i.x - hSales.x) < 30 && isNum(i.s));
              if (q) qty = num(q.s);
            }
            break;
          }
        }
        if (isNaN(amount)) continue;
        if (isNaN(qty) && unit) qty = +(amount / unit).toFixed(3);
        if (isNaN(unit) && qty) unit = +(amount / qty).toFixed(4);
        // description: product code + the "Comments:" text (without the delivery date)
        const code = b.anchor.t[1].s;
        const comment = [];
        let on = false;
        for (const r of b.rows) {
          for (const i of r.t) {
            if (/^comments:?$/i.test(i.s)) { on = true; continue; }
            if (on && /^dlvy$/i.test(i.s)) { on = false; break; }
            if (on) comment.push(i.s);
          }
          if (!on && comment.length) break;
        }
        const rest = b.anchor.t.slice(2).map((i) => i.s).join(' ');
        const d = (code + ' - ' + (comment.length ? comment.join(' ') : rest)).replace(/\s+/g, ' ').trim();
        const it = mk(d, qty, unit, uom);
        it.amount = amount;
        it.check = near(qty * unit, amount) ? 'ok' : 'check';
        out.push(it);
      }
      // extra charges with a value (freight, cutting)
      rows.filter((r) => /^(freight|cutting)/i.test(r.t[0].s)).forEach((r) => {
        const n = r.t.filter((i) => isNum(i.s)).pop();
        if (!n || !num(n.s)) return;
        const d = r.t.filter((i) => !isNum(i.s)).map((i) => i.s).join(' ');
        const it = mk(d.charAt(0) + d.slice(1).toLowerCase(), 1, num(n.s), 'EA');
        it.amount = num(n.s);
        out.push(it);
      });
    }
    return out.length ? out : null;
  }

  // Uses the column headings (Qty / Description / Unit Rate / Amount) so wrapped
  // descriptions stay with the right line. Works for Knotwood quotes and invoices.
  function parseColumnar(all) {
    const find = (re) => all.find((i) => re.test(i.s));
    const hQty = find(/^(qty|quantity)$/i);
    const hDesc = find(/^(description|item description|details)$/i);
    const hAmt = find(/^(amount|total|line total|ext\.? ?price|value)(\s*(aud|\(?ex\.?.*|\(?inc\.?.*))?$/i);
    const hRate = find(/^(unit\s*rate|rate|unit\s*price|price|unit\s*cost)$/i);
    if (!hQty || !hDesc || !hAmt) return null;
    const numMinX = hRate ? hRate.x - 40 : hDesc.x + 120;
    const out = [];
    const pages = [...new Set(all.map((i) => i.page))];
    for (const pg of pages) {
      if (pg < hQty.page) continue;
      const its = all.filter((i) => i.page === pg);
      const topY = pg === hQty.page ? hQty.y - 2 : Infinity;
      const stops = its.filter((i) => i.y < topY &&
        /^(sub\s*-?total|note:|notes|terms|delivery address|\*+\s*discount)/i.test(i.s)).map((i) => i.y);
      const botY = stops.length ? Math.max(...stops) + 2 : -Infinity;
      const band = its.filter((i) => i.y < topY && i.y > botY);
      const anchors = band.filter((i) => isNum(i.s) && Math.abs(i.x - hQty.x) < 25)
        .map((a) => ({ a, parts: [] }));
      if (!anchors.length) continue;
      band.forEach((i) => {
        if (anchors.some((r) => r.a === i)) return;
        let best = anchors[0];
        anchors.forEach((r) => { if (Math.abs(r.a.y - i.y) < Math.abs(best.a.y - i.y)) best = r; });
        if (Math.abs(best.a.y - i.y) < 24) best.parts.push(i);
      });
      anchors.forEach(({ a, parts }) => {
        const nums = parts.filter((i) => i.x >= numMinX && isNum(i.s)).sort((p, q) => p.x - q.x);
        const text = parts.filter((i) => !nums.includes(i) && !/^\d+(\.\d+)?%$/.test(i.s));
        const left = text.filter((i) => i.x < hDesc.x - 5).sort((p, q) => p.x - q.x);
        const desc = text.filter((i) => i.x >= hDesc.x - 5).sort((p, q) => (q.y - p.y) || (p.x - q.x));
        const qty = num(a.s);
        const amount = nums.length ? num(nums[nums.length - 1].s) : NaN;
        let rate = nums.length >= 2 ? num(nums[nums.length - 2].s) : NaN;
        if (isNaN(rate) && !isNaN(amount) && qty) rate = +(amount / qty).toFixed(4);
        const d = [...left, ...desc].map((i) => i.s).join(' ').replace(/\s+/g, ' ');
        const it = mk(d, qty, rate, '');
        it.amount = amount;
        it.check = near(qty * rate, amount) ? 'ok' : 'check';
        out.push(it);
      });
    }
    return out.length ? out.filter((i) => i.description && !isNaN(i.unitCost)) : null;
  }

  // General table quotes (e.g. Baker Packaging): one heading row with Qty / Price / Total columns
  // and one row per item. Each piece of text is put in the column whose heading sits above it.
  function parseTable(all) {
    const RE = {
      qty: /^(qty|quantity)(\s+(ordered|ord\.?|req(uired)?|supplied|shipped))?$/i,
      price: /^(unit\s*(price|rate|cost|pr\.?)|price|rate|each)(\s*\$)?(\s*\(?(ex|inc).*)?$/i,
      unit: /^(unit|uom|units|measure|u\/m)$/i,
      desc: /^(.*\/\s*)?(item\s*|product\s*|part\s*)?description$|^(ref(?:erence)?\s*(no\.?|number|#)\s+part\s+description|details|product)$/i,
      tax: /^(tax|gst|tax\s*code)$/i,
      code: /^(stock\s*code|item\s*code|product\s*code|part\s*(no\.?|number|#)|ref(?:erence)?\s*(no\.?|number|#)|code|sku|item)$/i,
      amount: /^((amount|total|line\s*total|ext\.?\s*(price|total)?|extended(\s*price)?|value|net|nett)(\s.*)?|\$|aud|\$\s*aud)$/i,
    };
    const stopRe = /^(sub\s*-?total|ex\.?\s*tax|total|tax:?|notes?:?|terms|payment|accepted|no\.?\s*of\s*items|sales order totals|prop:|tech:|account|bank)/i;
    const out = [];
    const pages = [...new Set(all.map((i) => i.page))];
    for (const pg of pages) {
      const rows = [];
      all.filter((i) => i.page === pg).sort((a, b) => b.y - a.y || a.x - b.x).forEach((i) => {
        const r = rows.find((r) => Math.abs(r.y - i.y) < 3);
        if (r) r.t.push(i); else rows.push({ y: i.y, t: [i] });
      });
      rows.forEach((r) => r.t.sort((a, b) => a.x - b.x));
      const hdr = rows.find((r) => r.t.some((i) => RE.qty.test(i.s)) &&
        r.t.some((i) => RE.amount.test(i.s) && !RE.price.test(i.s)));
      if (!hdr) continue;
      const cols = {};
      hdr.t.forEach((i) => {
        for (const k of ['qty', 'price', 'unit', 'desc', 'code', 'tax']) {
          if (!cols[k] && RE[k].test(i.s)) { cols[k] = i; return; }
        }
        if (RE.amount.test(i.s)) cols.amount = i;          // right-most "total" heading wins
      });
      if (!cols.amount) continue;
      let dataTop = hdr.y - 2;
      // Some quotes stack Unit / Price, Sub- / Total and TOTAL / (Excluding /
      // GST). Keep subtotal and freight separate from the final ex-GST total.
      const freight = hdr.t.find((i) => /^freight$/i.test(i.s));
      const headerBand = rows.filter((r) => Math.abs(r.y - hdr.y) < 12).flatMap((r) => r.t);
      const finalTotal = freight && headerBand.find((i) => /^total$/i.test(i.s) && i.x > freight.x);
      const excluding = finalTotal && headerBand.find((i) => /^\(?excluding$/i.test(i.s) && Math.abs(i.x - finalTotal.x) < 12);
      const gst = finalTotal && headerBand.find((i) => /^gst\)?$/i.test(i.s) && Math.abs(i.x - finalTotal.x) < 12);
      const freightTable = !!(freight && finalTotal && excluding && gst && cols.qty && cols.price &&
        cols.price.x < cols.amount.x && cols.amount.x < freight.x);
      if (freightTable) {
        cols.subtotal = cols.amount; cols.freight = freight; cols.amount = finalTotal;
        // Quantity and its UOM share one printed column (e.g. "20 EA").
        if (!cols.unit) cols.unit = { x: (cols.qty.x + (cols.qty.w || 0) + cols.price.x) / 2 - 6, w: 12 };
        dataTop = Math.min(hdr.y, finalTotal.y, excluding.y, gst.y) - 2;
      }
      const wOf = (i) => i.w || i.s.length * 5;
      // Some invoices label Quantity / Price / Amount but leave the wide
      // description column unlabelled. Give that left-hand area its own column
      // so dimensions, panel counts and numeric reference lists stay as text.
      if (!cols.desc && !cols.code) {
        const numericLeft = Math.min(...['qty', 'price', 'amount'].filter((k) => cols[k]).map((k) => cols[k].x));
        const leftText = rows.filter((r) => r.y < hdr.y - 2).flatMap((r) => r.t)
          .filter((i) => !isNum(i.s) && i.x + wOf(i) < numericLeft - 24);
        if (leftText.length) {
          const left = Math.min(...leftText.map((i) => i.x));
          if (numericLeft - left > 100) cols.desc = { x: left, w: numericLeft - left - 24 };
        }
      }
      const heads = Object.entries(cols).map(([k, h]) => ({ k, a: h.x, b: h.x + wOf(h) }));
      const NUMCOL = { qty: 1, price: 1, amount: 1, subtotal: 1, freight: 1 };
      const colOf = (i) => {
        const c = i.x + wOf(i) / 2;
        const numeric = isNum(i.s);
        let best = null, bd = Infinity;
        heads.forEach((h) => {
          if (!numeric && NUMCOL[h.k]) return;           // words never go in number columns
          const d = c < h.a ? h.a - c : c > h.b ? c - h.b : 0;
          if (d < bd) { bd = d; best = h.k; }
        });
        return best || 'desc';
      };
      let cur = null, lastY = hdr.y, pending = [];
      const appendPending = () => {
        if (cur && pending.length) cur.description += ' ' + pending.join(' ');
        pending = [];
      };
      for (const r of rows.filter((r) => r.y < dataTop)) {
        const f = {};
        r.t.forEach((i) => { const k = colOf(i); (f[k] = f[k] || []).push(i.s); });
        const get = (k) => (f[k] || []).join(' ').replace(/\s+/g, ' ').trim();
        const getNumber = (k) => {
          // Never join separate numeric cells: reference 32790 + qty 3.0
          // would otherwise become 327903 when num() removes whitespace.
          if ((f[k] || []).filter(isNum).length > 1) {
            throw new Error(`Multiple numbers were read in the PDF ${k} column. Check the layout or paste the item lines manually.`);
          }
          return num(get(k));
        };
        const qty = getNumber('qty'), amount = getNumber('amount');
        if (r.t.some((i) => stopRe.test(i.s)) && isNaN(qty)) break;   // reached the totals
        if (freightTable && ['qty', 'price', 'subtotal', 'freight', 'amount'].some((k) => (f[k] || []).length) &&
            (!Number.isFinite(qty) || !Number.isFinite(amount))) {
          throw new Error('The PDF freight table has a missing item quantity or total. Check the item columns before continuing.');
        }
        if (!isNaN(qty) && !isNaN(amount)) {
          if (!qty && !amount) continue;                 // empty "0  0" filler rows
          let price = getNumber('price');
          if (freightTable && !Number.isFinite(price)) throw new Error('The PDF freight table has a missing unit price. Check the item columns before continuing.');
          let q = qty;
          const inline = [get('code'), get('desc')].filter(Boolean).join(' ');
          // A price can be centred vertically in a multiline description.
          // Collect its leading paragraphs, and retain trailing paragraphs up
          // to the next row whose description and prices share a baseline.
          let d;
          if (inline) {
            if (cur) { appendPending(); d = inline; }
            else { d = [...pending, inline].join(' '); pending = []; }
          } else {
            d = pending.join(' ') || r.t.map((i) => i.s).join(' ');
            pending = [];
          }
          if (isNaN(price)) {
            const each = qty ? amount / qty : amount;
            if (qty && Math.abs(each * 100 - Math.round(each * 100)) < 1e-6) price = r2(each);
            else { price = amount; if (qty && qty !== 1) d = `${qty} x ${d}`; q = 1; }   // lump-sum line
          }
          const subtotal = freightTable ? getNumber('subtotal') : amount;
          const freightAmount = freightTable ? getNumber('freight') : 0;
          if (freightTable && (!Number.isFinite(subtotal) || !Number.isFinite(freightAmount) || !cents(r2(subtotal + freightAmount), amount))) {
            throw new Error('Could not reconcile the PDF subtotal, freight and ex-GST total. Check the item columns before continuing.');
          }
          const it = mk(d, q, price, get('unit'));
          it.amount = subtotal;
          it.check = near(q * price, subtotal) ? 'ok' : 'check';
          out.push(it);
          if (freightAmount) {
            const charge = mk('FREIGHT-' + (get('code') || out.length) + ' Freight for ' + d, 1, freightAmount, 'EA');
            charge.amount = freightAmount;
            out.push(charge);
          }
          cur = it; lastY = r.y;
        } else if (!isNaN(amount)) {
          break;                                          // a total with no item = end of table
        } else if (get('desc') && !get('qty')) {
          if (cur && !pending.length && lastY - r.y < 22) {
            cur.description += ' ' + get('desc');         // close wrapped line
            lastY = r.y;
          } else pending.push(get('desc'));               // leading/trailing paragraph
        }
      }
      appendPending();
    }
    return out.length ? out : null;
  }

  async function pdfToLines(file) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      const rows = {};
      tc.items.forEach((it) => {
        if (!it.str.trim()) return;
        const y = Math.round(it.transform[5] / 3) * 3;
        (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str.trim() });
      });
      Object.keys(rows).map(Number).sort((a, b) => b - a)
        .forEach((y) => out.push(rows[y].sort((a, b) => a.x - b.x).map((r) => r.s).join(' ')));
    }
    return out;
  }

  // ---------- NEXVIA GRID ----------
  function findHeader(text) {
    const cands = [...document.querySelectorAll('th, [role=columnheader], .tabulator-col, td, div, span')]
      .filter((e) => e.offsetParent && !(panel && panel.contains(e)) &&
        e.textContent.trim().toLowerCase().startsWith(text.toLowerCase()) &&
        e.textContent.trim().length < text.length + 15);
    const exact = cands.filter((e) => e.textContent.trim().toLowerCase() === text.toLowerCase());
    const pool = exact.length ? exact : cands;
    pool.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    const el = pool[0];
    return el ? (el.closest('th, [role=columnheader], .tabulator-col, td') || el) : null;
  }

  function gridRoot() {
    let el = findHeader(CFG.cols.description);
    while (el && !el.textContent.includes(CFG.addRowText)) el = el.parentElement;
    return el;
  }

  function getRows() {
    const root = gridRoot();
    if (!root) return [];
    for (const s of ['tbody tr', '.tabulator-row', '[role=row]']) {
      const r = [...root.querySelectorAll(s)].filter((row) =>
        row.offsetParent && !row.textContent.includes(CFG.addRowText) &&
        !row.querySelector('th') && row.children.length > 5);
      if (r.length) return r;
    }
    return [];
  }

  function cellIn(row, headerText) {
    const cells=[...row.querySelectorAll('td, .tabulator-cell, [role=gridcell]')];
    const grid=typeof kGrid==='function'?kGrid(row):null;
    const column=grid&&gridColumn(grid,headerText);
    if(column){
      // Resolve by the grid's field metadata before viewport coordinates. Hidden
      // and off-screen columns may have zero-width bounding rectangles.
      const direct=cells.filter(c=>c.getAttribute?.('data-field')===column.field);
      if(direct.length===1)return direct[0];
      const head=grid.thead&&(grid.thead[0]||grid.thead);
      const matches=head?[...head.querySelectorAll('th[data-field],[role=columnheader][data-field]')].filter(h=>h.getAttribute('data-field')===column.field):[];
      if(matches.length===1){
        const header=matches[0],siblings=[...(header.parentElement?.children||[])];
        if(siblings.length===cells.length&&siblings.every(h=>!h.colSpan||h.colSpan===1)){
          const index=siblings.indexOf(header);if(index>=0)return cells[index];
        }
      }
    }
    const h=findHeader(headerText);if(!h)return null;
    // Reading grid values must not move the user's viewport.
    const hr=h.getBoundingClientRect();if(hr.width<=0)return null;
    const x=hr.left+hr.width/2;
    return cells.find(c=>{const r=c.getBoundingClientRect();return r.right>r.left&&r.left<=x&&x<=r.right;})||null;
  }

  async function revealEditableColumn(row,headerText) {
    const grid=kGrid(row),column=grid&&gridColumn(grid,headerText);
    if(column?.hidden){
      if(typeof grid.showColumn!=='function')throw Error('Nexvia hides '+headerText+' and cannot reveal it for editing. No tax setting was assumed.');
      grid.showColumn(column.field);await sleep(100);
      log('Revealed Nexvia '+headerText+' column for editing.');
    }
  }

  function setNative(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) window.jQuery(el).trigger('change');
  }

  function fire(el) {
    ['mousedown', 'mouseup', 'click'].forEach((ev) => el.dispatchEvent(new MouseEvent(ev, { bubbles: true })));
  }

  // Kendo UI widget (Nexvia grid uses these for numbers / dropdowns)
  function widgetIn(cell) {
    if (!window.jQuery) return null;
    for (const el of cell.querySelectorAll('[data-role]')) {
      const jq = window.jQuery(el);
      const data = jq.data();
      let direct;
      try { direct = window.kendo && typeof window.kendo.widgetInstance === 'function' && window.kendo.widgetInstance(jq); }
      catch (_) { /* A grid redraw can destroy the previous editor. */ }
      const w = [direct, ...Object.values(data || {})].find((item) => item && item.options &&
        /^(DropDownList|ComboBox|AutoComplete|MultiColumnComboBox|NumericTextBox)$/i.test(item.options.name || ''));
      if (w) return w;
    }
    return null;
  }

  const normalizedText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  function dropdownDataItems(w) {
    const ds=w.dataSource,tf=w.options?.dataTextField,vf=w.options?.dataValueField;
    const out=[],visited=new Set(),identities=new Set();
    const read=(item,key)=>item&&key?(typeof item.get==='function'?item.get(key):item[key]):undefined;
    const walk=list=>{
      if(!list||typeof list==='string'||typeof list.length!=='number')return;
      for(const item of Array.from(list)){
        if(item==null||visited.has(item))continue;visited.add(item);
        const children=read(item,'items');
        if(children&&typeof children!=='string'&&typeof children.length==='number'){
          walk(children);continue;
        }
        const label=dropdownText(item,tf);if(!label)continue;
        const id=read(item,vf),key=id==null?null:JSON.stringify([String(id),normalizedText(label)]);
        if(key&&identities.has(key))continue;if(key)identities.add(key);
        out.push(item);
      }
    };
    // Use one current source, never a union of data/view/flatView. Kendo can
    // expose the same option as different objects without a dataValueField.
    // Distinct same-label options within the current source stay ambiguous.
    for(const name of ['view','flatView','data']){
      out.length=0;visited.clear();identities.clear();
      try{if(typeof ds?.[name]==='function')walk(ds[name]());}catch{}
      if(out.length)return out;
    }
    return out;
  }

  function dropdownText(item, field) {
    if (item == null) return '';
    const value = field && typeof item === 'object'
      ? (typeof item.get === 'function' ? item.get(field) : item[field])
      : (typeof item === 'object' ? '' : item);
    return value == null ? '' : String(value).trim();
  }

  // Search only lists belonging to this widget, including detached popups and
  // ARIA-controlled listboxes. Templates can show extra columns or clipped text.
  function dropdownOptions(w, match, text) {
    const t = normalizedText(text), tf = w.options?.dataTextField, vf = w.options?.dataValueField;
    const unwrap = (value) => value && (value[0] || value);
    const roots = new Set(), nodes = new Set();
    const addRoot = (value) => { const root = unwrap(value); if (root && root.querySelectorAll) roots.add(root); };
    [w.ul, w.list, w.popup?.element, w.listView?.element, w.listView?.content].forEach(addRoot);
    const sources = [unwrap(w.element), unwrap(w.wrapper)].filter(Boolean);
    for (const source of sources) {
      const controls = [source, ...(source.querySelectorAll?.('[aria-controls], [aria-owns]') || [])];
      for (const control of controls) {
        for (const attr of ['aria-controls', 'aria-owns']) {
          for (const id of (control.getAttribute?.(attr) || '').split(/\s+/).filter(Boolean)) {
            addRoot(document.getElementById?.(id));
          }
        }
      }
    }
    try { if (typeof w.items === 'function') Array.from(w.items() || []).forEach((node) => nodes.add(node)); }
    catch (_) { /* A custom listView can be between rendering passes. */ }
    const selector = '[role=option], li, tr[data-uid], tr.k-table-row';
    for (const root of roots) root.querySelectorAll(selector).forEach((node) => nodes.add(node));
    const candidates = [...new Set([...nodes].map((node) => node.closest?.(selector) || node))].filter(Boolean);
    const read = (item, field) => item == null || !field ? undefined : typeof item.get === 'function' ? item.get(field) : item[field];
    const info = candidates.map((node) => {
      let item;
      // Kendo renders grouped/virtual rows with an index into its flattened
      // view. This still works when a customised widget.items() is empty.
      try {
        const index = w.listView?.getElementIndex ? w.listView.getElementIndex(node) : node.getAttribute?.('data-offset-index');
        if (index != null && index !== '' && Number.isInteger(Number(index)) && Number(index) >= 0) {
          if (typeof w.listView?.dataItemByIndex === 'function') item = w.listView.dataItemByIndex(Number(index));
          else if (typeof w.dataSource?.flatView === 'function') item = w.dataSource.flatView()[Number(index)];
        }
      } catch (_) { /* The list may be refreshing while the popup opens. */ }
      try { if (!item && typeof w.dataItem === 'function' && window.jQuery) item = w.dataItem(window.jQuery(node)); }
      catch (_) { /* Some widget versions accept only numeric item indexes. */ }
      const uid = node.getAttribute?.('data-uid');
      if (!item && uid && typeof w.dataSource?.getByUid === 'function') item = w.dataSource.getByUid(uid);
      const expectedId = read(match, vf), itemId = read(item, vf);
      const hasId=value=>value!=null&&String(value).trim()!=='';
      const targetHasId=hasId(expectedId),itemHasId=hasId(itemId);
      const boundLabelMatches=item!=null&&normalizedText(dropdownText(item,tf))===t;
      const candidateUid=uid||item?.uid;
      const uidMatch=!!(match?.uid&&candidateUid===match.uid);
      // A same-label item with a different bound ID must never become eligible
      // through its label or UID. Prefer stable IDs over view-specific UIDs.
      let identityMatch;
      if(targetHasId&&itemHasId)identityMatch=String(itemId)===String(expectedId)&&boundLabelMatches;
      else if(targetHasId||match?.uid)identityMatch=uidMatch&&(!item||boundLabelMatches);
      else identityMatch=null;
      const labelMatch = [node.textContent, node.getAttribute?.('aria-label'), node.getAttribute?.('title')]
        .some((label) => label != null && normalizedText(label) === t);
      const visible = !node.getClientRects || node.getClientRects().length > 0;
      const disabled = node.getAttribute?.('aria-disabled') === 'true' ||
        node.getAttribute?.('role') === 'group' || node.classList?.contains('k-list-group-item') ||
        node.classList?.contains('k-disabled') || node.classList?.contains('k-state-disabled');
      return { node, item, visible, disabled, matches: identityMatch==null?labelMatch:identityMatch };
    });
    const matching = info.filter((entry) => entry.matches && entry.visible && !entry.disabled);
    // A template can expose both its option row and a nested option element.
    const unique = matching.filter((entry) => !matching.some((other) => other.node !== entry.node && other.node.contains?.(entry.node)));
    return { node: unique.length === 1 ? unique[0].node : null, info, roots: [...roots] };
  }

  function logDropdownDiagnostic(w, match, text, reason) {
    try {
      const found = dropdownOptions(w, match, text);
      const clip = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const vf = w.options?.dataValueField;
      const valueOf = (item) => item == null || !vf ? undefined : typeof item.get === 'function' ? item.get(vf) : item[vf];
      log('Breakdown dropdown diagnostic: ' + JSON.stringify({ version: '2.05', reason,
        wanted: clip(text), widget: w.options?.name, textField: w.options?.dataTextField, valueField: vf,
        target: { label: clip(dropdownText(match, w.options?.dataTextField)), id: clip(valueOf(match)), uid: clip(match?.uid) },
        roots: found.roots.slice(0, 8).map((root) => ({ tag: root.tagName, id: root.id, visible: !root.getClientRects || root.getClientRects().length > 0 })),
        optionCount: found.info.length,
        options: [...found.info].sort((a,b) => Number(b.matches)-Number(a.matches)).slice(0, 12).map((entry) => ({
          tag: entry.node.tagName, text: clip(entry.node.textContent), uid: clip(entry.node.getAttribute?.('data-uid')),
          boundLabel: clip(dropdownText(entry.item, w.options?.dataTextField)), id: clip(valueOf(entry.item)),
          visible: entry.visible, disabled: entry.disabled, matches: entry.matches,
        })),
      }));
    } catch (error) { log('Breakdown dropdown diagnostic could not finish: ' + error.message); }
  }

  async function selectByText(w, text, exact = false, expectedId = null) {
    const t = normalizedText(text);
    if (exact && typeof w.open === 'function') {
      if (typeof w.focus === 'function') w.focus();
      w.open();
      await sleep(Math.max(100, CFG.stepDelay));
    }
    const ds = w.dataSource;
    if (!w.options || !ds || typeof ds.data !== 'function') return false;
    const tf = w.options.dataTextField;
    const textOf = (d) => normalizedText(dropdownText(d, tf));
    const find = () => {
      const data = dropdownDataItems(w).filter((d) => textOf(d));
      const matches = data.filter((d) => textOf(d) === t && (expectedId==null || String(typeof d.get==='function'?d.get(w.options.dataValueField):d[w.options.dataValueField])===String(expectedId)));
      if (exact) return matches.length === 1 ? matches[0] : null;
      return matches[0] || data.find((d) => textOf(d).includes(t));
    };
    let match = find();
    if (!match && w.search) {              // server-filtered lists
      w.search(String(text));
      for (let i = 0; i < 25 && !match; i++) {
        await sleep(200);
        match = find();
      }
    }
    if (!match) { try { await ds.read(); } catch (e) {} match = find(); }
    if (!match) {
      if(exact)log('Breakdown options: '+JSON.stringify({wanted:text,expectedId,valueField:w.options?.dataValueField||null,available:dropdownDataItems(w).slice(0,40).map(d=>({label:dropdownText(d,tf),id:w.options?.dataValueField?(typeof d.get==='function'?d.get(w.options.dataValueField):d[w.options.dataValueField]):null}))}));
      return false;
    }
    if (exact) {
      // Use Kendo's real option-click path. A fabricated select event can run
      // Nexvia's handler before Kendo has selected/bound a data item, leaving
      // the handler reading .name from null even when the displayed text exists.
      const option = () => dropdownOptions(w, match, text).node;
      let node = option();
      if (!node && w.open) {
        if (typeof w.focus === 'function') w.focus();
        w.open(); await sleep(100); node = option();
      }
      for (let i = 0; i < 25 && !node; i++) {
        await sleep(200);
        match = find();
        if (!match) return false;
        node = option();
      }
      if (!node) {
        logDropdownDiagnostic(w, match, text, 'Matching option not rendered, not visible or ambiguous');
        throw new Error('The exact dropdown option is not ready. See the Breakdown dropdown diagnostic in the log. Finish or cancel the row in Nexvia, then compare again.');
      }
      fire(node);
      for (let i = 0; i < 25; i++) {
        const selected = typeof w.dataItem === 'function' ? w.dataItem() : null;
        const shown = typeof w.text === 'function' ? w.text() : dropdownText(selected, tf);
        const bound = typeof w.dataItem !== 'function' || (selected != null && normalizedText(dropdownText(selected, tf)) === t);
        const vf = w.options?.dataValueField;
        const expectedId = vf ? (typeof match.get === 'function' ? match.get(vf) : match[vf]) : undefined;
        const selectedId = selected && vf ? (typeof selected.get === 'function' ? selected.get(vf) : selected[vf]) : w.value?.();
        const sameId = expectedId == null || selectedId != null && String(selectedId) === String(expectedId);
        if (normalizedText(shown) === t && bound && sameId && (typeof w.value !== 'function' || String(w.value() ?? '').trim())) {
          if (w.close) w.close();
          return true;
        }
        await sleep(100);
      }
      logDropdownDiagnostic(w, match, text, 'Clicked option did not bind the expected selection');
      throw new Error('Nexvia did not bind the clicked Breakdown Type option. Finish or cancel the row and compare again.');
    }
    w.select((d) => d === match);
    w.trigger('change');
    if (w.close) w.close();
    return true;
  }

  async function editCell(row, headerText, value, expectedId = null) {
    try { return await editCellValue(row, headerText, value, expectedId); }
    catch (error) { throw new Error(`Could not set ${headerText}: ${error.message}`); }
  }

  async function editCellValue(row, headerText, value, expectedId = null) {
    if (value === '' || value == null) return true;
    row = liveRow(row);
    await revealEditableColumn(row,headerText);
    row = liveRow(row);
    let cell = cellIn(row, headerText);
    if (!cell) { log(`Column not found: ${headerText}`); return false; }
    cell.scrollIntoView({ block: 'nearest', inline: 'center' });
    const visible = (el) => el && (!el.getClientRects || el.getClientRects().length > 0);
    const editor = () => visibleEditor(cell);
    const activeWidget = () => {
      const w = widgetIn(cell);
      if (!w || !w.options || w.options.enable === false || w.options.enabled === false || w.options.readonly) return null;
      const source = w.element && (w.element[0] || w.element);
      if (source && (source.disabled || source.readOnly)) return null;
      const wrapper = w.wrapper && (w.wrapper[0] || w.wrapper);
      return editor() || visible(wrapper) ? w : null;
    };
    const grid = kGrid(row);
    const gridMode = grid && (typeof grid.options?.editable === 'object' ? grid.options.editable.mode : grid.options?.editable);
    const attempts = [
      () => {
        if (gridMode === false || gridMode === 'popup') return false;
        if (gridMode === 'inline' && grid.editRow) { grid.editRow(window.jQuery(row)); return true; }
        if (grid && grid.editCell) { grid.editCell(window.jQuery(cell)); return true; }
        return false;
      },
      () => { fire(cell); return true; },
      () => { cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; },
    ];
    // Existing PO cells can need the grid's edit command or a double click.
    // Reacquire cells when opening an editor causes Nexvia to redraw the row.
    for (const open of attempts) {
      if (editor() || activeWidget()) break;
      if (!open()) continue;
      for (let i = 0; i < 10; i++) {
        await sleep(100);
        row = liveRow(row);
        cell = cellIn(row, headerText);
        if (!cell) break;
        if (editor() || activeWidget()) break;
      }
      if (!cell) { log(`Column disappeared while editing: ${headerText}`); return false; }
    }
    const markedWidget = () => !!window.jQuery && [...cell.querySelectorAll('[data-role]')].some((el) =>
      /^(dropdownlist|combobox|autocomplete|multicolumncombobox|numerictextbox)$/i.test(el.getAttribute?.('data-role') || el.dataset?.role || ''));
    // Do not type a label into the underlying input before Nexvia has created
    // its widget/binding: the displayed text could otherwise leave its ID empty.
    for (let i = 0; i < 25 && markedWidget() && !activeWidget(); i++) {
      await sleep(100);
      row = liveRow(row); cell = cellIn(row, headerText);
      if (!cell) throw new Error('The editor disappeared during a grid redraw. Compare again.');
    }
    if (markedWidget() && !activeWidget()) throw new Error('The dropdown or numeric editor is not ready. Finish or cancel the row in Nexvia and compare again.');
    const commit = async () => {
      const ed = editor();
      if (ed && ed.blur) ed.blur();
      if (grid && gridMode !== 'inline' && gridMode !== 'popup' && grid.closeCell) grid.closeCell();
      await sleep(CFG.stepDelay);
    };
    const w = activeWidget();
    if (w) {
      const role = (w.options?.name || '').toLowerCase();
      if (/dropdown|combo|autocomplete|multicolumn/.test(role)) {
        const ok = await selectByText(w, value, headerText === CFG.cols.breakdown || headerText === CFG.cols.tax,expectedId);
        if (!ok) log(`No "${value}" option in ${headerText}`);
        if (ok) await commit();
        return ok;
      }
      if (w.value) {                       // NumericTextBox etc.
        w.value(value);
        // Notify native input bindings as well as the widget listeners.
        // A widget-only change can leave the row's required input empty.
        const source = w.element && (w.element[0] || w.element);
        if (source && /^(INPUT|TEXTAREA)$/.test(source.tagName)) setNative(source, String(value));
        const shown = editor();
        if (shown && shown !== source && !numberMatches(headerText, num(shown.value), Number(value))) {
          setNative(shown, String(value));
        }
        w.trigger('change');
        await commit();
        return true;
      }
    }

    const ed = editor();
    if (!ed) { log(`No editable control for ${headerText}. Open the row for editing in Nexvia and compare again.`); return false; }
    if (ed.tagName === 'SELECT') {
      const exact = [...ed.options].filter((o) => normalizedText(o.text) === normalizedText(value)&&(expectedId==null||String(o.value)===String(expectedId)));
      const opt = headerText === CFG.cols.breakdown || headerText === CFG.cols.tax ? (exact.length === 1 ? exact[0] : null) :
        exact[0] || [...ed.options].find((o) => normalizedText(o.text).includes(normalizedText(value)));
      if (!opt) { log(`No "${value}" option in ${headerText}`); return false; }
      ed.value = opt.value; ed.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if(expectedId!=null)throw Error('The Breakdown ID cannot be bound through a plain text editor. Open the Nexvia dropdown before retrying.');
      ed.focus();
      setNative(ed, String(value));
    }
    await commit();
    return true;
  }

  function liveRow(row) {
    if (row && row.isConnected !== false) return row;
    const uid = row && row.getAttribute('data-uid');
    const current = uid && rowEls().find((r) => r.getAttribute('data-uid') === uid);
    if (!current) throw new Error('Nexvia redrew the PO row and it could not be found again. Compare again.');
    return current;
  }

  function gridColumn(grid, title) {
    const columns = [];
    const walk = (cols) => cols.forEach((c) => { columns.push(c); if (c.columns) walk(c.columns); });
    walk(grid.columns || []);
    const clean = (text) => String(text || '').replace(/<[^>]*>/g, '').trim().toLowerCase();
    return columns.find((c) => c.field && clean(c.title) === title.toLowerCase()) ||
      columns.find((c) => c.field && clean(c.title).startsWith(title.toLowerCase()));
  }

  function visibleEditor(cell, editableOnly = true) {
    if (!cell) return null;
    return [...cell.querySelectorAll('input:not([type=checkbox]):not([type=hidden]), textarea, select')]
      .find((el) => (!el.getClientRects || el.getClientRects().length > 0) &&
        (!editableOnly || (!el.disabled && !el.readOnly))) || null;
  }

  function readNumber(row, headerText, saved = false) {
    const grid = kGrid(row);
    const column = grid && gridColumn(grid, headerText);
    const model = column && grid.dataItem(row);
    const bound = model && (model.get ? model.get(column.field) : model[column.field]);
    if (saved && model) return num(bound);
    const cell = cellIn(row, headerText);
    const input = visibleEditor(cell, false);
    // An empty live input is empty even when the model still has an old/default
    // quantity. Do not skip filling a required input because that model matches.
    if (input) return num(input.value);
    if (bound != null && !isNaN(num(bound))) return num(bound);
    const widget = cell && widgetIn(cell);
    if (widget && widget.value && !isNaN(num(widget.value()))) return num(widget.value());
    return num(cellText(row, headerText));
  }

  function numberMatches(header, actual, expected) {
    return Number.isFinite(actual) && Number.isFinite(expected) &&
      (header === CFG.cols.quantity ? Math.abs(actual - expected) < 0.000001 : cents(actual, expected));
  }

  async function setNumber(row, header, value) {
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${header}: ${value}`);
    if (numberMatches(header, readNumber(liveRow(row), header), value)) return;
    if (header === CFG.cols.amount) {
      // Give Nexvia time to calculate read-only totals after quantity/rate changes.
      for (let i = 0; i < 5; i++) {
        await sleep(100);
        if (numberMatches(header, readNumber(liveRow(row), header), value)) return;
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await editCell(liveRow(row), header, value))) throw new Error(`Could not edit ${header}. No price change was confirmed for this line.`);
      for (let i = 0; i < 5; i++) {
        if (numberMatches(header, readNumber(liveRow(row), header), value)) return;
        await sleep(100);
      }
    }
    throw new Error(`Could not set ${header}: Nexvia shows ${readNumber(liveRow(row), header)}; expected ${value}.`);
  }

  // Saving Amount can make Nexvia store Amount / Qty as an unrounded rate.
  // Accept that specific recalculation only when both quantities and amounts
  // match and the intended rate rounds to the same invoice amount.
  function poNumbersMatch(actual, expected) {
    if (!numberMatches(CFG.cols.quantity, actual.quantity, expected.quantity) ||
        !numberMatches(CFG.cols.amount, actual.amount, expected.amount) ||
        !Number.isFinite(actual.unitCost) || !Number.isFinite(expected.unitCost)) return false;
    if (numberMatches(CFG.cols.unitCost, actual.unitCost, expected.unitCost)) return true;
    if (!expected.quantity || !cents(r2(expected.quantity * expected.unitCost), expected.amount)) return false;
    const derived = actual.amount / actual.quantity;
    return Math.abs(actual.unitCost - derived) <= Math.max(1e-8, Math.abs(derived) * 1e-12);
  }

  async function verifyPoLine(identity, expected) {
    if (!identity) throw new Error('Could not identify the added PO line for verification.');
    let current;
    let actual;
    for (let i = 0; i < 10; i++) {
      current = resolvePoLine(identity);
      actual = current && {
        quantity: readNumber(current.row, CFG.cols.quantity, true),
        unitCost: readNumber(current.row, CFG.cols.unitCost, true),
        amount: readNumber(current.row, CFG.cols.amount, true),
      };
      if (actual && poNumbersMatch(actual, expected) &&
          (!expected.tax || normalizedText(current.tax) === normalizedText(expected.tax))) return current;
      await sleep(200);
    }
    const shown = actual ? `qty ${actual.quantity}, unit $${actual.unitCost}, amount $${actual.amount}${expected.tax ? ', Tax '+current.tax+' (wanted '+expected.tax+')' : ''}` : 'line not found';
    throw new Error(`Nexvia did not keep the expected values: ${shown}; wanted qty ${expected.quantity}, unit $${expected.unitCost}, amount $${expected.amount}. Review the line and compare again.`);
  }

  function kGrid(row) {
    if (!window.jQuery) return null;
    const g = window.jQuery(row).closest('[data-role=grid]');
    return g.length ? g.data('kendoGrid') : null;
  }

  function validationError() {
    const m = [...document.querySelectorAll('.k-invalid-msg, .k-tooltip-validation, [role=alert]')]
      .find((e) => e.offsetParent && !(panel && panel.contains(e)) && /required|invalid|select a/i.test(e.textContent));
    return m ? m.textContent.trim() : '';
  }

  function openRowEditors(row) {
    return row ? [...row.querySelectorAll('input:not([type=checkbox]):not([type=hidden]), textarea, select')]
      .filter((el) => (!el.getClientRects || el.getClientRects().length) && !el.disabled && !el.readOnly) : [];
  }

  function rowIsEditing(row) {
    if (!row) return false;
    if (row.matches('.k-grid-edit-row, .k-edit-row') || row.querySelector('.k-edit-cell')) return true;
    const grid = kGrid(row);
    const element = grid && grid.editable && grid.editable.element;
    const container = element && (element[0] || element);
    // Some columns keep inputs/dropdowns visible after a successful save.
    // Only an actual grid edit session means the row is still being committed.
    return !!(container && container.nodeType && row.contains(container));
  }

  async function cancelExtraBlank(before) {
    let blank;
    const blanks = () => rowEls().filter((r) => !cellText(r, CFG.cols.description));
    for (let i = 0; i < 10; i++) {
      const candidates = blanks().filter((r) => {
        const uid = r.getAttribute('data-uid');
        return uid ? !before.uids.has(uid) : !before.blankCount && !before.rows.has(r);
      });
      if (candidates.length > 1) throw new Error('Cannot identify the extra blank PO row safely. Cancel it in Nexvia and compare again.');
      if (candidates.length === 1) { blank = candidates[0]; break; }
      await sleep(200);
    }
    if (!blank) {
      if (blanks().length > before.blankCount) throw new Error('Cannot identify the extra blank PO row safely. Cancel it in Nexvia and compare again.');
      return; // Some grids only close the filled row on the first add-row click.
    }
    const uid = blank.getAttribute('data-uid');
    const grid = kGrid(blank);
    const stillPresent = () => {
      const inModel = uid && grid && grid.dataSource && grid.dataSource.getByUid && grid.dataSource.getByUid(uid);
      const inRows = uid ? rowEls().some((r) => r.getAttribute('data-uid') === uid) : blank.isConnected;
      return inModel || inRows || blanks().length > before.blankCount;
    };
    const escape = (target) => {
      if (target.focus) target.focus();
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type,
        { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    };
    escape(openRowEditors(blank).find((el) => el.tagName !== 'TEXTAREA') || blank);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (!stillPresent()) return;
      if (i === 1) {
        // A dropdown can consume the first Escape. Only cancel the identified
        // blank draft; never delete a filled row to dismiss its editor.
        const current = uid ? rowEls().find((r) => r.getAttribute('data-uid') === uid) : blank;
        if (!current || cellText(current, CFG.cols.description)) break;
        if (grid && grid.cancelRow) {
          const result = grid.cancelRow();
          if (result && typeof result.then === 'function') await result;
        } else escape(current);
      }
    }
    throw new Error('The extra blank PO row could not be cancelled. Press Esc on that blank row, then compare again before retrying.');
  }

  async function saveRow(row) {
    row = liveRow(row);
    const active = document.activeElement;
    if (active && row.contains(active) && active.blur) active.blur();
    row = liveRow(row);
    const g = kGrid(row);
    if (g) {
      const editable = g.options && g.options.editable;
      const mode = editable && typeof editable === 'object' ? editable.mode : editable;
      const inline = mode === 'inline' || mode === 'popup' ||
        ((mode == null || mode === true) && row.matches('.k-grid-edit-row, .k-edit-row'));
      const result = inline && g.saveRow ? g.saveRow() : g.closeCell();
      if (result && typeof result.then === 'function') await result;
    } else {
      const button = [...row.querySelectorAll('a, button, [role=button]')].find((el) =>
        el.offsetParent && (el.matches('.k-grid-update, .k-grid-save-command, [data-command="update"]') ||
          [el.getAttribute('title'), el.getAttribute('aria-label'), el.textContent]
            .some((s) => /^(save|update)(\s+(this\s+)?(line|row|item))?$/i.test(String(s || '').trim()))));
      if (button) fire(button);
      else if (openRowEditors(row).length) {
        const target = openRowEditors(row).find((el) => el.tagName !== 'TEXTAREA') || row;
        for (const type of ['keydown', 'keypress', 'keyup']) {
          target.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      }
    }
    // Nexvia can keep the row open after Enter or a grid save command. Run
    // its outside-click handler too, without opening another blank PO row.
    const title = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, label, div, span')]
      .find((e) => e.offsetParent && !row.contains(e) && !(panel && panel.contains(e)) &&
        !e.closest('a, button, [role=button]') && /^items and materials$/i.test(e.textContent.trim()));
    const outside = title || gridRoot();
    if (outside && !row.contains(outside)) fire(outside);
    // Numeric values can be in the model before the inline row is committed.
    // Deleting another row at that point can cancel the last new row.
    let advance = null;
    for (let i = 0; i < 50; i++) {
      await sleep(Math.max(200, CFG.stepDelay));
      if (!rowIsEditing(liveRow(row))) {
        if (advance) {
          await cancelExtraBlank(advance);
          if (rowIsEditing(liveRow(row))) throw new Error('The filled PO row did not stay saved after cancelling the extra blank row. Compare again.');
        }
        const err = validationError();
        if (err) throw new Error('Nexvia says: ' + err);
        return;
      }
      const err = validationError();
      if (err) throw new Error('Nexvia says: ' + err);
      if (i === 4) {
        const button = findAddBtn();
        if (button) {
          const rows = rowEls();
          advance = { rows: new Set(rows), uids: new Set(rows.map((r) => r.getAttribute('data-uid')).filter(Boolean)),
            blankCount: rows.filter((r) => !cellText(r, CFG.cols.description)).length };
          log('Confirming row via Click To Add New Row; the extra blank row will be cancelled.');
          const target = button.closest('td') || button;
          target.scrollIntoView({ block: 'center' });
          fire(target);
        }
      }
    }
    throw new Error('The PO line is still in edit mode. Confirm the row in Nexvia and compare again before continuing.');
  }

  function findAddBtn() {
    return [...document.querySelectorAll('a, button, td, div, span')]
      .filter((e) => e.offsetParent && e.textContent.trim().endsWith(CFG.addRowText))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  }

  // true if Nexvia already put a value in this cell (e.g. its automatic defaults)
  function hasValue(row, headerText) {
    const c = cellIn(row, headerText);
    if (!c) return false;
    const w = widgetIn(c);
    if (w && w.value && String(w.value() ?? '').trim()) return true;
    const shown = c.querySelector('.k-input-value-text, .k-input, input:not([type=hidden])');
    const t = shown ? (shown.tagName === 'INPUT' ? shown.value : shown.textContent) : c.textContent;
    return !!String(t || '').trim();
  }

  // Text currently shown in a cell (dropdown value or plain text)
  function cellText(row, headerText) {
    const c = cellIn(row, headerText);
    if (!c) return '';
    const w = widgetIn(c);
    if (w && w.text) return String(w.text() || '').trim();
    const select = c.querySelector('select');
    if (select) return String(select.options[select.selectedIndex]?.text || '').replace(/\s+/g, ' ').trim();
    const shown = c.querySelector('.k-input-value-text, .k-input, input:not([type=hidden])');
    const t = shown ? (shown.tagName === 'INPUT' ? shown.value : shown.textContent) : c.textContent;
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  // Set a field directly on the grid's data (used for Supplier Ref)
  function setViaModel(row, titlePrefix, value) {
    const g = kGrid(row) || kendoGridFor(gridRoot());
    if (!g || !g.columns) return false;
    const flat = [];
    const walk = (cols) => cols.forEach((c) => { flat.push(c); if (c.columns) walk(c.columns); });
    walk(g.columns);
    const clean = (t) => String(t || '').replace(/<[^>]*>/g, '').trim().toLowerCase();
    const col = flat.find((c) => c.field && clean(c.title).startsWith(titlePrefix.toLowerCase())) ||
      flat.find((c) => c.field && /supplier.?ref/i.test(c.field) && /supplier/i.test(titlePrefix));
    const item = g.dataItem(row);
    if (!col || !item || typeof item.set !== 'function' || typeof item.get !== 'function') return false;
    item.set(col.field, value);
    return String(item.get(col.field) ?? '') === String(value);
  }

  function verifySupplierReference(row, ref) {
    const actual = cellText(liveRow(row), CFG.cols.supplierRef);
    if (actual !== ref) throw new Error(`Supplier Ref mismatch: wanted "${ref}"; Nexvia shows "${actual}". Review the line and compare again.`);
  }

  async function setSupplierReference(row, ref) {
    if (cellText(liveRow(row), CFG.cols.supplierRef) === ref) return;
    await editCell(liveRow(row), CFG.cols.supplierRef, ref);
    if (cellText(liveRow(row), CFG.cols.supplierRef) !== ref &&
        !setViaModel(liveRow(row), CFG.cols.supplierRef, ref)) {
      throw new Error('Could not set Supplier Ref. Review the line and compare again.');
    }
    verifySupplierReference(row, ref);
  }

  function kendoGridFor(root) {
    if (!window.jQuery || !root) return null;
    const $r = window.jQuery(root);
    let g = $r.closest('[data-role=grid]');
    if (!g.length) g = $r.find('[data-role=grid]').first();
    return g.length ? g.data('kendoGrid') : null;
  }

  // every data row in the PO grid
  function rowEls() {
    const root = gridRoot();
    if (!root) return [];
    return [...root.querySelectorAll('tr, [role=row]')].filter((r) =>
      r.offsetParent && !r.querySelector('th, [role=columnheader]') &&
      !r.textContent.includes(CFG.addRowText) &&
      r.querySelectorAll('td, [role=gridcell]').length > 5);
  }

  function blankRow() {
    return rowEls().find((r) => {
      const c = cellIn(r, CFG.cols.description);
      if (!c) return false;
      const inp = c.querySelector('input, textarea');
      return !(inp ? inp.value : c.textContent).trim();
    });
  }

  async function addRow() {
    const blank = blankRow();
    if (blank) { log('Using existing blank row'); return blank; }
    const before = new Set(rowEls());
    const beforeUids = new Set([...before].map((r) => r.getAttribute('data-uid')).filter(Boolean));
    const tries = [
      () => {
        const b = findAddBtn();
        if (!b) return;
        const td = b.closest('td') || b;
        td.scrollIntoView({ block: 'center' });
        fire(td);
        return 'Nexvia add-row click';
      },
      () => {
        const b = findAddBtn();
        if (b && window.jQuery) { window.jQuery(b.closest('td') || b).trigger('click'); return 'jQuery click'; }
      },
      () => { const b = findAddBtn(); if (b) { fire(b); return 'inner click'; } },
      () => { const g = kendoGridFor(gridRoot()); if (g && g.addRow) { g.addRow(); return 'grid addRow (no Nexvia defaults)'; } },
    ];
    for (const t of tries) {
      let how = null;
      try { how = t(); } catch (e) { console.warn('[Quote→PO]', e); }
      if (!how) continue;
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const current = rowEls();
        const nw = current.find((r) => {
          const uid = r.getAttribute('data-uid');
          return uid && !beforeUids.has(uid);
        });
        if (nw) return nw;
        const b2 = blankRow();
        if (b2) return b2;
        // DOM redraws can replace every row. Only use element identity when
        // some original rows survived; otherwise it can select an existing line.
        if (!before.size || current.some((r) => before.has(r))) {
          const fresh = current.filter((r) => !before.has(r));
          if (fresh.length === 1) return fresh[0];
        }
      }
      log(`Add row via ${how} didn't work, trying next way...`);
    }
    const b = findAddBtn(), root = gridRoot();
    log('DEBUG: grid=' + (root ? root.tagName + '.' + root.className : 'none') +
      ' rows=' + rowEls().length + ' kendo=' + !!window.kendo + ' jquery=' + !!window.jQuery +
      ' button=' + (b ? b.outerHTML.slice(0, 250) : 'none'));
    throw new Error('New row did not appear.');
  }

  function breakdownInfo(row) {
    try {
      const summarize = (value, depth = 0) => {
        if (typeof value === 'string') return value.slice(0, 240);
        if (value == null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return `[${value.length} items]`;
        if (depth > 1) return '[object]';
        const data = typeof value.toJSON === 'function' ? value.toJSON() : value;
        if (data == null || typeof data !== 'object') return summarize(data, depth + 1);
        const keys = Object.keys(data).filter((key) => /^(id|uid|value|name|description|code|type|text|label|breakdownid|breakdowntypeid|assemblyid)$/i.test(key));
        return Object.fromEntries(keys.slice(0, 10).map((key) => [key, summarize(data[key], depth + 1)]));
      };
      const grid = kGrid(row), column = grid && gridColumn(grid, CFG.cols.breakdown);
      const model = grid && grid.dataItem(row);
      const cell = cellIn(row, CFG.cols.breakdown), widget = cell && widgetIn(cell);
      const editor = cell && visibleEditor(cell, false);
      const read = (field) => model && (model.get ? model.get(field) : model[field]);
      const related = model ? Object.keys(model).filter((key) =>
        /(?:breakdown|assembly)(?:id|type|name|description|code){0,3}$/i.test(key)) : [];
      return { uid: row.getAttribute ? row.getAttribute('data-uid') || '' : '',
        shown: cellText(row, CFG.cols.breakdown), field: column && column.field,
        bound: column && summarize(read(column.field)),
        related: Object.fromEntries(related.slice(0, 10).map((field) => [field, summarize(read(field))])),
        widget: widget ? { name: widget.options.name, textField: widget.options.dataTextField,
          valueField: widget.options.dataValueField, value: widget.value && summarize(widget.value()),
          text: widget.text && widget.text(), selectHandlers: widget._events?.select?.length || 0 } : null,
        editor: editor ? { tag: editor.tagName, name: editor.name, value: editor.value,
          binding: editor.getAttribute('data-bind') } : null };
    } catch (error) { return { diagnosticError: error.message }; }
  }

  function breakdownIdentity(row) {
    const read=(obj,key)=>obj&&key?(typeof obj.get==='function'?obj.get(key):obj[key]):undefined;
    const id=value=>{if(typeof value==='number'&&Number.isFinite(value))return String(value);if(typeof value==='string'&&/^(?:[A-Za-z]+_)?[0-9]+$|^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value))return value;return '';};
    const grid=kGrid(row),column=grid&&gridColumn(grid,CFG.cols.breakdown),model=grid&&grid.dataItem(row);
    if(!model||!column)return '';
    const values=[];
    const add=value=>{const scalar=id(value);if(scalar)values.push(scalar);else if(value&&typeof value==='object')for(const key of ['id','value','breakdownId','breakdownTypeId','assemblyId']){const found=id(read(value,key));if(found)values.push(found);}};
    add(read(model,column.field));
    if(column.field.includes('.'))add(read(model,column.field.split('.')[0]));
    for(const key of Object.keys(model.toJSON?.()||model).filter(key=>/^(?:breakdown(?:type)?|assembly)(?:_?id)?$/i.test(key)))add(read(model,key));
    const unique=[...new Set(values)];if(unique.length===1)return unique[0];
    // An active, bound dropdown supplies its exact ID when the model stores only text.
    if(!unique.length){const cell=cellIn(row,CFG.cols.breakdown),widget=cell&&widgetIn(cell);if(widget&&typeof widget.value==='function'&&typeof widget.text==='function'&&normalizedText(widget.text())===normalizedText(cellText(row,CFG.cols.breakdown)))return id(widget.value());}
    return '';
  }

  async function verifyBreakdown(row, expected, expectedId = null) {
    let actual = '';
    for (let i = 0; i < 10; i++) {
      actual = cellText(liveRow(row), CFG.cols.breakdown);
      if (normalizedText(actual) === normalizedText(expected)&&(!expectedId||breakdownIdentity(liveRow(row))===String(expectedId))) return;
      await sleep(200);
    }
    log('Breakdown diagnostic (saved mismatch): ' + JSON.stringify(breakdownInfo(liveRow(row))));
    throw new Error(`Breakdown Type mismatch: wanted "${expected}"; Nexvia shows "${actual || '(blank)'}". Review the new line and compare again.`);
  }

  // Fill one brand-new row (used by quote import and for extra invoice lines)
  async function fillNewRow(it, acct, ref, requireBreakdown = false) {
    const breakdown = $('qbd').value.trim();
    if (requireBreakdown && !breakdown) throw new Error('Choose a Breakdown Type before adding invoice lines.');
    const referenceRow = requireBreakdown && readPoLines().find((line) => normalizedText(line.breakdown) === normalizedText(breakdown));
    const referenceInfo = referenceRow && breakdownInfo(referenceRow.row);
    const references=requireBreakdown?readPoLines().filter(line=>normalizedText(line.breakdown)===normalizedText(breakdown)):[];
    const referenceIds=[...new Set(references.map(line=>breakdownIdentity(line.row)).filter(Boolean))];
    if(referenceIds.length>1)throw Error('Existing PO lines use different Breakdown IDs for the same label. Select the intended classification in Nexvia before importing.');
    const breakdownId=referenceIds[0]||null;
    if(referenceInfo&&!breakdownId)log('Breakdown reference identity could not be read: '+JSON.stringify(referenceInfo));
    if(breakdownId)log('Using existing PO Breakdown ID: '+breakdownId+' for '+breakdown);
    const original = await addRow();
    const row = () => liveRow(original);
    if (!(await editCell(row(), CFG.cols.description, it.description))) throw new Error('Could not edit Item Description.');
    if (!(await editCell(row(), CFG.cols.acct, acct))) throw new Error(`Acct# "${acct}" not found in list`);
    if (it.measure && !(await editCell(row(), CFG.cols.measure, it.measure))) throw new Error(`Could not set Measure "${it.measure}".`);
    if (ref) await setSupplierReference(row(), ref);
    const tax = it.tax || $('qtaxv').value.trim() || 'GST Applied';
    if (cellText(row(), CFG.cols.tax).toLowerCase() !== tax.toLowerCase()) {
      if (!(await editCell(row(), CFG.cols.tax, tax))) throw new Error(`Tax: no option matching "${tax}"`);
    }
    for (const [col, id] of [[CFG.cols.costCat, 'qcc'], [CFG.cols.breakdown, 'qbd']]) {
      const v = $(id).value.trim();
      // Existing POs no longer supply the breakdown default for added lines.
      const required = requireBreakdown && col === CFG.cols.breakdown;
      if (!v || (!required && hasValue(row(), col))) continue;
      if (!(await editCell(row(), col, v, col===CFG.cols.breakdown?breakdownId:null))) throw new Error(`${col}: no option matching "${v}"`);
    }
    if (requireBreakdown) await verifyBreakdown(row(), breakdown, breakdownId);
    // Account/tax/breakdown changes can rebuild numeric editors or reset Qty.
    // Finish classifications first, then fill and check the numeric inputs.
    const amt = !isNaN(it.amount) ? it.amount : r2(it.quantity * it.unitCost);
    const fillNumbers = async () => {
      await setNumber(row(), CFG.cols.quantity, it.quantity);
      await setNumber(row(), CFG.cols.unitCost, it.unitCost);
      await setNumber(row(), CFG.cols.quantity, it.quantity);
      await setNumber(row(), CFG.cols.amount, amt);
    };
    await fillNumbers();
    const beforeSave = requireBreakdown && breakdownInfo(row());
    await saveRow(row());
    if (requireBreakdown) {
      try { await verifyBreakdown(row(), breakdown, breakdownId); }
      catch (error) {
        if (referenceInfo) log('Breakdown diagnostic (existing reference): ' + JSON.stringify(referenceInfo));
        log('Breakdown diagnostic (before save): ' + JSON.stringify(beforeSave));
        log(`Nexvia did not retain Breakdown Type "${breakdown}". Reapplying it once and checking the saved row again.`);
        if (!(await editCell(row(), CFG.cols.breakdown, breakdown, breakdownId))) throw error;
        await verifyBreakdown(row(), breakdown, breakdownId);
        await fillNumbers();
        await saveRow(row());
        await verifyBreakdown(row(), breakdown, breakdownId);
      }
    }
    if (ref) verifySupplierReference(row(), ref);
    const savedRow = row();
    if (it.tax && normalizedText(cellText(savedRow, CFG.cols.tax)) !== normalizedText(it.tax)) throw new Error('Nexvia did not keep Tax '+it.tax+'. Review this line before retrying.');
    return { row: savedRow, uid: savedRow.getAttribute ? savedRow.getAttribute('data-uid') || '' : '',
      description: it.description, breakdown: requireBreakdown ? breakdown : undefined };
  }

  function checkAcct() {
    const acct = $('qacct').value.trim();
    if (!acct) { $('qacct').focus(); $('qacct').style.borderColor = '#c0392b'; log('Enter an Acct# first (required by Nexvia).'); toast('Choose an Acct# for the new lines before applying changes', false); return ''; }
    $('qacct').style.borderColor = '';
    localStorage.setItem('qpoAcct', acct);
    ['qcc', 'qbd'].forEach((id) => localStorage.setItem('qpo2_' + id, $(id).value.trim()));
    localStorage.setItem('qpoTax', $('qtaxv').value.trim() || 'GST Applied');
    return acct;
  }

  function documentReferences() {
    const files=Array.from($('qfile')?.files || []);
    const refs=files.length>1?files.map((file,index)=>({file,reference:$('qdocref'+index)?.value.trim()||'',input:$('qdocref'+index)})):[];
    if(files.length<=1 || $('qtext')?.value.trim())refs.push({reference:$('qref').value.trim(),input:$('qref')});
    return refs;
  }

  function checkSupplierRef() {
    const refs=documentReferences(),missing=refs.find(r=>!r.reference);
    refs.forEach(r=>{if(r.input)r.input.style.borderColor=r.reference?'':'#c0392b';});
    if(missing){missing.input?.focus();log('Enter a Supplier Ref first (supplier quote, invoice or order reference) for each document. No PO changes were made.');toast('Supplier Ref is required for each document',false);return '';}
    const seen=new Set();
    for(const r of refs.filter(r=>r.file)){
      const key=normalizedText(r.reference);
      if(seen.has(key)){log('Two selected PDFs use the same Supplier Ref. Combine pages of one invoice into one PDF, or correct the references. No PO changes were made.');toast('Each invoice PDF needs its own Supplier Ref',false);return '';}
      seen.add(key);
    }
    return refs[0]?.reference||'';
  }

  async function setBatchNotes(refs,lines=[]) {
    refs=[...new Set(refs.filter(Boolean))];
    if(refs.length>1){
      const input=poNotesBox();let value=input.value;
      for(const ref of refs)if(!value.split(/\r?\n/).some(line=>line.trim()==='Supplier reference: '+ref))value+=(value&&!/\n$/.test(value)?'\n':'')+'Supplier reference: '+ref;
      if(input.maxLength>0 && value.length>input.maxLength)throw new Error('The supplier references would exceed the PO Notes length limit. No PO lines were changed.');
    }
    for(const ref of refs)await setPoNotesReference(ref);
    for(const line of lines.filter(i=>i.roundingNote))await setPoNotesReference((line.supplierRef||refs[0])+' | '+line.roundingNote);
  }

  function poNotesBox() {
    const matches = [...document.querySelectorAll('textarea')].filter((el) =>
      !(panel && panel.contains(el)) && el.getClientRects().length &&
      /^enter any notes here[.!…]*$/i.test((el.getAttribute('placeholder') || '').trim()));
    if (matches.length !== 1) throw new Error('Could not identify a single PO Notes box (Enter any notes here). Review the PO before continuing.');
    const input = matches[0];
    if (input.disabled || input.readOnly) throw new Error('The PO Notes box is not editable. Review the PO before continuing.');
    return input;
  }

  function verifyPoNotesReference(ref) {
    if (!poNotesBox().value.split(/\r?\n/).some((line) => line.trim() === 'Supplier reference: ' + ref)) {
      throw new Error('Nexvia did not retain the supplier reference in PO Notes. Review the notes before retrying.');
    }
  }

  async function setPoNotesReference(ref) {
    const input = poNotesBox();
    const tag = 'Supplier reference: ' + ref;
    if (input.value.split(/\r?\n/).some((line) => line.trim() === tag)) return;
    const value = input.value + (input.value && !/\n$/.test(input.value) ? '\n' : '') + tag;
    if (input.maxLength > 0 && value.length > input.maxLength) throw new Error('The supplier reference would exceed the PO Notes length limit. Review the existing notes first.');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    await sleep(100);
    if (poNotesBox().value !== value) throw new Error('Nexvia did not retain the supplier reference in PO Notes. Review the notes before retrying.');
    log('Supplier reference added to PO Notes.');
  }

  async function pushToNexvia(items) {
    const ref = checkSupplierRef();
    if (!ref) return 0;
    const acct = checkAcct();
    if (!acct) return 0;
    const pending = validationError();
    if (pending) { log('Nexvia is showing "' + pending + '" on an existing row. Fix or delete that row first.'); return 0; }
    const start = Math.max(1, parseInt($('qstart').value, 10) || 1);
    const incoming=items.slice(start-1).map(it=>({...it,supplierRef:it.supplierRef||ref,amount:r2(it.quantity*it.unitCost)}));
    const comparison=compareAppendInvoice(incoming,readPoLines());
    if(comparison.some(r=>r.status==='conflict')){log('An invoice reference/product already exists with different values. Review it before adding; no PO changes were made.');toast('Review the duplicate invoice reference first',false);return 0;}
    const refs=[...new Set(incoming.map(it=>it.supplierRef))];
    await setBatchNotes(refs,items);
    let ok = 0, skipped=0;
    const candidates=comparison.filter(r=>r.inv);
    for (let offset=0;offset<incoming.length;offset++) {
      const i=start-1+offset,it=incoming[offset];
      if(candidates[offset].status==='same'){skipped++;$('qstart').value=i+2;continue;}
      log(`Line ${i + 1}/${items.length}: ${it.description.slice(0, 40)}... [${it.supplierRef}]`);
      try {
        const identity=await fillNewRow(it, acct, it.supplierRef);
        await verifyPoLine(identity,it);
        ok++;
        $('qstart').value = i + 2;
      } catch (e) {
        log('ERROR: ' + e.message + `\nFix/delete that row, then click Add lines again (resumes at line ${i + 1}).`);
        toast(`✕ Import stopped at line ${i + 1} - see the log`, false);
        return 0;
      }
    }
    if(skipped)log('Skipped '+skipped+' line(s) already on this PO with the same supplier reference and values.');
    refs.forEach(verifyPoNotesReference);
    $('qstart').value = 1;
    stageRegisterAfterPo(items);
    log(`Done - ${ok} line(s) added. Check totals, then Create.`);
    toast(`✓ Import complete - ${ok} line(s) added. Check totals, then click Create.`);
    return ok;
  }

  // ---------- UPDATE PO FROM INVOICE ----------
  const codeOf = (d) => (String(d || '').trim().replace(/^(\S*[-/])\s+(?=\d)/, '$1').split(/\s+/)[0] || '')
    .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase();
  const parenOf = (d) => { const m = String(d || '').match(/\(([A-Za-z0-9.\-]+)\)/); return m ? m[1].toUpperCase() : ''; };

  function readPoLines() {
    return rowEls().map((row) => {
      return {
        row,
        uid: row.getAttribute('data-uid') || '',
        description: cellText(row, CFG.cols.description),
        quantity: readNumber(row, CFG.cols.quantity),
        unitCost: readNumber(row, CFG.cols.unitCost),
        amount: readNumber(row, CFG.cols.amount),
        acct: cellText(row, CFG.cols.acct),
        supplierRef: cellText(row, CFG.cols.supplierRef),
        breakdown: cellText(row, CFG.cols.breakdown),
        tax: cellText(row, CFG.cols.tax),
      };
    }).filter((l) => l.description);
  }

  let autoInvoiceBreakdown = null;
  let autoInvoiceAccount = null;
  let invoiceAccounts = [];

  function existingPoValues(po, field) {
    const unique = new Map();
    po.forEach((line) => {
      const value = String(line[field] ?? '').replace(/\s+/g, ' ').trim();
      if (!value || /^[-–—]+$/.test(value) || /^(please\s+)?select\b/i.test(value)) return;
      const key = value.toLowerCase();
      if (!unique.has(key)) unique.set(key, value);
    });
    return [...unique.values()];
  }

  function existingBreakdownTypes(po) {
    return existingPoValues(po, 'breakdown');
  }

  function syncInvoiceAccount(po, reset = false) {
    invoiceAccounts = existingPoValues(po, 'acct');
    const field = $('qacct');
    // Prefer this PO's account over any value remembered from a different PO.
    if (reset || field.value.trim() === autoInvoiceAccount) {
      field.value = invoiceAccounts.length === 1 ? invoiceAccounts[0] : '';
      autoInvoiceAccount = field.value;
      field.style.borderColor = '';
    }
    const chosen = field.value.trim();
    $('qaccthint').textContent = chosen
      ? (chosen === autoInvoiceAccount ? 'Using existing Acct#: ' : 'Using your selected Acct#: ') + chosen
      : invoiceAccounts.length > 1
        ? 'This PO uses multiple accounts. Choose one from the account list for new invoice lines.'
        : 'No Acct# found on existing lines. Choose an account for new invoice lines.';
    return chosen;
  }

  function syncInvoiceBreakdown(po, reset = false) {
    const types = existingBreakdownTypes(po);
    const field = $('qbd');
    // A saved value from another PO must not override this PO's existing type.
    // Keep a manual override entered after detection; refresh automatic choices.
    if (reset || field.value.trim() === autoInvoiceBreakdown) {
      field.value = types.length === 1 ? types[0] : '';
      autoInvoiceBreakdown = field.value;
      field.style.borderColor = '';
    }
    const list = $('qbdoptions');
    list.replaceChildren();
    types.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      list.appendChild(option);
    });
    const chosen = field.value.trim();
    $('qbdhint').textContent = chosen
      ? (chosen === autoInvoiceBreakdown ? 'Using existing Breakdown Type: ' : 'Using your selected Breakdown Type: ') + chosen
      : types.length > 1
        ? 'This PO uses multiple Breakdown Types. Choose one from the suggestions for new invoice lines.'
        : 'No Breakdown Type found on existing lines. Enter one for new invoice lines.';
    return chosen;
  }

  function compareInvoice(inv, po) {
    const used = new Set();
    const out = [];
    inv.forEach((it) => {
      const c = codeOf(it.description), p = parenOf(it.description);
      const free = (l) => !used.has(l);
      let m = po.find((l) => free(l) && c && codeOf(l.description) === c &&
        (!p || !parenOf(l.description) || parenOf(l.description) === p));
      if (!m && p) m = po.find((l) => free(l) && parenOf(l.description) === p);
      if (!m) m = po.find((l) => free(l) && l.description.toLowerCase() === it.description.toLowerCase());
      const invAmt = !isNaN(it.amount) ? it.amount : r2(it.quantity * it.unitCost);
      if (m) {
        used.add(m);
        const same = poNumbersMatch(m, {quantity:it.quantity,unitCost:unitFor(it,invAmt),amount:invAmt}) && (!it.tax || normalizedText(m.tax) === normalizedText(it.tax));
        out.push({ status: same ? 'same' : 'changed', inv: it, po: m, invAmt, apply: !same });
      } else {
        out.push({ status: 'new', inv: it, invAmt, apply: true });
      }
    });
    po.filter((l) => !used.has(l)).forEach((l) => out.push({ status: 'missing', po: l, apply: true }));
    return out;
  }

  // Invoice additions never overwrite lines belonging to another invoice.
  // Reference + product + values identify a previously imported line.
  function compareAppendInvoice(inv, po) {
    const used=new Set(),out=[];
    const sameProduct=(a,b)=>normalizedText(a.description)===normalizedText(b.description)||
      (codeOf(a.description)&&/[0-9./-]/.test(codeOf(a.description))&&codeOf(a.description)===codeOf(b.description)&&
      (!parenOf(a.description)||!parenOf(b.description)||parenOf(a.description)===parenOf(b.description)));
    for(const it of inv){
      const invAmt=Number.isFinite(it.amount)?it.amount:r2(it.quantity*it.unitCost);
      const candidates=po.filter(line=>!used.has(line)&&it.supplierRef&&normalizedText(line.supplierRef)===normalizedText(it.supplierRef)&&sameProduct(it,line));
      const equal=line=>normalizedText(line.description)===normalizedText(it.description)&&
        poNumbersMatch(line,{quantity:it.quantity,unitCost:unitFor(it,invAmt),amount:invAmt})&&(!it.tax||normalizedText(line.tax)===normalizedText(it.tax));
      const exact=candidates.find(equal),match=exact||candidates[0];
      if(match){used.add(match);out.push({status:exact?'same':'conflict',inv:it,po:match,invAmt,apply:false,append:true});}
      else out.push({status:'new',inv:it,invAmt,apply:true,append:true});
    }
    po.filter(line=>!used.has(line)).forEach(line=>out.push({status:'keep',po:line,apply:false,append:true}));
    return out;
  }

  // Unit cost that gives the invoice amount exactly (handles discounts / rounding)
  const unitFor = (inv, amt) => (cents(r2(inv.quantity * inv.unitCost), amt) || !inv.quantity)
    ? inv.unitCost : +(amt / inv.quantity).toFixed(4);

  const poTotal = () => r2(readPoLines().reduce((s, l) => s + (isNaN(l.amount) ? 0 : l.amount), 0));

  function plannedPoLines(rows, original, supplierRef) {
    const plan = original.map((line) => ({ identity: line, values: { ...line }, addition: false }));
    for (const change of rows.filter((r) => r.apply && ['changed', 'new', 'missing'].includes(r.status))) {
      if (change.status === 'new') {
        plan.push({ source: change, addition: true, identity: null,
          values: { ...change.inv, supplierRef:change.inv.supplierRef||supplierRef, unitCost: unitFor(change.inv, change.invAmt), amount: change.invAmt } });
        continue;
      }
      let index = plan.findIndex((entry) => entry.identity &&
        (change.po.uid ? entry.identity.uid === change.po.uid : entry.identity.row === change.po.row));
      if (index < 0 && !change.po.uid) {
        const matches = plan.map((entry, i) => ({ entry, i })).filter(({ entry }) =>
          entry.identity && entry.identity.description === change.po.description);
        if (matches.length === 1) index = matches[0].i;
      }
      if (index < 0) throw new Error('A selected PO line no longer matches the comparison. Compare again.');
      if (change.status === 'missing') plan.splice(index, 1);
      else plan[index].values = { ...plan[index].values, supplierRef:change.inv.supplierRef||supplierRef, quantity: change.inv.quantity,
        unitCost: unitFor(change.inv, change.invAmt), amount: change.invAmt,
        ...(change.inv.tax ? {tax:change.inv.tax} : {}) };
    }
    return plan;
  }

  function finalPoDifference(plan) {
    const actual = readPoLines();
    const unused = [...actual];
    const missing = [];
    const sameNumber = (header, a, b) => (Number.isNaN(a) && Number.isNaN(b)) || numberMatches(header, a, b);
    const sameContent = (line, values) => {
      const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const code = codeOf(values.description);
      const sameProduct = normalize(line.description) === normalize(values.description) ||
        (code && code === codeOf(line.description) &&
          (!parenOf(values.description) || !parenOf(line.description) || parenOf(values.description) === parenOf(line.description)));
      return sameProduct && (!values.tax || normalize(line.tax) === normalize(values.tax)) && (!values.breakdown || normalize(line.breakdown) === normalize(values.breakdown)) &&
        (values.supplierRef === undefined || line.supplierRef === values.supplierRef) &&
        sameNumber(CFG.cols.quantity, line.quantity, values.quantity) &&
        (sameNumber(CFG.cols.unitCost, line.unitCost, values.unitCost) || poNumbersMatch(line, values)) &&
        sameNumber(CFG.cols.amount, line.amount, values.amount);
    };
    for (const entry of plan) {
      let index = unused.findIndex((line) => entry.identity && entry.identity.uid && line.uid === entry.identity.uid && sameContent(line, entry.values));
      if (index < 0) index = unused.findIndex((line) => sameContent(line, entry.values));
      if (index < 0) missing.push(entry); else unused.splice(index, 1);
    }
    const total = (lines) => r2(lines.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0));
    const expectedTotal = total(plan.map((entry) => entry.values));
    const actualTotal = total(actual);
    return { actual, missing, extra: unused, expectedTotal, actualTotal,
      ok: !missing.length && !unused.length && cents(expectedTotal, actualTotal) };
  }

  async function checkFinalPo(plan) {
    let difference;
    let stable = 0;
    for (let i = 0; i < 10; i++) {
      difference = finalPoDifference(plan);
      if (difference.ok) { if (++stable >= 3) return difference; }
      else stable = 0;
      await sleep(200);
    }
    return difference;
  }

  async function finishInvoiceChanges(plan, acct) {
    let difference = await checkFinalPo(plan);
    const actuallyAbsent = (entry) => {
      const grid = kendoGridFor(gridRoot()) || (entry.identity && kGrid(entry.identity.row));
      const uid = entry.identity && entry.identity.uid;
      // An off-screen/virtualized row may still be present in the data source.
      // Never restore a second copy while the original model still exists.
      return !(uid && grid && grid.dataSource && grid.dataSource.getByUid && grid.dataSource.getByUid(uid));
    };
    if (!difference.ok && !difference.extra.length && difference.missing.length &&
        difference.missing.every((entry) => entry.addition && actuallyAbsent(entry)) && (difference.actual.length || gridRoot())) {
      // A deletion/redraw may discard the final pending addition. Restore only
      // missing selected additions, once, after all deletions have finished.
      for (const entry of difference.missing) {
        log(`Final check: restoring missing new line ${codeOf(entry.values.description)} ($${entry.values.amount.toFixed(2)}).`);
        entry.identity = await fillNewRow(entry.values, acct, entry.values.supplierRef || '', true);
        await verifyPoLine(entry.identity, entry.values);
      }
      difference = await checkFinalPo(plan);
    }
    if (!difference.ok) {
      const missing = difference.missing.map((entry) => codeOf(entry.values.description)).join(', ') || 'none';
      const extra = difference.extra.map((line) => codeOf(line.description)).join(', ') || 'none';
      throw new Error(`Final PO check failed: expected ${plan.length} line(s), $${difference.expectedTotal.toFixed(2)} ex GST; found ${difference.actual.length}, $${difference.actualTotal.toFixed(2)}. Missing/incorrect: ${missing}. Unexpected/incorrect: ${extra}. Review the PO and compare again.`);
    }
    log(`Final check passed: ${plan.length} line(s), $${difference.actualTotal.toFixed(2)} ex GST.`);
    return difference.actualTotal;
  }

  // Prefer Kendo's stable row identity, especially when descriptions are repeated.
  function resolvePoLine(original) {
    const lines = readPoLines();
    if (original.uid) return lines.find((l) => l.uid === original.uid) || null;
    const sameRow = lines.find((l) => l.row === original.row);
    if (sameRow) return sameRow;
    const matches = lines.filter((l) => l.description === original.description);
    if (matches.length > 1) throw new Error('Multiple PO lines have this description. Compare again before applying changes.');
    return matches[0] || null;
  }

  async function deletePoLine(original) {
    const current = resolvePoLine(original);
    if (!current) throw new Error('PO line not found any more. Compare again before deleting.');
    const row = current.row;
    const g = kGrid(row) || kendoGridFor(gridRoot());
    const model = g && g.dataItem ? g.dataItem(row) : null;
    const uid = current.uid || (model && model.uid);
    if (g && typeof g.removeRow === 'function' && model && uid && g.dataSource &&
        typeof g.dataSource.getByUid === 'function') {
      // Use the grid command so Nexvia's own destroy/confirmation events still run.
      g.removeRow(window.jQuery(row));
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        if (!g.dataSource.getByUid(uid)) {
          const err = validationError();
          if (err) throw new Error('Nexvia says: ' + err);
          return;
        }
      }
      throw new Error('Deletion was cancelled or Nexvia did not remove the line. Check the PO, then compare again.');
    }
    // Non-Kendo fallback: only use an explicit delete/remove control in this row.
    const button = [...row.querySelectorAll('a, button, [role=button]')].find((el) =>
      el.offsetParent && (el.matches('.k-grid-delete, .k-grid-remove, [data-command="destroy"]') ||
        [el.getAttribute('title'), el.getAttribute('aria-label'), el.textContent]
          .some((s) => /^(delete|remove)(\s+(this\s+)?(line|row|item))?$/i.test(String(s || '').trim()))));
    if (!button) throw new Error('No supported delete control found for this PO line. Delete it manually in Nexvia.');
    fire(button);
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (!resolvePoLine(original)) {
        const err = validationError();
        if (err) throw new Error('Nexvia says: ' + err);
        return;
      }
    }
    throw new Error('Deletion was cancelled or Nexvia did not remove the line. Check the PO, then compare again.');
  }

  async function confirmDeletions(deletions) {
    const dialog = $('qdelete');
    $('qdeleteTitle').textContent = `Delete ${deletions.length} PO line${deletions.length === 1 ? '' : 's'}?`;
    $('qdeleteList').replaceChildren(...deletions.map((r) => {
      const li = document.createElement('li');
      li.textContent = r.po.description;
      return li;
    }));
    const cancel = $('qdeleteCancel'), apply = $('qdeleteApply');
    // runBusy disables the rest of the panel while this decision is pending.
    cancel.disabled = apply.disabled = false;
    apply.textContent = `Apply changes & delete ${deletions.length} line${deletions.length === 1 ? '' : 's'}`;
    dialog.returnValue = '';
    dialog.onkeydown = (e) => { if (e.key === 'Escape') e.stopPropagation(); };
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        cancel.disabled = apply.disabled = true;
        resolve(dialog.returnValue === 'apply');
        setTimeout(() => { if (!$('qapply').disabled) $('qapply').focus(); }, 0);
      }, { once: true });
      cancel.onclick = () => dialog.close('cancel');
      apply.onclick = () => dialog.close('apply');
      dialog.showModal();
    });
  }

  function requireFreshInvoiceComparison() {
    cmp = [];
    $('qapply').style.display = 'none';
    $('qcmp').style.display = 'none';
    $('qhint').textContent = 'Review any unfinished row in Nexvia, then click Compare with PO again.';
    $('qhint').style.display = 'block';
  }

  async function applyInvoice(rows) {
    if(rows.some(r=>r.status==='conflict')){log('An invoice reference/product is already on this PO with different values. Review that invoice before adding; no PO changes were made.');toast('Review the duplicate invoice reference first',false);return false;}
    const todo = rows.filter((r) => r.apply && ['changed', 'new', 'missing'].includes(r.status));
    if (!todo.length) { toast('Nothing ticked to change', false); return false; }
    if(rows.some(r=>r.append)){
      const incoming=rows.filter(r=>r.inv),fresh=compareAppendInvoice(incoming.map(r=>r.inv),readPoLines()).filter(r=>r.inv);
      if(fresh.some(r=>r.status==='conflict')||incoming.some((r,index)=>r.apply&&r.status==='new'&&fresh[index].status!=='new')){
        log('The PO has changed since the invoice-addition preview. Compare with PO again before applying. No PO changes were made.');requireFreshInvoiceComparison();return false;
      }
    }
    const ref = checkSupplierRef();
    if (!ref) return false;
    let acct = '';
    if (todo.some((r) => r.status === 'new')) {
      const po = readPoLines();
      syncInvoiceAccount(po, autoInvoiceAccount === null);
      syncInvoiceBreakdown(po, autoInvoiceBreakdown === null);
      acct = checkAcct(); if (!acct) return false;
      if (!$('qbd').value.trim()) {
        $('qbd').focus(); $('qbd').style.borderColor = '#c0392b';
        log('Could not select a single Breakdown Type automatically. Choose one for the new invoice lines.');
        toast('Choose a Breakdown Type for the new invoice lines', false);
        return false;
      }
      $('qbd').style.borderColor = '';
    }
    const pending = validationError();
    if (pending) { log('Fix the existing Nexvia validation error first: ' + pending); requireFreshInvoiceComparison(); return false; }
    // Recheck after the asynchronous confirmation as well as before opening it.
    const comparisonValid = () => {
      for (const r of todo.filter((r) => r.po)) {
        let current;
        try { current = resolvePoLine(r.po); } catch (e) { log(e.message); return false; }
        const unchanged = (a, b) => (isNaN(a) && isNaN(b)) || cents(a, b);
        if (!current || current.description !== r.po.description ||
            !unchanged(current.quantity, r.po.quantity) || !unchanged(current.unitCost, r.po.unitCost) ||
            !unchanged(current.amount, r.po.amount) || (r.inv?.tax && normalizedText(current.tax) !== normalizedText(r.po.tax))) {
          log('The PO has changed since comparison. Click Compare with PO again before applying changes.');
          toast('PO changed - compare again first', false);
          return false;
        }
      }
      return true;
    };
    if (!comparisonValid()) { requireFreshInvoiceComparison(); return false; }
    const deletions = todo.filter((r) => r.status === 'missing');
    if (deletions.length) {
      if (!(await confirmDeletions(deletions))) return false;
      if (!comparisonValid()) { requireFreshInvoiceComparison(); return false; }
      const error = validationError();
      if (error) { log('Fix the existing Nexvia validation error first: ' + error); requireFreshInvoiceComparison(); return false; }
    }
    const original = readPoLines();
    let plan;
    try { plan = plannedPoLines(rows, original, ref); }
    catch (e) { log(e.message); requireFreshInvoiceComparison(); toast('PO changed - compare again first', false); return false; }
    const refs=[...new Set(todo.filter(r=>r.inv).map(r=>r.inv.supplierRef||ref))];
    if(!refs.length)refs.push(ref);
    await setBatchNotes(refs,rows.filter(r=>r.inv).map(r=>r.inv));
    const before = r2(original.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0));
    let upd = 0, add = 0, removed = 0;
    // Delete last, after the selected updates and additions have succeeded.
    const ordered = [...todo.filter((r) => r.status !== 'missing'), ...deletions];
    for (const r of ordered) {
      const it = r.inv;
      const lineRef=it?.supplierRef||ref;
      try {
        if (r.status === 'changed') {
          const findRow = () => (resolvePoLine(r.po) || {}).row;
          let row = findRow();
          if (!row) throw new Error('PO line not found any more');
          log(`Update: ${it.description.slice(0, 40)}... qty ${r.po.quantity}→${it.quantity}, amount ${r.po.amount}→${r.invAmt}`);
          await setSupplierReference(row, lineRef);
          row = findRow() || row;
          if (it.tax && normalizedText(cellText(row, CFG.cols.tax)) !== normalizedText(it.tax)) {
            if (!(await editCell(row, CFG.cols.tax, it.tax))) throw new Error('Tax: no option matching '+it.tax);
            row = findRow() || row;
          }
          await setNumber(row, CFG.cols.quantity, it.quantity);
          row = findRow() || row;
          await setNumber(row, CFG.cols.unitCost, unitFor(it, r.invAmt));
          row = findRow() || row;
          await setNumber(row, CFG.cols.amount, r.invAmt);
          row = findRow() || row;
          await saveRow(row);
          verifySupplierReference(findRow() || row, lineRef);
          await verifyPoLine(r.po, { quantity: it.quantity, unitCost: unitFor(it, r.invAmt), amount: r.invAmt, tax:it.tax });
          upd++;
        } else if (r.status === 'new') {
          log(`Add: ${it.description.slice(0, 40)}...`);
          const expected = { ...it, supplierRef:lineRef, unitCost: unitFor(it, r.invAmt), amount: r.invAmt };
          const identity = await fillNewRow(expected, acct, lineRef, true);
          await verifyPoLine(identity, expected);
          const entry = plan.find((entry) => entry.source === r);
          entry.identity = identity;
          entry.values.breakdown = identity.breakdown;
          add++;
        } else {
          log(`Delete: ${r.po.description.slice(0, 40)}...`);
          await deletePoLine(r.po);
          removed++;
        }
      } catch (e) {
        log('ERROR: ' + e.message + `\nStopped after ${upd} updated, ${add} added, ${removed} deleted. Review the PO and compare again before retrying.`);
        requireFreshInvoiceComparison();
        toast('✕ Update stopped - review the PO and compare again', false);
        return false;
      }
    }
    let after;
    try { after = await finishInvoiceChanges(plan, acct); refs.forEach(verifyPoNotesReference); }
    catch (e) {
      log('ERROR: ' + e.message + `\nFinal result not confirmed after ${upd} updates, ${add} additions, ${removed} deletions. Do not retry without comparing again.`);
      requireFreshInvoiceComparison();
      toast('✕ PO update incomplete - final line/total check failed; see the log', false);
      return false;
    }
    stageRegisterAfterPo(rows.filter(r=>r.inv).map(r=>r.inv));
    const money = (v) => '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    log(`Done - ${upd} updated, ${add} added, ${removed} deleted. PO total ${money(before)} → ${money(after)}. Click Save in Nexvia.`);
    toast(`✓ PO updated - ${upd} changed, ${add} added, ${removed} deleted. Total ${money(before)} → ${money(after)}. Click Save.`);
    return true;
  }

  function aiEndpoint(value) {
    let url;try{url=new URL(value);}catch{throw new Error('Enter the HTTPS AI service URL ending in /extract.');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/extract')throw new Error('Use an HTTPS AI service URL ending in /extract, without credentials or query parameters.');
    return url.href;
  }

  // Save once through Nexvia's own toolbar. Never infer success from a click.
  const PO_SAVE_KEY='qpoSaveAttemptV1';
  let poSaveAttempt=null;
  let poSaveRestoreUnsafe=false;
  const poSaveVisible=el=>!!el&&!el.closest?.('#qpoRoot,[hidden],[aria-hidden="true"]')&&(!el.getClientRects||el.getClientRects().length>0);
  function poWorkflowScope() {
    const details=gatherRegisterPageDetails();
    return {url:String(location.pathname||'')+String(location.search||''),job:details.job||'',supplier:details.supplier||''};
  }
  function preflightPoWorkflow() {
    if(!$('qpoautosave')?.checked)return;
    if($('qregisterenabled')?.checked){
      autofillRegisterDetails();
      if(!registerDraft||registerDraft.verification==='stale')throw Error('Read the PDF again to prepare the register preview before adding lines.');
      if(registerDraft.payload)throw Error('A register write is already pending. Retry it before adding more lines.');
      if(!$('qregisterjob').value.trim()||registerDraft.documents.some(d=>!d.supplier?.trim()||!d.invoiceNumber?.trim()))throw Error('Complete supplier, document number and job in the preview before adding lines.');
      aiEndpoint($('qaiurl').value.trim());
      if($('qaitoken').value.trim().length<32)throw Error('Save your NAS service access token before adding lines; register recording uses this token.');
    }
    if(poSaveRestoreUnsafe)throw Error('The previous save guard could not be read. Check Nexvia before retrying; no lines were added.');
    if(!poSaveAttempt)return;
    const details=gatherRegisterPageDetails(),scope=poWorkflowScope();
    const newHeading=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],.page-title,.page-header,.content-header')]
      .some(el=>poSaveVisible(el)&&/^New Purchase Order\s*[-–—:]/i.test((el.textContent||'').trim()));
    // Nexvia's actual project add route is positive new-form evidence even
    // when its title is outside a semantic heading or is clipped by a toolbar.
    const addRoute=/^\/staff\/project-purchase-order-add\/\d+\/?$/i.test(String(location.pathname||''));
    let createControl=false;
    if(addRoute){try{createControl=/^Create /i.test(findPoSaveControl().action);}catch{}}
    const emptyNew=(newHeading||addRoute&&createControl)&&!details.poNumber&&readPoLines().length===0;
    const previousConfirmed=!!poSaveAttempt.createdPoNumber&&poSaveAttempt.outcome==='number-collected';
    const previousScope=poSaveAttempt.scope;
    const differentPage=previousScope&&previousScope.url!==scope.url;
    const differentJob=previousScope?.job&&scope.job&&normalizedText(previousScope.job)!==normalizedText(scope.job);
    const previousRefs=(poSaveAttempt.rows||[]).map(row=>normalizedText(row.supplierRef));
    const currentRefs=(registerDraft?.documents||[]).map(doc=>normalizedText(doc.reference));
    const differentDocument=addRoute&&createControl&&previousRefs.length>0&&currentRefs.length>0&&
      previousRefs.every(Boolean)&&currentRefs.every(Boolean)&&currentRefs.every(ref=>!previousRefs.includes(ref));
    // Only retire the guard before any writes on an explicitly empty new PO.
    // An uncertain retry on the same form must never cause a second Create.
    if(emptyNew&&(previousConfirmed||differentPage||differentJob||differentDocument)){
      if(registerDraft?.payload)throw Error('The previous register write is still pending. Retry it on its saved PO before starting another; no lines were added.');
      poSaveAttempt=null;persistPoSaveAttempt();
      if($('qregisterpo'))$('qregisterpo').value='';
      if(registerDraft){registerDraft.poNumber='';persistRegisterDraft();}
      poSaveStatus('New empty PO detected. The previous PO save guard was retired.');
      return;
    }
    throw Error('An earlier automatic save is recorded for this PO or could not be distinguished from it. No lines were added. Collect its Order Number before retrying; do not create it twice.');
  }
  function poSaveRows(lines=readPoLines()) {
    if(!lines.length||lines.some(i=>!i.description||!Number.isFinite(i.quantity)||!Number.isFinite(i.unitCost)||!Number.isFinite(i.amount)))throw Error('PO rows are incomplete. Save manually after reviewing Nexvia.');
    return lines.map(i=>({description:i.description,quantity:i.quantity,unitCost:i.unitCost,amount:i.amount,acct:i.acct||'',tax:i.tax||'',supplierRef:i.supplierRef||'',breakdown:i.breakdown||''}));
  }
  function samePoSaveRows(expected,actual) {
    const remaining=[...actual];
    for(const wanted of expected){
      const index=remaining.findIndex(i=>['description','acct','tax','supplierRef','breakdown'].every(k=>normalizedText(i[k])===normalizedText(wanted[k]))&&poNumbersMatch(i,wanted));
      if(index<0)return false;remaining.splice(index,1);
    }
    return remaining.length===0;
  }
  function poSaveControlLabel(el) {
    let value='';
    if(el.tagName==='INPUT')value=el.value||'';
    else{
      try{const copy=el.cloneNode(true);copy.querySelectorAll('i,svg,[aria-hidden="true"],.glyphicon,.fa,.fas,.far').forEach(node=>node.remove());value=copy.textContent||'';}catch{value=el.textContent||'';}
      if(!value.trim())value=el.getAttribute('aria-label')||el.getAttribute('title')||'';
    }
    return String(value).replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s*&\s*/g,' and ').replace(/\s+/g,' ').trim();
  }
  function poSaveControlEnabled(el) {
    return poUploadElementVisible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.closest?.('.disabled,.k-disabled,.k-state-disabled,[inert]');
  }
  function poSaveControlSpec(el) {
    const form=el.form||el.closest?.('form')||null,inline=el.getAttribute('onclick')||'';
    const type=String(el.type||el.getAttribute('type')||(el.tagName==='BUTTON'?'submit':'')).toLowerCase();
    return{form,inline,type,action:poSaveControlLabel(el).toLowerCase(),tag:el.tagName,
      native:!!form&&(['BUTTON','INPUT'].includes(el.tagName))&&type==='submit'&&!inline,
      settings:JSON.stringify([['name','value','formaction','formmethod','formtarget','formnovalidate'].map(k=>el.getAttribute(k)||''),Array.from(el.attributes||[]).filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value]).sort()]),href:el.getAttribute('href')||''};
  }
  function poEquivalentSaveControls(a,b) {
    const x=poSaveControlSpec(a),y=poSaveControlSpec(b);if(x.action!==y.action)return false;
    if(x.native&&y.native)return x.form===y.form&&x.settings===y.settings;
    if(x.inline&&x.inline===y.inline&&x.tag===y.tag&&x.href===y.href&&x.settings===y.settings){
      // Sticky/footer copies may sit outside the form. Equivalent explicit
      // global handlers are safe to deduplicate; context-dependent handlers are not.
      return !(/\b(?:this|event|currentTarget|target)\b/.test(x.inline));
    }
    return false;
  }
  function poSaveControlCandidates(doc=document) {
    const allowed=/^(Create|Save|Update) and Continue Editing$/i;
    let controls=[...doc.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button]')].filter(poSaveControlEnabled).filter(el=>allowed.test(poSaveControlLabel(el)));
    // A nested icon/span with role=button may duplicate its native control.
    const native=el=>['BUTTON','A','INPUT'].includes(el.tagName);
    controls=controls.filter(el=>native(el)||!controls.some(other=>native(other)&&(other.contains?.(el)||el.contains?.(other))));
    return controls;
  }
  function diagnosePoSaveControls(doc=document) {
    const nodes=[...doc.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button]')].filter(el=>!el.closest?.('#qpoRoot')).filter(el=>/\b(?:create|save|update|continue)\b/i.test(poSaveControlLabel(el))).slice(0,30);
    const matched=poSaveControlCandidates(doc);
    // Do not print URLs, inline handler code or form data: those can contain credentials.
    const report=nodes.map((el,index)=>{const spec=poSaveControlSpec(el);return{index,tag:el.tagName,label:poSaveControlLabel(el).slice(0,120),visible:!!poUploadElementVisible(el),enabled:!!poSaveControlEnabled(el),classes:String(el.className||'').slice(0,120),type:spec.type,hasForm:!!spec.form,hasInlineHandler:!!spec.inline,continuationMatch:matched.includes(el),equivalentTo:matched.map((other,n)=>other!==el&&poEquivalentSaveControls(el,other)?n:null).filter(n=>n!==null)};});
    log('Save control check v2.06 (read-only): '+JSON.stringify({continuationMatches:matched.length,controls:report}));
    return report;
  }
  function findPoSaveControl(doc=document) {
    const controls=poSaveControlCandidates(doc);
    if(controls.length&&controls.every(el=>el===controls[0]||poEquivalentSaveControls(controls[0],el))){
      if(controls.length>1)log('Found '+controls.length+' equivalent continuation toolbar controls; using one once.');
      return{element:controls[0],action:poSaveControlLabel(controls[0])};
    }
    try{diagnosePoSaveControls(doc);}catch(error){log('Save control diagnostics could not finish: '+error.message);}
    throw Error('Could not identify one enabled Create/Save and Continue Editing action ('+controls.length+' candidate(s)). No automatic save was attempted. Use Check save controls and send its log.');
  }
  function poUploadElementVisible(el) {
    if(!poSaveVisible(el))return false;
    // Bootstrap .fade keeps its layout box at opacity 0. getClientRects alone
    // therefore cannot distinguish this idle uploader from an active upload.
    for(let current=el;current;current=current.parentElement){
      let style=null;
      try{
        const reader=current.ownerDocument?.defaultView?.getComputedStyle;
        style=reader?reader.call(current.ownerDocument.defaultView,current):typeof getComputedStyle==='function'?getComputedStyle(current):null;
      }catch{}
      if(style&&(style.display==='none'||['hidden','collapse'].includes(style.visibility)||style.opacity!==''&&style.opacity!=null&&Number(style.opacity)===0))return false;
      if(!style){
        const classes=String(current.className?.baseVal||current.className||'').split(/\s+/);
        if(classes.includes('fade')&&!classes.includes('in')&&!classes.includes('show'))return false;
      }
      if(['BODY','HTML'].includes(current.tagName))break;
    }
    return true;
  }

  function uploadedPoFiles(files,doc=document) {
    if(!files.length)return true;
    const names=files.map(f=>f.name);
    if(new Set(names).size!==names.length)return false;
    const text=el=>String(el?.textContent||'').replace(/\s+/g,' ').trim();
    const enabled=el=>poUploadElementVisible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.closest?.('.disabled,.k-disabled,.k-state-disabled');
    const incomplete=el=>Array.from(el.querySelectorAll?.('.k-file-error,.k-file-progress,[aria-busy="true"],[data-upload-status="pending"],[data-upload-status="uploading"],[data-upload-status="error"]')||[]).some(poUploadElementVisible)||/\b(?:uploading|queued|pending upload|upload failed|upload error|retry upload|cancel upload)\b/i.test(text(el));
    // Pending uploads anywhere on this PO must finish even if a card with the
    // same name was already present before the current upload began.
    const pending=[...doc.querySelectorAll('.k-file-progress,.k-file-error,.fileupload-progress,.fileupload-error,[data-upload-status="pending"],[data-upload-status="uploading"],[data-upload-status="error"]')].filter(poUploadElementVisible);
    if(pending.length)return false;
    const successes=[...doc.querySelectorAll('.k-file-success,[data-upload-status="success"],[data-status="uploaded"]')].filter(poUploadElementVisible);
    const downloads=[...doc.querySelectorAll('a,button,input[type=button],[role=button]')].filter(enabled).filter(el=>/^(?:download|download file)$/i.test(el.tagName==='INPUT'?el.value:text(el)));
    const hasKendoSuccess=name=>successes.some(el=>{
      if(incomplete(el))return false;
      const displayed=[el.getAttribute('data-file-name'),...Array.from(el.querySelectorAll('.k-file-name,[title]')).map(n=>n.getAttribute('title')||n.textContent)].filter(Boolean).map(s=>s.trim());
      return displayed.includes(name);
    });
    const hasFileCard=file=>downloads.some(download=>{
      const href=String(download.getAttribute('href')||'');if(/^(?:blob|data):/i.test(href))return false;
      // Nexvia's Files panel renders Name + Size + Download + Remove cards,
      // not Kendo upload success rows. Walk only the local card ancestors.
      for(let card=download.parentElement,depth=0;card&&depth<6;card=card.parentElement,depth++){
        if(!poUploadElementVisible(card)||['BODY','HTML'].includes(card.tagName))break;
        if(incomplete(card))continue;
        const actions=[...card.querySelectorAll('a,button,input[type=button],[role=button]')].filter(enabled);
        const label=el=>el.tagName==='INPUT'?String(el.value||'').trim():text(el);
        if(actions.filter(el=>/^(?:download|download file)$/i.test(label(el))).length!==1||actions.filter(el=>/^(?:remove|remove file)$/i.test(label(el))).length!==1)continue;
        const content=text(card),size=content.match(/\bSize\s*:\s*(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)\b/i);
        if(!/\bName\s*:/i.test(content)||!size)continue;
        const links=[...card.querySelectorAll('a,.k-file-name,[data-file-name]')].filter(poUploadElementVisible);
        const matching=links.filter(el=>(el.getAttribute('data-file-name')||text(el)).trim()===file.name);
        if(matching.length!==1||matching.some(el=>/^(?:blob|data):/i.test(String(el.getAttribute('href')||''))))continue;
        if(Number.isFinite(file.size)){
          const amount=Number(size[1].replace(',','.')),places=(size[1].split(/[.,]/)[1]||'').length,power=['B','KB','MB','GB'].indexOf(size[2].toUpperCase());
          const agrees=[1000,1024].some(base=>Math.abs(file.size-amount*base**power)<=.5*10**(-places)*base**power+1);
          if(!agrees)continue;
        }
        return true;
      }
      return false;
    });
    return files.every(file=>hasKendoSuccess(file.name)||hasFileCard(file));
  }
  function diagnosePoUploads(files=Array.from($('qfile')?.files||[]),doc=document) {
    if(!files.length){log('Attachment check: select the same PDF in the script first, then click Check attachments. This does not upload it or add PO lines.');return;}
    const clipped=(s,n=120)=>String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
    const visible=el=>poUploadElementVisible(el);
    const enabled=el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.closest?.('.disabled,.k-disabled,.k-state-disabled');
    const label=el=>clipped(el.tagName==='INPUT'?el.value:el.textContent||el.getAttribute('aria-label')||el.getAttribute('title'));
    const brief=el=>({tag:el.tagName,classes:clipped(el.className),visible:!!visible(el),disabled:!enabled(el)});
    const controls=[...doc.querySelectorAll('a,button,input[type=button],[role=button]')].filter(el=>!el.closest?.('#qpoRoot'));
    const downloads=controls.filter(el=>/download/i.test(label(el))&&label(el).length<100).slice(0,12);
    const pending=[...doc.querySelectorAll('.k-file-progress,.k-file-error,.fileupload-progress,.fileupload-error,[data-upload-status="pending"],[data-upload-status="uploading"],[data-upload-status="error"]')].filter(visible).slice(0,10);
    log('Attachment check v2.06 (read-only): '+JSON.stringify({files:files.map(f=>({name:f.name,bytes:f.size})),downloadControls:downloads.map(el=>({...brief(el),label:label(el)})),pendingMarkers:pending.map(brief)}));
    if(!downloads.some(visible))log('Attachment check: no visible Download file card found. Open Nexvia Files and confirm the PDF is attached. Use Attach now only if it is absent; do not add PO lines again.');
    for(const [index,button] of downloads.filter(visible).entries()){
      const candidates=[];
      for(let card=button.parentElement,depth=0;card&&depth<10;card=card.parentElement,depth++){
        if(['BODY','HTML'].includes(card.tagName))break;
        const text=String(card.textContent||'').replace(/\s+/g,' ').trim();
        const actions=[...card.querySelectorAll('a,button,input[type=button],[role=button]')].filter(enabled);
        const size=text.match(/\bSize\s*:\s*(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)\b/i);
        const links=[...card.querySelectorAll('a,.k-file-name,[data-file-name],[title]')].filter(visible);
        candidates.push({...brief(card),depth,hasNameLabel:/\bName\s*:/i.test(text),sizeLabel:size?size[0]:null,downloads:actions.filter(el=>/^(?:download|download file)$/i.test(label(el))).length,removes:actions.filter(el=>/^(?:remove|remove file)$/i.test(label(el))).length,
          files:files.map(file=>({name:file.name,exactNames:links.filter(el=>(el.getAttribute('data-file-name')||String(el.textContent||'')).trim()===file.name).length,titleNames:links.filter(el=>el.getAttribute('title')===file.name).length,sizeMatches:!Number.isFinite(file.size)||!size?null:[1000,1024].map(base=>{const power=['B','KB','MB','GB'].indexOf(size[2].toUpperCase()),amount=Number(size[1].replace(',','.')),places=(size[1].split(/[.,]/)[1]||'').length;return Math.abs(file.size-amount*base**power)<=.5*10**(-places)*base**power+1;})})),
          busy:!!card.querySelector('.k-file-error,.k-file-progress,[aria-busy="true"],[data-upload-status="pending"],[data-upload-status="uploading"],[data-upload-status="error"]'),statusText:/\b(?:uploading|queued|pending upload|upload failed|upload error|retry upload|cancel upload)\b/i.test(text)});
      }
      log('Attachment card '+(index+1)+': '+JSON.stringify(candidates));
    }
    const ready=uploadedPoFiles(files,doc);log('Attachment check result: '+(ready?'READY — selected PDFs matched the completion checks.':'NOT CONFIRMED — send the Attachment check and Attachment card log entries above. No save or upload was attempted.'));
    return ready;
  }

  function poSaveSuccessNotices(doc=document) {
    return [...doc.querySelectorAll('[role=status],[role=alert],.k-notification-success,.alert-success,.toast-success')].filter(poSaveVisible).map(el=>String(el.textContent||'').replace(/\s+/g,' ').trim()).filter(text=>/^(?:purchase order|po)(?:\s+[a-z0-9/\-]+)?\s+(?:was\s+)?(?:successfully\s+)?(?:created|saved|updated)(?:\s+successfully)?[.!]?$/i.test(text));
  }
  function persistPoSaveAttempt() {
    // Persist before clicking: a redirect or reload must never repeat Create.
    if(poSaveAttempt)sessionStorage.setItem(PO_SAVE_KEY,JSON.stringify(poSaveAttempt));else sessionStorage.removeItem(PO_SAVE_KEY);
  }
  function poSaveStatus(message){if($('qposavestatus'))$('qposavestatus').textContent=message;log(message);}
  function collectSavedPoNumber() {
    if(registerDraft?.payload||validationError())return false;
    if(!poSaveAttempt||poSaveAttempt.origin!==location.origin||Date.now()-poSaveAttempt.startedAt>600000)return false;
    const number=gatherRegisterPageDetails().poNumber;
    if(!number)return false;
    let actual;try{actual=poSaveRows();}catch{return false;}
    if(!samePoSaveRows(poSaveAttempt.rows,actual))return false;
    // An assigned number after Create provides useful UI evidence. An existing
    // number after Save is only collected; it does not prove the update persisted.
    if(!poSaveAttempt.beforeNumber&&/^Create /i.test(poSaveAttempt.action)&&number!==poSaveAttempt.beforeNumber){
      poSaveAttempt.outcome='number-collected';
    }else if(poSaveAttempt.beforeNumber&&number===poSaveAttempt.beforeNumber){
      poSaveAttempt.outcome='existing-number';
    }else return false;
    const field=$('qregisterpo'),current=field.value.trim();
    if(!current||current===poSaveAttempt.beforeNumber){field.value=number;if(registerDraft&&!registerDraft.payload)registerDraft.poNumber=number;persistRegisterDraft();}
    else if(current!==number){poSaveStatus('Nexvia Order Number is '+number+', but the register contains a different PO number. Review it manually.');return false;}
    if(!poSaveAttempt.beforeNumber&&/^Create /i.test(poSaveAttempt.action)){
      poSaveAttempt.createdDate=poSaveAttempt.createdDate||registerBusinessDate();poSaveAttempt.createdPoNumber=number;
      applyRegisterCreatedDate({date:poSaveAttempt.createdDate,source:'automatic-create'});
    }
    persistPoSaveAttempt();
    if($('qregistersaved'))$('qregistersaved').checked=false;
    autofillRegisterDetails();
    poSaveStatus('Nexvia Order Number collected: '+number+'. Completing automatic register recording when enabled.');
    return true;
  }
  let autoRegisterRunning=false;
  async function autoRecordCreatedPo() {
    if(autoRegisterRunning||!$('qregisterenabled')?.checked||!registerDraft)return false;
    if(!poSaveAttempt||poSaveAttempt.outcome!=='number-collected'||poSaveAttempt.beforeNumber||!/^Create /i.test(poSaveAttempt.action))return false;
    if(validationError()||gatherRegisterPageDetails().poNumber!==poSaveAttempt.createdPoNumber||!samePoSaveRows(poSaveAttempt.rows,poSaveRows()))return false;
    autoRegisterRunning=true;
    try {
      $('qregistersaved').checked=true;
      await recordRegisterDraft();
      poSaveAttempt.registerRecorded=true;persistPoSaveAttempt();
      poSaveStatus('PO created and invoice register recorded successfully.');
      return true;
    } catch(error) {
      $('qregistersaved').checked=false;
      const message='PO created, but register not confirmed: '+error.message+' Use Record / retry register after checking the details. Do not create the PO again.';
      poSaveStatus(message);if($('qregisterstatus'))$('qregisterstatus').textContent=message;
      return false;
    } finally {autoRegisterRunning=false;syncRegisterLocks();}
  }
  async function checkRoundingService(lines) {
    const groups=new Map();
    for(const i of lines.filter(i=>i.roundingNote)){
      if(!i.roundingOriginal||['description','quantity','unitCost'].some(k=>i[k]!==i.roundingOriginal[k]))throw Error('A corrected-total preview was edited. Read the PDF again before applying its rounding adjustment.');
      const key=(i.supplierRef||'')+'|'+i.roundingNote;groups.set(key,[...(groups.get(key)||[]),i]);
    }
    for(const group of groups.values())if(group.some(i=>i.roundingExpectedCount!==group.length))throw Error('A corrected-total preview has missing lines. Read the PDF again before applying its adjustment.');
    if(!lines.some(i=>i.roundingNote)||!$('qregisterenabled')?.checked)return;
    const endpoint=new URL(aiEndpoint($('qaiurl').value.trim()));endpoint.pathname='/register/features';
    let response;try{response=await fetch(endpoint.href,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000)});}catch{throw Error('Update or reconnect the NAS backend before adding corrected totals. No PO lines were added.');}
    let data;try{data=await response.json();}catch{}
    if(!response.ok||data?.roundingAudit!==true)throw Error('Update the NAS backend to v2.06 before adding corrected totals; it must preserve the rounding audit. No PO lines were added.');
  }
  async function autoSavePoAfterChecks(files=[]) {
    if(!$('qpoautosave')?.checked)return false;
    if(poSaveRestoreUnsafe)throw Error('The previous save guard could not be read. Check Nexvia, then clear the save guard manually before trying again.');
    if(poSaveAttempt)throw Error('An earlier automatic save is recorded. Check Nexvia and use Collect Order Number; the script will not click Create/Save again.');
    const rows=poSaveRows(),beforeNumber=gatherRegisterPageDetails().poNumber||'';
    if(validationError())throw Error('Nexvia has a validation error. Automatic save was stopped.');
    if(files.length){
      poSaveStatus('Waiting for attached PDFs to finish uploading before saving…');
      let uploaded=false;for(let n=0;n<60;n++){if(uploadedPoFiles(files)){uploaded=true;break;}await sleep(500);}
      if(!uploaded){try{diagnosePoUploads(files);}catch(error){log('Attachment diagnostics could not finish: '+error.message);}}
      if(!uploaded)throw Error('PDF upload completion could not be confirmed. Check the upload and save this PO manually; no automatic save was attempted.');
    }
    // Check again after any upload wait; all rows and their account codes must
    // still be the ones that passed the line workflow.
    if(validationError()||!samePoSaveRows(rows,poSaveRows()))throw Error('The PO changed before saving. Review it and save manually.');
    const control=findPoSaveControl();
    if(/^Create /i.test(control.action)&&beforeNumber)throw Error('This PO already has an Order Number but Nexvia shows Create. Check it manually; automatic creation was stopped.');
    if(!/^Create /i.test(control.action)&&!beforeNumber)throw Error('The existing PO Order Number could not be identified. Save manually.');
    poSaveAttempt={version:1,origin:location.origin,startedAt:Date.now(),scope:poWorkflowScope(),beforeNumber,action:control.action,rows,outcome:'unconfirmed',noticesBefore:poSaveSuccessNotices()};
    try{persistPoSaveAttempt();}catch{poSaveAttempt=null;throw Error('The browser cannot retain the save attempt across navigation. Save manually.');}
    poSaveStatus('Clicking Nexvia '+control.action+' once. Waiting for the Order Number…');
    control.element.click();
    for(let n=0;n<60;n++){
      if(validationError()){poSaveStatus('Nexvia reported a validation error after the save attempt. Check the PO; automatic saving will not be retried.');return false;}
      const saveNotice=poSaveSuccessNotices().some(text=>!poSaveAttempt.noticesBefore.includes(text));
      if((!beforeNumber||saveNotice)&&collectSavedPoNumber()){await autoRecordCreatedPo();return true;}
      await sleep(500);
    }
    poSaveStatus('Save result could not be confirmed. Check Nexvia and use Collect Order Number after it loads. Do not repeat Create without checking.');
    return false;
  }
  function initPoSave(runBusy) {
    try{
      const raw=sessionStorage.getItem(PO_SAVE_KEY),attempt=raw?JSON.parse(raw):null;
      if(attempt&&attempt.version===1&&attempt.origin===location.origin&&Number.isFinite(attempt.startedAt)&&Array.isArray(attempt.rows)&&attempt.rows.length>0&&attempt.rows.length<1000)poSaveAttempt=attempt;
      else if(attempt)poSaveRestoreUnsafe=true;
    }catch{poSaveRestoreUnsafe=true;poSaveStatus('The previous save attempt could not be read. Check Nexvia before saving again.');}
    // Add lines is the user's reviewed instruction to complete this PO.
    $('qpoautosave').checked=true;
    $('qsavecontrolcheck').onclick=()=>runBusy($('qsavecontrolcheck'),'Checking…',async()=>{try{diagnosePoSaveControls();}catch(error){log('Save control check failed: '+error.message);}});
    $('qattachmentcheck').onclick=()=>runBusy($('qattachmentcheck'),'Checking…',async()=>{try{diagnosePoUploads();}catch(error){log('Attachment check failed: '+error.message);}});
    $('qposavecollect').onclick=()=>runBusy($('qposavecollect'),'Collecting…',async()=>{
      if(poSaveAttempt){if(collectSavedPoNumber())await autoRecordCreatedPo();else poSaveStatus('No matching saved PO number could be collected. Check Nexvia and the PO rows manually.');}
      else{autofillRegisterDetails(true);poSaveStatus('Collected available Nexvia details. Review the PO number and confirm Save/Create separately.');}
    });
    $('qposavereset').onclick=()=>{
      if(busy)return;
      if(confirm('Clear the automatic-save guard only after checking Nexvia for an existing saved PO. This does not undo a save or delete a PO. Continue?')){poSaveAttempt=null;poSaveRestoreUnsafe=false;persistPoSaveAttempt();poSaveStatus('Save guard cleared. Check the current PO and enable automatic saving only if needed.');$('qpoautosave').checked=false;}
    };
    if(poSaveAttempt){
      poSaveStatus('A previous save attempt was retained. It will not be clicked again. Collect the Order Number or check Nexvia manually.');
      // Page widgets may load after the userscript mounts. Collection is read-only.
      void(async()=>{for(let n=0;n<20;n++){try{if(collectSavedPoNumber()){await autoRecordCreatedPo();return;}}catch(error){poSaveStatus('Automatic completion could not finish: '+error.message);return;}await sleep(500);}})();
    }
  }

  // Register dates refer to PO creation, never a supplier invoice or due date.
  function registerBusinessDate(timestamp=Date.now()) {
    const parts=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));
    const value=type=>parts.find(p=>p.type===type).value;
    return value('year')+'-'+value('month')+'-'+value('day');
  }
  function registerIsNewPoPage(doc=document) {
    let details;try{details=gatherRegisterPageDetails(doc);}catch{return false;}
    if(details.poNumber)return false;
    return [...doc.querySelectorAll('h1,h2,[role=heading],.page-title')].some(el=>
      !el.closest?.('#qpoRoot,[hidden],[aria-hidden="true"]')&&(!el.getClientRects||el.getClientRects().length)&&/^new purchase order(?:\s*[-–—]|$)/i.test(String(el.textContent||'').replace(/\s+/g,' ').trim()));
  }
  function registerCreatedDateInfo() {
    let details={};try{details=gatherRegisterPageDetails();}catch{}
    if(details.poCreatedDate)return{date:details.poCreatedDate,source:'nexvia'};
    if(typeof poSaveAttempt!=='undefined'&&poSaveAttempt?.createdDate&&poSaveAttempt.createdPoNumber===details.poNumber)return{date:poSaveAttempt.createdDate,source:'automatic-create'};
    return registerIsNewPoPage()?{date:registerBusinessDate(),source:'pending-create'}:{date:'',source:'unknown'};
  }
  function applyRegisterCreatedDate(info) {
    if(!registerDraft||registerDraft.payload||registerDraft.dateKind!=='poCreated'||!info.date)return;
    for(const [n,doc] of registerDraft.documents.entries()){
      // A pending date changes when creation crosses midnight; an explicitly
      // edited date is retained for review.
      if(!doc.date||doc.dateSource==='pending-create'){
        doc.date=info.date;doc.dateSource=info.source;
        const field=$('qregdoc'+n+'date');if(field)field.value=info.date;
      }
    }
    persistRegisterDraft();
  }
  function migrateRegisterCreatedDateDraft() {
    if(!registerDraft||registerDraft.payload||registerDraft.dateKind)return;
    const info=registerCreatedDateInfo();registerDraft.dateKind='poCreated';
    for(const doc of registerDraft.documents){doc.date=info.date;doc.dateSource=info.source;}
    persistRegisterDraft();
    log('Pending draft now uses PO created date; the previous invoice date was not reused. Existing NAS records are unchanged.');
  }

  // Read metadata as data only: exact labels, visible page fields and printed PDF headers.
  const registerFileMetadata = new WeakMap();
  let registerAutoJob='';
  function registerCleanValue(value,max=180) {
    const text=String(value??'').replace(/\s+/g,' ').trim();
    return !text||text.length>max||/[<>\x00-\x1f]/.test(text)||/^(?:select|choose|search)(?:\s|\.{2}|$)|^(?:new|draft|not assigned|n\/a|none|undefined|null)$/i.test(text)?'':text;
  }
  function registerLabelRole(text) {
    const s=String(text||'').toLowerCase().replace(/[.*:#]/g,'').replace(/\s+/g,' ').trim();
    if(/^(supplier|supplier name|vendor|vendor name|company name)$/.test(s))return 'supplier';
    if(/^(po created date|created date|date created|created on|creation date)$/.test(s))return 'poCreatedDate';
    if(/^(job|job name|job number|job no|project|project name|project number|project no)$/.test(s))return 'job';
    if(/^(po|po number|po no|p o number|p o no|purchase order number|purchase order no|order number|order no)$/.test(s))return 'poNumber';
    return '';
  }
  function gatherRegisterPageDetails(doc=document) {
    const found={supplier:[],job:[],poNumber:[],poCreatedDate:[]};
    const visible=el=>!!el&&!el.closest?.('#qpoRoot,[hidden],[aria-hidden="true"]')&&(!el.getClientRects||el.getClientRects().length>0);
    const read=el=>{
      if(!el||el.type==='password'||el.type==='checkbox')return '';
      const wrapper=el.closest?.('.k-widget,.k-dropdownlist,.k-dropdown,.k-combobox');
      if(!visible(el)&&!visible(wrapper))return '';
      // Kendo dropdowns expose the selected display text through text(), not value().
      try{if(typeof widgetIn==='function'){const w=widgetIn(wrapper||el);if(w&&typeof w.text==='function')return registerCleanValue(w.text());}}catch{}
      if(el.type==='hidden')return '';
      if(el.tagName==='SELECT')return registerCleanValue(el.selectedIndex>=0?el.options[el.selectedIndex]?.text:'');
      if(el.matches?.('input,textarea'))return registerCleanValue(el.value);
      if(el.querySelectorAll?.('input,select,textarea').length)return '';
      return registerCleanValue(el.textContent);
    };
    const add=(role,el)=>{if(role){const raw=read(el),value=role==='poCreatedDate'?registerInvoiceDate(raw.replace(/(?:T|\s)\d{1,2}:\d{2}.*$/,'')):raw;if(value&&!(role==='poNumber'&&/^(?:0|new\b.*|create\b.*|draft\b.*|pending\b.*)$/i.test(value)))found[role].push(value);}};
    for(const label of doc.querySelectorAll('label,dt,th,.control-label,.form-label,.field-label')){
      if(!visible(label))continue;
      const role=registerLabelRole(label.textContent);if(!role)continue;
      const id=label.getAttribute('for');
      if(id){add(role,doc.getElementById(id));continue;}
      const nested=label.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox]');
      if(nested.length===1){add(role,nested[0]);continue;}
      const next=label.nextElementSibling;
      if(next&&/^(INPUT|SELECT|TEXTAREA|SPAN|STRONG|DD|TD|DIV)$/.test(next.tagName)){
        const controls=next.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox]');
        if(controls.length===1)add(role,controls[0]);else if(!controls.length&&!registerLabelRole(next.textContent))add(role,next);
      }
    }
    for(const el of doc.querySelectorAll('input[aria-label],select[aria-label],textarea[aria-label],[role=combobox][aria-label],input[aria-labelledby],select[aria-labelledby],[role=combobox][aria-labelledby]')){
      if(!visible(el))continue;
      let label=el.getAttribute('aria-label');
      if(!label){const ids=(el.getAttribute('aria-labelledby')||'').trim().split(/\s+/);if(ids.length===1){const linked=doc.getElementById(ids[0]);if(visible(linked))label=linked.textContent;}}
      add(registerLabelRole(label),el);
    }
    // Nexvia shows the project in its page heading, e.g.
    // "New Purchase Order - LN0867 - Milton Green Hotel".
    // Use it only when there is no explicitly labelled job, and never treat the
    // LN project reference as the PO Order Number.
    if(!found.job.length){
      const headings=[...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],.page-title,.page-header,.content-header,.content-header-title')].filter(visible).map(el=>{
        const title=String(el.textContent||'').replace(/\s+/g,' ').trim();
        if(!/^(?:(?:new|edit|view)\s+)?purchase order\b/i.test(title))return {el,value:''};
        const coded=title.match(/\b(LN\d{3,12}\s*[-–—]\s*.+)$/i);
        const plain=title.match(/^(?:(?:new|edit|view)\s+)?purchase order\s*[-–—]\s*(.+)$/i);
        let value=coded?coded[1]:plain?plain[1]:'';
        if(!coded&&value){
          const leading=value.match(/^((?:PO[-/]?)?\d+)\s*(?:[-–—]\s*(.*))?$/i);
          if(leading){
            const orderNumbers=[...new Set(found.poNumber.map(n=>n.toLowerCase()))];
            value=orderNumbers.length===1&&orderNumbers[0]===leading[1].toLowerCase()?leading[2]||'':'';
          }
        }
        if(/^(?:new|create|edit|view|details)$/i.test(value))value='';
        return {el,value:registerCleanValue(value)};
      }).filter(h=>h.value);
      // Prefer the actual title over an enclosing header with toolbar text.
      for(const heading of headings.filter(h=>!headings.some(other=>other!==h&&h.el.contains?.(other.el))))found.job.push(heading.value);
    }
    const result={};
    for(const [key,values] of Object.entries(found)){
      const unique=[...new Map(values.map(v=>[v.toLowerCase(),v])).values()];
      if(unique.length===1)result[key]=unique[0];
    }
    return result;
  }
  function registerInvoiceDate(value) {
    let y,m,d;const s=String(value||'').trim();let match;
    if((match=s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))[,y,m,d]=match;
    else if((match=s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/)))[,d,m,y]=match;
    else if((match=s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/))){
      [,d,m,y]=match;const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
      const index=months.findIndex(name=>m.toLowerCase()===name||m.toLowerCase()===name.slice(0,3));if(index<0)return '';m=index+1;
    }else return '';
    const iso=String(y)+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'),date=new Date(iso+'T12:00:00Z');
    return Number(y)>=1900&&Number(y)<=2199&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:'';
  }
  function extractRegisterPdfMetadata(all) {
    const candidates={date:[],invoiceNumber:[],supplier:[],documentReference:[]};
    const roles={date:/^(?:tax\s+)?invoice\s+date\s*:?$/i,invoiceNumber:/^(?:tax\s+)?invoice\s*(?:number|no\.?|#)\s*:?$/i,supplier:/^(?:supplier|supplier name|vendor|issued by)\s*:?$/i,documentReference:/^(?:(?:sales\s+)?order|quote|quotation)\s*(?:number|no\.?|#)\s*:?$/i};
    // Group each page independently so repeated headers cannot mix across pages.
    for(const page of new Set(all.map(i=>i.page))){
      const fragments=all.filter(i=>i.page===page),rows=[];
      for(const i of [...fragments].sort((a,b)=>b.y-a.y||a.x-b.x)){const row=rows.find(r=>Math.abs(r.y-i.y)<2);if(row)row.items.push(i);else rows.push({y:i.y,items:[i]});}
      for(const row of rows){
        row.items.sort((a,b)=>a.x-b.x);
        for(const [n,item] of row.items.entries())for(const [role,re] of Object.entries(roles)){
          const text=String(item.s).trim();let value='';
          if(re.test(text)){
            const right=row.items.slice(n+1);
            // Stop at another labelled field, not at a value in the next column.
            const stop=right.findIndex(i=>/:\s*$/.test(i.s)||Object.values(roles).some(r=>r.test(i.s)));
            value=(stop<0?right:right.slice(0,stop)).map(i=>i.s).join(' ');
          }else{
            const inline=text.match(/^((?:tax\s+)?invoice\s+date|(?:tax\s+)?invoice\s*(?:number|no\.?|#)|supplier(?: name)?|vendor|issued by|(?:(?:sales\s+)?order|quote|quotation)\s*(?:number|no\.?|#))\s*:\s*(.+)$/i);
            if(inline&&re.test(inline[1]))value=inline[2];
          }
          value=role==='date'?registerInvoiceDate(value):registerCleanValue(value,role==='invoiceNumber'?100:180);
          if(['invoiceNumber','documentReference'].includes(role)&&!/^[A-Za-z0-9][A-Za-z0-9._/\-]{0,99}$/.test(value))value='';
          if(value)candidates[role].push(value);
        }
      }
    }
    const result={};for(const [key,values] of Object.entries(candidates)){const unique=[...new Map(values.map(v=>[v.toLowerCase(),v])).values()];if(unique.length===1)result[key]=unique[0];}
    return result;
  }
  function registerMetadataForLines(lines) {
    const files=Array.from($('qfile')?.files||[]),names=[...new Set(lines.map(i=>i.sourceName).filter(Boolean))];
    const file=files.length===1?files[0]:names.length===1&&files.filter(f=>f.name===names[0]).length===1?files.find(f=>f.name===names[0]):null;
    return file?registerFileMetadata.get(file)||{}:{};
  }
  function autofillRegisterDetails(report=false) {
    if(registerDraft?.payload){if(report)$('qregisterautostatus').textContent='A register request is pending. Its details stay locked for a safe retry.';return;}
    let details={};try{details=gatherRegisterPageDetails();}catch{}
    const filled=[];
    for(const [key,id,label] of [['supplier','qregistersupplier','supplier'],['job','qregisterjob','job'],['poNumber','qregisterpo','PO number']]){
      const field=$(id);if(!field||!details[key])continue;
      const current=field.value.trim();
      const refreshJob=key==='job'&&(report||!!registerAutoJob&&current===registerAutoJob);
      if(current&&!refreshJob)continue;
      const changed=key==='job'&&!!current&&current!==details[key];
      field.value=details[key];
      if(!current||changed)filled.push(label);
      if(key==='job'){
        registerAutoJob=details[key];
        if(changed){
          if($('qregistersaved'))$('qregistersaved').checked=false;
          if(registerDraft){registerDraft.verification='stale';if($('qregistersaved'))$('qregistersaved').disabled=true;if($('qregisterstatus'))$('qregisterstatus').textContent='Project changed. Read/compare the current PO again before recording.';}
        }
      }
      if(registerDraft&&key!=='supplier'){registerDraft[key]=details[key];if(key==='job')registerDraft.jobSource='nexvia';}
    }
    if(registerDraft){
      for(const [n,d] of registerDraft.documents.entries())if(!d.supplier&&details.supplier){d.supplier=details.supplier;const field=$('qregdoc'+n+'supplier');if(field)field.value=details.supplier;}
      applyRegisterCreatedDate(registerCreatedDateInfo());
      persistRegisterDraft();
    }
    const status=$('qregisterautostatus');if(status&&(report||filled.length))status.textContent=filled.length?'Filled from Nexvia: '+filled.join(', ')+'. Review before recording.':'No additional unambiguous page fields found. Existing entries were kept; fill any missing details manually.';
  }

  // Register entries remain separate from PO edits and paid AI requests.
  let registerDraft = null;
  const registerMoney = v => '$'+v.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  const REGISTER_DRAFT_KEY = 'qpoRegisterDraftV1';
  function registerSnapshot(lines, live) {
    if (!lines.length) throw new Error('Read an invoice first.');
    const compared = compareAppendInvoice(lines, live).filter(r => r.inv);
    if (compared.length !== lines.length || compared.some(r => r.status !== 'same' || !r.po)) throw new Error('Every invoice line must match the current PO, including its supplier reference. Partial invoices cannot be registered.');
    return compared.map(r => {
      const tax = String(r.po.tax || '').trim(), acct = String(r.po.acct || '').trim();
      if (!acct || !['GST Applied','No GST Applied'].includes(tax)) throw new Error('Each saved PO line needs an Acct# and an explicit GST setting.');
      return {description:r.inv.description,quantity:r.po.quantity,unitCost:r.po.unitCost,amount:r.po.amount,supplierRef:r.inv.supplierRef,tax,acct,...(r.inv.roundingNote?{roundingNote:r.inv.roundingNote}:{})};
    });
  }
  function registerAllocations(lines) {
    const accounts = new Map();
    for (const line of lines) {
      if (!Number.isFinite(line.amount) || line.amount < 0) throw new Error('Invalid register amount.');
      const net = Math.round(line.amount*100), gst = line.tax==='GST Applied'?Math.round((line.amount*.1+Number.EPSILON)*100):0;
      const key=normalizedText(line.acct),a=accounts.get(key)||{account:line.acct,net:0,gst:0,total:0};
      a.net+=net;a.gst+=gst;a.total+=net+gst;accounts.set(key,a);
    }
    return [...accounts.values()].map(a=>({...a,net:a.net/100,gst:a.gst/100,total:a.total/100}));
  }
  function persistRegisterDraft() {
    // Session-only: invoice details are retained across Nexvia's Save navigation.
    // Never store API keys or the service token in the draft.
    try { if(registerDraft)sessionStorage.setItem(REGISTER_DRAFT_KEY,JSON.stringify(registerDraft));else sessionStorage.removeItem(REGISTER_DRAFT_KEY); }
    catch { log('The browser could not retain the register draft across refreshes. Keep this tab open until it is recorded.'); }
  }
  function showRegisterDraft() {
    const box=$('qregisterdraft');if(!box)return;box.replaceChildren();
    $('qregistersaved').checked=false;
    if(!registerDraft){$('qregisterstatus').textContent='No pending entry. After applying invoice lines, save the PO in Nexvia, then record it here.';return;}
    $('qregisterjob').value=registerDraft.job||'';$('qregisterpo').value=registerDraft.poNumber||'';
    for(const [n,doc] of registerDraft.documents.entries()){
      const row=document.createElement('div');row.style.cssText='padding:10px 0;border-bottom:1px solid #ddd';
      const title=document.createElement('strong');title.textContent=doc.reference+' — '+registerMoney(doc.lines.reduce((s,i)=>s+i.amount,0))+' ex GST';row.append(title);
      for(const [key,label,type] of [['supplier','Supplier','text'],['invoiceNumber','Invoice number','text'],['date',registerDraft.dateKind==='poCreated'?'PO created date':'Invoice date (legacy request)','date']]){
        const l=document.createElement('label');l.className='f';l.textContent=label;
        const input=document.createElement('input');input.type=type;input.id='qregdoc'+n+key;input.value=doc[key]||'';input.maxLength=key==='invoiceNumber'?100:180;input.disabled=!!registerDraft.payload;
        input.oninput=()=>{doc[key]=input.value;if(key==='invoiceNumber')doc.numberSource='manual';if(key==='date')doc.dateSource='manual';persistRegisterDraft();};l.append(input);if(key==='invoiceNumber'&&['documentReference','supplierRef','unknown'].includes(doc.numberSource)){const hint=document.createElement('small');hint.textContent='No printed invoice number identified. This is the document/Supplier Ref; check it before recording an invoice.';l.append(hint);}row.append(l);
      }
      if(doc.lines.some(i=>i.roundingNote)){const audit=document.createElement('p');audit.textContent=[...new Set(doc.lines.map(i=>i.roundingNote).filter(Boolean))].join(' ');row.append(audit);}
      const detail=document.createElement('small');detail.textContent=['preview','stale'].includes(registerDraft.verification)?'Read preview — Acct# and PO allocations will be checked after applying or matching these lines.':registerAllocations(doc.lines).map(a=>a.account+': '+registerMoney(a.net)+' ex GST + '+registerMoney(a.gst)+' GST').join('; ');row.append(detail);box.append(row);
    }
    $('qregisterjob').disabled=$('qregisterpo').disabled=!!registerDraft.payload;
    $('qregisterstatus').textContent=registerDraft.payload?'Register request pending. Retry uses the same details to prevent duplicates.':['preview','stale'].includes(registerDraft.verification)?'Latest read preview. Apply its lines or Prepare from matched preview before recording.':'PO rows checked. Check the details below and Save/Create in Nexvia before recording.';
    $('qregisterdetails').open=true;
  }
  function invalidateRegisterRead() {
    if(!registerDraft||registerDraft.payload)return;
    registerDraft.verification='stale';
    if($('qregistersaved'))$('qregistersaved').checked=false;
    if($('qregisterstatus'))$('qregisterstatus').textContent='The PDF selection or read changed. Read it again and verify its lines before recording.';
    persistRegisterDraft();syncRegisterLocks();
  }
  function refreshRegisterFromRead(lines) {
    if(!$('qregisterenabled')?.checked)return;
    if(registerDraft?.payload){log('The latest PDF was read, but the pending register request was kept unchanged for safe retry. Finish that request before preparing another register entry.');return;}
    if(!lines.length)return;
    autofillRegisterDetails();
    const dateInfo=registerCreatedDateInfo(),groups=new Map();
    for(const line of lines){
      const reference=line.supplierRef||$('qref').value.trim(),key=normalizedText(reference)||line.sourceName||'single';
      if(!groups.has(key))groups.set(key,{reference,sourceName:line.sourceName||'',lines:[]});groups.get(key).lines.push(line);
    }
    const documents=[];let allVerified=true;
    for(const group of groups.values()){
      const meta=registerMetadataForLines(group.lines),reference=group.reference||meta.invoiceNumber||meta.documentReference||group.sourceName||'Reference needed';
      const incoming=group.lines.map(i=>({...i,supplierRef:group.reference,amount:Number.isFinite(i.amount)?i.amount:r2(i.quantity*i.unitCost)}));
      let snapshot;try{if(!group.reference)throw Error('Missing Supplier Ref');snapshot=registerSnapshot(incoming,readPoLines());}catch{allVerified=false;snapshot=incoming.map(i=>({description:i.description,quantity:i.quantity,unitCost:i.unitCost,amount:i.amount,supplierRef:group.reference,tax:i.tax||'',acct:'',...(i.roundingNote?{roundingNote:i.roundingNote}:{})}));}
      documents.push({reference,invoiceNumber:meta.invoiceNumber||meta.documentReference||group.reference||'',numberSource:meta.invoiceNumber?'invoice':meta.documentReference?'documentReference':group.reference?'supplierRef':'unknown',supplier:$('qregistersupplier').value.trim()||meta.supplier||'',date:dateInfo.date,dateSource:dateInfo.source,lines:snapshot});
    }
    registerDraft={version:1,dateKind:'poCreated',origin:location.origin,createdAt:Date.now(),job:$('qregisterjob').value.trim(),jobSource:$('qregisterjob').value.trim()===registerAutoJob?'nexvia':'manual',poNumber:$('qregisterpo').value.trim(),verification:allVerified?'verified':'preview',documents};
    persistRegisterDraft();showRegisterDraft();syncRegisterLocks();
    log('Register preview refreshed from the latest PDF read. '+(allVerified?'Its lines match the PO; review Save/Create and the register details.':'Apply the reviewed lines, or prepare from a matched preview, before recording.'));
  }

  function stageRegisterAfterPo(lines, force=false) {
    if(!force && !$('qregisterenabled')?.checked)return;
    try {
      if(registerDraft&&registerDraft.verification!=='preview'&&registerDraft.verification!=='stale')throw new Error('A register entry is already pending. Record or discard it before preparing another.');
      const previous=registerDraft?.verification==='preview'?registerDraft:null;
      const incoming=lines.map(i=>({...i,supplierRef:i.supplierRef||$('qref').value.trim()}));
      autofillRegisterDetails();
      const dateInfo=registerCreatedDateInfo();
      const snapshot=registerSnapshot(incoming,readPoLines()),groups=new Map();
      for(const i of snapshot){const key=normalizedText(i.supplierRef);if(!groups.has(key)){
        const meta=registerMetadataForLines(incoming.filter(line=>normalizedText(line.supplierRef)===key));
        const prior=previous?.documents.find(d=>normalizedText(d.reference)===key);
        groups.set(key,{reference:i.supplierRef,invoiceNumber:prior?.numberSource==='manual'?prior.invoiceNumber:meta.invoiceNumber||meta.documentReference||i.supplierRef,numberSource:prior?.numberSource==='manual'?'manual':meta.invoiceNumber?'invoice':meta.documentReference?'documentReference':'supplierRef',supplier:prior?.supplier||$('qregistersupplier').value.trim()||meta.supplier||'',date:prior?.dateSource==='manual'?prior.date:dateInfo.date,dateSource:prior?.dateSource==='manual'?'manual':dateInfo.source,lines:[]});
      }groups.get(key).lines.push(i);}
      registerDraft={version:1,dateKind:'poCreated',origin:location.origin,createdAt:Date.now(),job:$('qregisterjob').value.trim(),jobSource:$('qregisterjob').value.trim()===registerAutoJob?'nexvia':'manual',poNumber:$('qregisterpo').value.trim(),verification:'verified',documents:[...groups.values()]};
      persistRegisterDraft();showRegisterDraft();log('Register entry prepared. Automatic creation will collect the PO number and record this entry when enabled.');
    } catch(e) {log('Register draft not prepared: '+e.message);}
  }
  async function recordRegisterDraft() {
    if(!registerDraft)throw new Error('No pending register entry. Prepare one from a fully matched invoice first.');
    if(!registerDraft.payload)autofillRegisterDetails();
    if(['preview','stale'].includes(registerDraft.verification))throw new Error('The current PDF read has not been verified against the PO. Apply its lines or use Prepare from matched preview first.');
    if(!$('qregistersaved').checked)throw new Error('Save/Create the PO in Nexvia, then tick the saved confirmation.');
    if(registerDraft.origin!==location.origin||Date.now()-registerDraft.createdAt>86400000)throw new Error('This draft expired or belongs to another Nexvia site. Compare the invoice again.');
    // A changed line/account/tax stops this write even after a refresh or a retry.
    const expected=registerDraft.documents.flatMap(d=>d.lines),actual=registerSnapshot(expected,readPoLines());
    if(actual.some((i,n)=>normalizedText(i.acct)!==normalizedText(expected[n].acct)||i.tax!==expected[n].tax))throw new Error('The PO Acct# or tax changed. Discard this draft and prepare it again.');
    const endpoint=new URL(aiEndpoint($('qaiurl').value.trim()));endpoint.pathname='/register/write';endpoint.search='';endpoint.hash='';
    const token=$('qaitoken').value.trim();if(token.length<32)throw new Error('Enter your NAS service access token in AI service settings. This register action does not use OpenAI.');
    if(registerDraft.endpoint&&registerDraft.endpoint!==endpoint.href)throw new Error('The NAS service URL changed. Restore the original URL before retrying this register entry.');
    if(!registerDraft.payload){
      applyRegisterCreatedDate(registerCreatedDateInfo());
      const job=$('qregisterjob').value.trim(),poNumber=$('qregisterpo').value.trim();
      const invoices=registerDraft.documents.map(d=>({supplier:d.supplier?.trim(),invoiceNumber:d.invoiceNumber?.trim(),date:d.date,...(registerDraft.dateKind?{dateKind:registerDraft.dateKind}:{}),job,poNumber,allocations:registerAllocations(d.lines),...(d.lines.some(i=>i.roundingNote)?{roundingNote:[...new Set(d.lines.map(i=>i.roundingNote).filter(Boolean))].join(' ')}:{})}));
      if(invoices.some(i=>!i.supplier||!i.invoiceNumber||!i.job||!i.poNumber||!/^\d{4}-\d{2}-\d{2}$/.test(i.date)||!Number.isFinite(Date.parse(i.date+'T12:00:00Z'))||new Date(i.date+'T12:00:00Z').toISOString().slice(0,10)!==i.date))throw new Error('Complete and check supplier, invoice number, PO created date, job and PO number for every invoice.');
      registerDraft.payload={protocolVersion:1,savedConfirmed:true,invoices};registerDraft.endpoint=endpoint.href;registerDraft.job=job;registerDraft.poNumber=poNumber;persistRegisterDraft();showRegisterDraft();
    }
    let response;
    try{response=await fetch(endpoint.href,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(registerDraft.payload),credentials:'omit',signal:AbortSignal.timeout(30000)});}
    catch{throw new Error('Register could not be reached. The PO was not changed. Keep this draft and retry after checking the NAS service.');}
    let data;try{data=JSON.parse(await response.text());}catch{throw new Error('Register returned an unreadable response. Keep this draft and retry.');}
    if(!response.ok)throw new Error('Register HTTP '+response.status+': '+String(data.error||'Request failed').slice(0,300));
    if(data.protocolVersion!==1||!Number.isInteger(data.added)||!Number.isInteger(data.already)||data.added<0||data.already<0||data.added+data.already!==registerDraft.documents.length)throw new Error('Register confirmation was incomplete. Keep this draft and retry.');
    registerDraft=null;persistRegisterDraft();showRegisterDraft();log('Register updated: '+data.added+' new invoice(s), '+data.already+' already registered.');toast('Register updated');
  }
  function syncRegisterLocks() {
    const locked=!!registerDraft?.payload;
    if($('qregistersaved'))$('qregistersaved').disabled=!!registerDraft&&['preview','stale'].includes(registerDraft.verification);
    for(const el of [$('qregisterjob'),$('qregisterpo'),...$('qregisterdraft').querySelectorAll('input')])if(el)el.disabled=locked;
  }
  function initRegister(runBusy) {
    try{
      $('qregisterenabled').checked=localStorage.getItem('qpoRegisterEnabled')!=='0';
      const raw=sessionStorage.getItem(REGISTER_DRAFT_KEY),draft=raw?JSON.parse(raw):null;
      if(draft&&draft.version===1&&draft.origin===location.origin&&Number.isFinite(draft.createdAt)&&Date.now()-draft.createdAt<86400000&&Array.isArray(draft.documents)&&draft.documents.length<=30&&draft.documents.every(d=>typeof d.reference==='string'&&Array.isArray(d.lines)&&d.lines.length>0&&d.lines.length<=200))registerDraft=draft;
    }catch{log('The previous register draft could not be restored. Prepare it again after comparing the PO.');}
    $('qregisterenabled').onchange=()=>{try{localStorage.setItem('qpoRegisterEnabled',$('qregisterenabled').checked?'1':'0');}catch{}};
    for(const [id,key] of [['qregisterjob','job'],['qregisterpo','poNumber']])$(id).oninput=()=>{if(key==='job')registerAutoJob='';if(registerDraft&&!registerDraft.payload){registerDraft[key]=$(id).value;if(key==='job')registerDraft.jobSource='manual';persistRegisterDraft();}};
    $('qregisterprepare').onclick=()=>{if(!busy)stageRegisterAfterPo(mode==='new'?items:cmp.filter(r=>r.inv).map(r=>r.inv),true);};
    $('qregisterrecord').onclick=()=>runBusy($('qregisterrecord'),'Recording…',async()=>{try{await recordRegisterDraft();}catch(e){log(e.message);$('qregisterstatus').textContent=e.message;toast('Register not confirmed — see the log',false);}}).finally(syncRegisterLocks);
    $('qregisterdiscard').onclick=()=>{if(!busy&&confirm('Discard the local pending register draft? This does not delete any invoice already recorded on the NAS.')){registerDraft=null;persistRegisterDraft();$('qregisterjob').disabled=$('qregisterpo').disabled=false;showRegisterDraft();}};
    if(registerDraft?.jobSource==='nexvia')registerAutoJob=registerDraft.job||'';
    migrateRegisterCreatedDateDraft();
    showRegisterDraft();
    $('qregistersaved').onchange=()=>{if($('qregistersaved').checked){const info=registerCreatedDateInfo();const pending=registerDraft?.documents.some(d=>d.dateSource==='pending-create');applyRegisterCreatedDate(pending&&info.source!=='nexvia'&&info.source!=='automatic-create'?{date:registerBusinessDate(),source:'confirmed-create'}:info);}};
    if($('qregistergather'))$('qregistergather').onclick=()=>{
      if(busy){log('Nexvia details: wait for the current operation to finish, then try again.');return;}
      try{
        autofillRegisterDetails(true);
        const message=$('qregisterautostatus')?.textContent||'No details could be collected. Check the current Nexvia PO page.';
        log('Nexvia details: '+message);toast(message,/^Filled from Nexvia/.test(message));
      }catch(error){
        const message='Could not refresh Nexvia details: '+error.message;
        if($('qregisterautostatus'))$('qregisterautostatus').textContent=message;
        log(message);toast(message,false);
      }
    };
    $('qregisterdetails').addEventListener('toggle',()=>{if($('qregisterdetails').open&&!busy)autofillRegisterDetails();});
    autofillRegisterDetails();
  }

  // ---------- ATTACH PDF TO THE PO ----------
  const notPanel = (e) => !(panel && panel.contains(e));
  function findUploadInput() {
    const inputs = [...document.querySelectorAll('input[type=file]')].filter(notPanel);
    if (!inputs.length) return null;
    const score = (inp) => {
      let el = inp;
      for (let k = 0; k < 6 && el; k++) {
        const txt = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (k > 2 ? '' : el.textContent || '');
        if (/attach|document|upload|file/i.test(txt)) return 2;
        el = el.parentElement;
      }
      return 1;
    };
    return inputs.sort((a, b) => score(b) - score(a))[0];
  }

  async function openAttachTab() {
    const tab = [...document.querySelectorAll('a, button, li, span, div')]
      .filter((e) => e.offsetParent && notPanel(e) &&
        /^(\+\s*)?(attachments?|documents?|files?|uploads?|add (file|attachment|document)s?)(\s*\(\d+\))?$/i.test(e.textContent.trim()))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!tab) return false;
    fire(tab);
    await sleep(1000);
    return true;
  }

  async function attachFile() {
    const files = Array.from($('qfile').files);
    if (!files.length) { toast('Choose the PDF first', false); return false; }
    let inp = findUploadInput();
    if (!inp && await openAttachTab()) inp = findUploadInput();
    if (!inp) {
      log('Attach: no file upload box found on this PO page.');
      toast("Couldn't find where to attach files on this PO - please attach the PDF manually", false);
      return false;
    }
    if(files.length>1 && !inp.multiple){log('Attach: this Nexvia upload box accepts one file at a time. Attach all '+files.length+' selected PDFs manually; no batch files were sent.');toast('Attach the selected invoice PDFs manually in Nexvia',false);return false;}
    const dt = new DataTransfer();
    files.forEach(file=>dt.items.add(file));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    files.forEach(file=>log(`Attach: sent ${file.name} to the PO's upload box.`));
    return true;
  }

  function debug() {
    const root = gridRoot();
    const rows = getRows();
    console.log('[Quote→PO] grid root', root, 'rows', rows, 'add button', findAddBtn(), 'kendo', !!window.kendo, 'grid', rows[0] && kGrid(rows[0]));
    Object.values(CFG.cols).forEach((c) => console.log('[Quote→PO] header', c, findHeader(c)));
    log(`Debug: grid ${root ? 'found' : 'NOT found'}, ${rows.length} row(s). Details in console (F12).`);
    const samples = [...new Set([rows[0], ...rows.filter(rowIsEditing), rows[rows.length - 1]])].filter(Boolean).slice(0, 3);
    samples.forEach((row) => log('Breakdown diagnostic (read only): ' + JSON.stringify(breakdownInfo(row))));
  }

  // ---------- UI ----------
  let items = [];
  let cmp = [];
  let mode = localStorage.getItem('qpoMode') === 'inv' ? 'inv' : 'new';
  let busy = false;
  let aiReadRequested = false;
  let aiReviewRequired = false;
  let learningSource = null;
  let panel, $, log = (m) => console.log('[Quote→PO]', m);

  function mount() {
  panel = document.createElement('div');
  panel.id = 'qpoRoot';
  panel.innerHTML = `
  <style>
    #qpo{position:fixed;right:20px;bottom:20px;z-index:99999;width:640px;max-height:85vh;overflow:auto;
      background:#f6f8fa;border:1px solid #d5dde5;border-radius:12px;box-shadow:0 12px 40px rgba(16,24,40,.22);
      font:13px 'Segoe UI',Arial,sans-serif;color:#1f2933;display:none}
    #qpo *{box-sizing:border-box}
    #qpo label{font-weight:normal;margin:0}
    #qpo #qdocrefs label{display:block;overflow-wrap:anywhere}
    #qpo #qfname{overflow-wrap:anywhere}
    #qpo label.f{font-weight:600 !important;margin-bottom:4px !important}
    #qpo .chk label{font-weight:500}
    #qpo input[type=file]{display:none !important}
    #qpo input:not([type]){height:34px;margin:0}
    #qpo header{position:sticky;top:0;z-index:5;background:linear-gradient(135deg,#2f3a45,#3d4b59);color:#fff;
      padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-radius:12px 12px 0 0}
    #qpo header .t{font-weight:600;font-size:14px}
    #qpo header .st{font-size:11px;opacity:.7;margin-top:1px}
    #qpo #qx{cursor:pointer;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:16px}
    #qpo #qx:hover{background:rgba(255,255,255,.15)}
    #qpo .b{padding:14px 16px 16px}
    #qpo .seg{display:flex;background:#e4e9ef;border-radius:8px;padding:3px;margin-bottom:12px}
    #qpo .seg button{flex:1;background:transparent;color:#52606d;padding:7px;border-radius:6px}
    #qpo .seg button.on{background:#fff;color:#1f2933;box-shadow:0 1px 3px rgba(0,0,0,.12)}
    #qpo .card{background:#fff;border:1px solid #e1e7ed;border-radius:10px;padding:12px 14px;margin-bottom:12px}
    #qpo .h{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#52606d;margin-bottom:10px;
      display:flex;align-items:center;gap:8px}
    #qpo .n{background:#3a8dde;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;
      justify-content:center;font-size:11px;margin-right:6px}
    #qpo label.f{display:block;font-size:12px;color:#3e4c59}
    #qpo input:not([type]),#qpo textarea{width:100%;padding:7px 10px;border:1px solid #cbd2d9;border-radius:6px;
      font:13px 'Segoe UI',Arial;background:#fff;color:#1f2933;outline:none;transition:border-color .15s,box-shadow .15s}
    #qpo input:focus,#qpo textarea:focus{border-color:#3a8dde;box-shadow:0 0 0 3px rgba(58,141,222,.15)}
    #qpo .drop{display:flex;align-items:center;gap:12px;border:2px dashed #b8c4d0;border-radius:10px;padding:14px;
      cursor:pointer;background:#fafcfe;transition:all .15s}
    #qpo .drop:hover,#qpo .drop.over{border-color:#3a8dde;background:#eef6fd}
    #qpo .drop.has{border-style:solid;border-color:#2e9e5b;background:#f0faf4}
    #qpo .drop .ic{font-size:24px}
    #qpo .drop b{display:block;font-size:13px}
    #qpo .drop span.s{color:#7b8794;font-size:12px}
    #qpo details summary{cursor:pointer;color:#3a8dde;font-size:12px;margin-top:10px;user-select:none}
    #qpo details textarea{height:90px;margin-top:6px;resize:vertical}
    #qpo .chk{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:12px}
    #qpo .chk label{display:flex;align-items:center;gap:6px;cursor:pointer}
    #qpo .row{display:flex;gap:10px;margin-top:10px}
    #qpo .row > div{flex:1}
    #qpo small{color:#7b8794;font-size:11px;display:block;margin-top:4px}
    #qpo .cb{position:relative}
    #qpo .cb input{padding-right:30px}
    #qpo .cb .arr{position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:#7b8794;font-size:10px}
    #qpo .cb .list{position:absolute;left:0;right:0;top:calc(100% + 4px);max-height:240px;overflow:auto;background:#fff;
      border:1px solid #d5dde5;border-radius:8px;box-shadow:0 8px 24px rgba(16,24,40,.15);z-index:10;display:none;padding:4px}
    #qpo .cb .opt{padding:7px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #qpo .cb .opt.act{background:#eef6fd}
    #qpo .cb .opt.sel{font-weight:600;color:#1f6fbf}
    #qpo .cb .opt mark{background:#fff3c4;color:inherit;padding:0}
    #qpo .cb .none{padding:8px 10px;color:#7b8794}
    #qpo button{font:600 13px 'Segoe UI',Arial;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;transition:filter .15s}
    #qpo button:hover{filter:brightness(1.08)}
    #qpo button:disabled{background:#9aa5b1 !important;color:#fff !important;cursor:not-allowed;
      filter:none;box-shadow:none}
    #qpo button.is-loading{cursor:progress !important}
    #qpo button.is-loading::before{content:'';display:inline-block;width:12px;height:12px;margin-right:7px;
      border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;vertical-align:-2px;
      animation:qpo-spin .8s linear infinite}
    @keyframes qpo-spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){#qpo button.is-loading::before{animation:none}}
    #qpo .pri{background:#3a8dde;color:#fff}
    #qpo .go{background:#2e9e5b;color:#fff;width:100%;padding:11px;font-size:14px;margin-top:10px}
    #qpo .go:disabled{background:#9aa5b1;cursor:wait}
    #qpo .ghost{background:transparent;color:#52606d;border:1px solid #cbd2d9;padding:5px 10px;font-size:12px}
    #qpo .tblwrap{max-height:280px;overflow:auto;border:1px solid #e1e7ed;border-radius:8px}
    #qpo table{width:100%;border-collapse:collapse}
    #qpo th{position:sticky;top:0;background:#f0f4f8;font-size:11px;text-transform:uppercase;color:#52606d;font-weight:600;
      padding:6px;text-align:left;z-index:1}
    #qpo td{border-top:1px solid #eef1f4;padding:4px 6px;vertical-align:middle}
    #qpo td input{padding:4px 6px !important;font-size:12px !important;border-color:#e1e7ed !important}
    #qpo td select{width:100%;padding:4px 4px;font:12px 'Segoe UI',Arial;border:1px solid #e1e7ed;border-radius:6px;background:#fff;color:#1f2933}
    #qpo tr.check td{background:#fff8e1}
    #qpo td.amt,#qpo th.amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    #qpo .del{cursor:pointer;color:#c0392b;opacity:.5;padding:0 4px}
    #qpo .del:hover{opacity:1}
    #qpo .tot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:13px;gap:10px;flex-wrap:wrap}
    #qpo .tot b{font-size:15px}
    #qpo .warn{color:#a07800}
    #qpo .desc{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #qpo .old{color:#9aa5b1;text-decoration:line-through;font-size:11px;display:block}
    #qpo .chg{color:#b26a00;font-weight:600}
    #qpo .badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;white-space:nowrap}
    #qpo .b-same{background:#e7f6ec;color:#2e7d4f}
    #qpo .b-changed{background:#fff3d6;color:#a06600}
    #qpo .b-new{background:#e3f0fc;color:#1f6fbf}
    #qpo .b-keep{background:#edf1f5;color:#607080}
    #qpo .b-conflict{background:#fff0d8;color:#915400}
    #qpo .b-missing{background:#fde8e6;color:#b03a2e}
    #qpo tr.dim td{opacity:.55}
    #qpo .loghead{display:flex;justify-content:space-between;align-items:center}
    #qpo #qlog{margin-top:8px;font:12px Consolas,monospace;color:#3e4c59;background:#f6f8fa;border-radius:6px;padding:8px;
      white-space:pre-wrap;max-height:110px;overflow:auto}
    #qpo #qlog:empty{display:none}
    #qpo .only-new,#qpo .only-inv{display:none}
    #qpo.m-new .only-new{display:block}
    #qpo.m-inv .only-inv{display:block}
    #qpo.m-inv span.only-inv{display:inline}
    #qpo.m-new .row.only-new{display:flex}
    #qpoBtn{position:fixed;right:20px;bottom:20px;z-index:99998;background:linear-gradient(135deg,#2e9e5b,#27874d);color:#fff;
      border:0;border-radius:32px;padding:18px 30px;font:700 18px 'Segoe UI',Arial;box-shadow:0 6px 18px rgba(46,158,91,.35);cursor:pointer}
    #qpoBtn:hover{filter:brightness(1.07)}
    #qpo #qdelete{width:500px;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;padding:20px;
      border:1px solid #d5dde5;border-radius:12px;background:#fff;color:#1f2933;
      box-shadow:0 12px 40px rgba(16,24,40,.25);font:13px 'Segoe UI',Arial,sans-serif}
    #qpo #qdelete::backdrop{background:rgba(16,24,40,.4)}
    #qpo #qdeleteTitle{font-size:17px;margin:0 0 12px}
    #qpo #qdeleteList{max-height:220px;overflow:auto;padding-left:22px;line-height:1.5}
    #qpo #qdeleteList li{margin:5px 0;overflow-wrap:anywhere}
    #qpo .dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}
    #qpo #qdeleteApply{background:#b03a2e;color:#fff}

    /* Scoped settings layout; keeps Nexvia page styles out of these controls. */
    #qpo{max-width:calc(100vw - 24px)}
    #qpo .settings-panel{border:1px solid #e1e7ed;border-radius:8px;background:#fafcfe;margin:12px 0}
    #qpo .settings-panel > summary{display:flex;align-items:center;justify-content:space-between;gap:14px;list-style:none;margin:0;padding:12px 14px;color:#334e68;font-size:13px;line-height:1.4;border-radius:8px}
    #qpo .settings-panel > summary::-webkit-details-marker{display:none}
    #qpo .settings-panel > summary::after{content:'›';font-size:22px;line-height:1;color:#627d98;transform:rotate(90deg);transition:transform .15s}
    #qpo .settings-panel[open] > summary::after{transform:rotate(-90deg)}
    #qpo .settings-panel[open] > summary{border-bottom:1px solid #e1e7ed;border-radius:8px 8px 0 0}
    #qpo .settings-panel > summary:hover{background:#f0f5fa}
    #qpo .settings-panel > summary small{margin:3px 0 0;font-size:11px;font-weight:400;color:#627d98}
    #qpo .settings-body{padding:14px;display:grid;gap:16px;min-width:0}
    #qpo .settings-section{min-width:0;margin:0;padding:0}
    #qpo .settings-section + .settings-section{border-top:1px solid #e1e7ed;padding-top:16px}
    #qpo .settings-section h4{margin:0 0 12px;font:600 12px 'Segoe UI',Arial;color:#334e68}
    #qpo .section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap}
    #qpo .section-heading h4{margin:0}
    #qpo .field{min-width:0;margin-bottom:12px}
    #qpo .field:last-child{margin-bottom:0}
    #qpo .settings-body input:not([type=checkbox]),#qpo .register-drafts input{display:block;width:100%;height:36px;min-width:0;margin:5px 0 0;padding:8px 10px;border:1px solid #cbd2d9;border-radius:6px;background:#fff;color:#1f2933;font:13px 'Segoe UI',Arial;box-shadow:none}
    #qpo .settings-body input:not([type=checkbox]):focus{outline:none;border-color:#3a8dde;box-shadow:0 0 0 3px rgba(58,141,222,.15)}
    #qpo .settings-body input:disabled{background:#f0f4f8;color:#627d98}
    #qpo label.check-row{display:flex;align-items:flex-start;gap:10px;padding:0;margin:12px 0 0;cursor:pointer;font-size:12px;line-height:1.5;color:#334e68;text-align:left}
    #qpo label.check-row input[type=checkbox]{appearance:auto;flex:0 0 16px;width:16px;height:16px;min-height:0;margin:2px 0 0;padding:0;accent-color:#3a8dde;box-shadow:none}
    #qpo .check-row > span{min-width:0;display:block}
    #qpo .check-row b{font-weight:600}
    #qpo .check-row small{margin:3px 0 0;line-height:1.5;color:#627d98}
    #qpo .settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
    #qpo .settings-actions button{min-height:34px;margin:0}
    #qpo label.ai-consent{padding:12px;background:#eef5fd;border:1px solid #d8e6f6;border-radius:8px;margin:12px 0}
    #qpo .saved-layouts{display:grid;gap:10px;margin-top:12px;color:#627d98;font-size:12px;overflow-wrap:anywhere}
    #qpo .saved-layouts:empty{display:none}
    #qpo .saved-layouts > div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;padding:12px;background:#fff;border:1px solid #e1e7ed;border-radius:7px}
    #qpo .saved-layouts > div > span{color:#334e68;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
    #qpo .saved-layouts > div > button{white-space:nowrap;margin:0}
    #qpo .saved-layouts details{grid-column:1/-1;min-width:0}
    #qpo .saved-layouts details summary{margin:0;font-size:11px}
    #qpo .saved-layouts pre{max-height:200px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px Consolas,monospace;padding:10px;background:#f0f4f8;border-radius:6px;margin:8px 0 0}
    #qpo .register-card{padding:0;overflow:hidden}
    #qpo .register-card .settings-panel{margin:0;border:0;background:#fff}
    #qpo .register-card .settings-body{padding:16px}
    #qpo .register-card .settings-body > .check-row{margin:0}
    #qpo .settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    #qpo .settings-grid .field{margin:0}
    #qpo .full-field{grid-column:1/-1}
    #qpo .register-drafts{display:grid;gap:12px;min-width:0}
    #qpo .register-drafts:empty{display:none}
    #qpo .register-drafts > div{padding:12px !important;border:1px solid #e1e7ed !important;border-radius:8px;background:#fafcfe;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    #qpo .register-drafts > div > strong,#qpo .register-drafts > div > small{grid-column:1/-1;overflow-wrap:anywhere}
    #qpo .register-drafts > div > label{margin:0 !important;min-width:0}
    #qpo .register-drafts > div > label:nth-child(2){grid-column:1/-1}
    #qpo .register-confirm{padding-top:14px;border-top:1px solid #e1e7ed}
    #qpo .register-confirm > .check-row{margin:0}
    #qpo .register-status{margin:0;line-height:1.5;overflow-wrap:anywhere;padding:10px 12px;border:1px solid #e1e7ed;border-radius:6px;background:#f6f8fa;color:#52606d}
    #qpo .register-status:empty{display:none}
    #qpo #qaireviewwrap{border:1px solid #f0dc9a;border-radius:8px;line-height:1.5}
    #qpo #qaireviewwrap > label:first-child{display:flex;align-items:flex-start;gap:8px}
    #qpo #qaireviewwrap > label.f{margin-top:12px}
    #qpo #qlearn{margin-top:8px}
    #qpo .settings-panel > summary:focus-visible,#qpo button:focus-visible{outline:2px solid #3a8dde;outline-offset:3px}
    #qpo .h:has(#qparse){flex-wrap:wrap;gap:10px}
    @media(max-width:520px){
      #qpo{right:12px;bottom:12px}
      #qpo .b{padding:10px}
      #qpo .settings-grid,#qpo .register-drafts > div{grid-template-columns:minmax(0,1fr)}
      #qpo .saved-layouts > div{grid-template-columns:minmax(0,1fr)}
      #qpo .saved-layouts details{grid-column:auto}
      #qpo .saved-layouts > div > button{justify-self:start}
    }
  </style>
  <button id="qpoBtn">New/Update PO</button>
  <div id="qpo">
    <header>
      <div><div class="t">Quote → PO lines</div><div class="st" id="qsub">Import supplier quote lines into this PO</div></div>
      <span id="qx" title="Close (Esc)">✕</span>
    </header>
    <div class="b">
      <div class="seg">
        <button id="qmnew">New PO</button>
        <button id="qminv">Update PO</button>
      </div>

      <div class="card">
        <div class="h"><span class="n">1</span><span id="qdoc">Quote</span></div>
        <label class="drop" id="qdrop">
          <span class="ic">\uD83D\uDCC4</span>
          <div><b id="qfname">Choose or drop PDFs</b><span class="s">Select multiple PDFs from the same supplier, or drag them here</span></div>
          <input type="file" id="qfile" accept=".pdf" multiple hidden style="display:none !important">
        </label>
        <button class="ghost" id="qclearfile" style="display:none;margin-top:6px">Clear PDFs</button>
        <div id="qdocrefs" style="margin-top:10px"></div>
        <small>Select all PDFs for this batch together. Choosing files again replaces the selection.</small>
        <details><summary>or paste lines / Excel rows</summary>
          <textarea id="qtext" placeholder="Description  Qty  Rate  Total"></textarea>
        </details>
        <div class="chk">
          <label><input type="checkbox" id="qattach"> Upload the selected PDFs before adding / updating PO lines</label>
          <button class="ghost" id="qattachnow">Attach now</button>
        </div>
      </div>

      <div class="card">
        <div class="h"><span class="n">2</span>PO details</div>
        <label class="f">Acct# <span style="color:#c0392b">*</span> <span class="only-inv" style="font-weight:normal">(auto from existing lines)</span></label>
        <div class="cb">
          <input id="qacct" autocomplete="off" placeholder="Search accounts...">
          <span class="arr">▼</span>
          <div class="list" id="qacctbox"></div>
        </div>
        <div class="only-inv" style="margin-top:10px"><label class="f" for="qinvoiceAction">Update action</label><select id="qinvoiceAction" style="width:100%;padding:8px"><option value="append">Add invoices — keep existing PO lines</option><option value="match">Match PO to one invoice — update / delete lines</option></select><small id="qactionhint">Add each invoice as separate lines. Existing PO lines are retained.</small></div>
        <small class="only-inv" id="qaccthint">Existing PO lines supply the Acct# for new invoice lines.</small>
        <label class="f" style="margin-top:10px">Tax</label>
        <div class="cb">
          <input id="qtaxv" autocomplete="off" placeholder="GST Applied">
          <span class="arr">▼</span>
          <div class="list" id="qtaxbox"></div>
        </div>
        <label class="f" style="margin-top:10px">Breakdown Type <span class="only-inv" style="font-weight:normal">(auto from existing lines)</span></label>
        <input id="qbd" list="qbdoptions" placeholder="Detected from existing PO lines, or enter manually">
        <datalist id="qbdoptions"></datalist>
        <small class="only-inv" id="qbdhint">Existing PO lines supply the Breakdown Type for new invoice lines.</small>
        <div class="row">
          <div id="qrefwrap"><label class="f" for="qref">Supplier Ref *</label><input id="qref" required aria-required="true" placeholder="Supplier quote / invoice / order reference"></div>
          <div class="only-new" style="flex:0 0 110px"><label class="f">Start at line</label><input id="qstart" value="1"></div>
        </div>
        <small class="only-new">Breakdown Type is only used if Nexvia leaves it empty on a new row.</small>
        <details><summary>Backup default (Cost Category)</summary>
          <div class="row">
            <div><label class="f">Cost Category</label><input id="qcc"></div>
          </div>
          <small>Only used if Nexvia leaves the field empty on a new row.</small>
        </details>
      </div>

      <div class="card">
        <div class="h" style="justify-content:space-between">
          <span><span class="n">3</span>Lines</span>
          <span><button class="pri" id="qparse">Read quote</button> <button class="ghost" id="qai">Read with AI</button></span>
        </div>
        <details id="qaisettings" class="settings-panel">
          <summary><span><b>AI &amp; saved layouts</b><small>Service connection, device preferences and reusable PDF layouts</small></span></summary>
          <div class="settings-body">
            <section class="settings-section" aria-labelledby="qconnectiontitle">
              <h4 id="qconnectiontitle">Service connection</h4>
              <div class="field"><label class="f" for="qaiurl">AI service URL</label><input id="qaiurl" placeholder="https://your-service.example/extract" autocomplete="off"></div>
              <div class="field"><label class="f" for="qaitoken">Service access token</label><input id="qaitoken" type="password" autocomplete="off" aria-describedby="qtokenhelp"></div>
              <small id="qtokenhelp">Use your service token. Your OpenAI API key stays on the NAS.</small>
              <label class="check-row"><input type="checkbox" id="qairemember"><span><b>Remember token on this device</b><small>Trusted devices only. Otherwise the token is kept for this tab.</small></span></label>
              <div class="settings-actions"><button type="button" class="ghost" id="qaisave">Save AI settings</button></div>
            </section>
            <section class="settings-section" aria-labelledby="qsavedtitle">
              <div class="section-heading"><h4 id="qsavedtitle">Saved PDF layouts</h4><button type="button" class="ghost" id="qlayoutmanage">Refresh layouts</button></div>
              <label class="check-row"><input type="checkbox" id="quselearned"><span><b>Try saved layouts automatically</b><small>Sends extracted text to your NAS to match a saved layout. No OpenAI request.</small></span></label>
              <div id="qlayoutlist" class="saved-layouts"></div>
            </section>
          </div>
        </details>
        <label class="check-row ai-consent"><input type="checkbox" id="qaiconsent"><span><b>Allow Read with AI</b><small>When I click Read with AI, send this PDF’s extracted text to my AI service and OpenAI.</small></span></label>
        <div id="qaireviewwrap" style="display:none;margin:10px 0;padding:10px;background:#fff3c4">
          <label><input type="checkbox" id="qaireview"> I checked the AI descriptions, quantities, prices and GST against the PDF.</label>
          <small>AI results can contain mistakes. Adding lines is a separate action.</small>
          <label class="f" for="qlayoutname">Layout name</label><input id="qlayoutname" placeholder="e.g. Insulation Easy quote" maxlength="80">
          <button type="button" class="ghost" id="qlearn">Confirm and learn layout</button>
          <small>Learn a reusable one-page table with a printed supplier ABN and reconciled totals. Some layouts cannot be learned reliably from one example.</small>
        </div>
        <label class="check-row"><input type="checkbox" id="qrounding" checked><span><b>Use calculated totals for small rounding differences</b><small>Up to $0.10 per document. Printed figures and the adjustment are kept in PO notes and the register. Review before adding.</small></span></label><div id="qroundingnotice" role="status" style="display:none;padding:12px;background:#fff3c4"></div>
        <small id="qhint" style="margin:0">Choose a PDF above. Reading also refreshes supplier, job and PO details from Nexvia.</small>
        <div id="qlines" style="display:none">
          <div class="tblwrap"><table id="qtbl"></table></div>
          <div class="tot" id="qtot"></div>
          <button class="go" id="qgo">Add lines, create PO & record</button>
        </div>
        <div id="qcmp" style="display:none">
          <div class="tblwrap"><table id="qctbl"></table></div>
          <div class="tot" id="qctot"></div>
          <button class="go" id="qapply">Apply ticked changes</button>
        </div>
      </div>

      <div class="card">
        <label class="check-row" style="margin:0"><input type="checkbox" id="qpoautosave"><span><b>Automatically save after adding lines</b><small>Add lines also saves through Nexvia’s Create/Save and Continue Editing after uploads and line checks finish.</small></span></label>
        <details class="settings-panel"><summary>Save recovery and diagnostics</summary><div class="settings-actions"><button type="button" class="ghost" id="qsavecontrolcheck">Check save controls</button><button type="button" class="ghost" id="qattachmentcheck">Check attachments</button><button type="button" class="ghost" id="qposavecollect">Collect Order Number</button><button type="button" class="ghost" id="qposavereset">Clear save guard</button></div></details>
        <small id="qposavestatus" role="status">Add lines completes creation and register recording automatically when both options are enabled. Review the preview before clicking.</small>
      </div>

      <div class="card register-card">
        <details id="qregisterdetails" class="settings-panel">
          <summary><span><b>Shared invoice register</b><small>Record saved POs and share the invoice register</small></span></summary>
          <div class="settings-body">
            <label class="check-row"><input type="checkbox" id="qregisterenabled"><span><b>Record register after automatic PO creation</b><small>Prepares entries after line checks and records them after automatic Create is confirmed. Register details go to your NAS, without OpenAI.</small></span></label>
            <section class="settings-section" aria-labelledby="qregisterdetailstitle">
              <div class="section-heading"><h4 id="qregisterdetailstitle">PO details</h4></div>
              <small id="qregisterautostatus" role="status" style="margin:0 0 12px">Supplier and job refresh when you read a PDF. The PO number is collected after automatic creation.</small>
              <div class="settings-grid">
                <div class="field full-field"><label class="f" for="qregistersupplier">Supplier for new drafts</label><input id="qregistersupplier" maxlength="180" placeholder="Supplier's registered name"></div>
                <div class="field"><label class="f" for="qregisterjob">Job</label><input id="qregisterjob" maxlength="180" placeholder="Detected from Nexvia, or enter job"></div>
                <div class="field"><label class="f" for="qregisterpo">Saved PO number</label><input id="qregisterpo" maxlength="100" placeholder="Detected after saving, or enter PO number"></div>
              </div>
              <details class="settings-panel"><summary>Register recovery</summary><div class="settings-actions"><button type="button" class="ghost" id="qregisterprepare">Prepare from matched preview</button></div></details>
            </section>
            <small>PO created date is automatic for new POs (Brisbane time). Existing POs use Nexvia’s creation date when available; otherwise enter it for review.</small>
            <div id="qregisterdraft" class="register-drafts"></div>
            <details class="register-confirm settings-panel"><summary>Manual register recovery</summary>
              <label class="check-row"><input type="checkbox" id="qregistersaved"><span><b>PO saved and details checked</b><small>I saved/created this PO in Nexvia and checked the register details, including invoice numbers and the PO created date.</small></span></label>
              <div class="settings-actions"><button type="button" class="pri" id="qregisterrecord">Record / retry register</button><button type="button" class="ghost" id="qregisterdiscard">Discard local draft</button></div>
            </details>
            <small id="qregisterstatus" class="register-status" role="status"></small>
          </div>
        </details>
      </div>

      <div class="card" style="margin-bottom:0">
        <div class="loghead">
          <div class="h" style="margin:0">Log</div>
          <div><details style="display:inline-block"><summary>Diagnostics</summary><button class="ghost" id="qdbg">Debug grid</button></details> <button class="ghost" id="qclear">Clear log</button></div>
        </div>
        <div id="qlog"></div>
      </div>
    </div>
    <dialog id="qdelete" aria-labelledby="qdeleteTitle" aria-describedby="qdeleteInfo qdeleteNote">
      <h3 id="qdeleteTitle"></h3>
      <p id="qdeleteInfo">These selected PO lines are missing from the invoice:</p>
      <ul id="qdeleteList"></ul>
      <p id="qdeleteNote">Selected updates and additions will also be applied. Review the PO before clicking Save in Nexvia.</p>
      <div class="dialog-actions">
        <button type="button" class="ghost" id="qdeleteCancel" autofocus disabled>Cancel</button>
        <button type="button" id="qdeleteApply" disabled>Apply changes</button>
      </div>
    </dialog>
  </div>`;
  document.body.appendChild(panel);
  $ = (id) => panel.querySelector('#' + id);
  log = (m) => { $('qlog').textContent += m + '\n'; $('qlog').scrollTop = 1e9; console.log('[Quote→PO]', m); };
  const money = (v) => isNaN(v) ? '-' : '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ----- mode switch -----
  function setMode(m) {
    mode = m;
    localStorage.setItem('qpoMode', m);
    const box = $('qpo');
    box.classList.toggle('m-new', m === 'new');
    box.classList.toggle('m-inv', m === 'inv');
    $('qmnew').classList.toggle('on', m === 'new');
    $('qminv').classList.toggle('on', m === 'inv');
    const batch=$('qfile').files.length>1;
    $('qdoc').textContent = m === 'new' ? (batch?'Documents':'Quote') : (batch?'Invoices':'Invoice');
    $('qparse').textContent = m === 'new' ? (batch?'Read PDFs':'Read quote') : 'Compare with PO';
    $('qsub').textContent = m === 'new' ? 'Import supplier document lines into this PO' : $('qinvoiceAction').value==='append'?'Add invoices to this PO and keep its existing lines':'Update this PO to match the supplier invoice';
    $('qlines').style.display = m === 'new' && items.length ? 'block' : 'none';
    $('qcmp').style.display = m === 'inv' && cmp.length ? 'block' : 'none';
    $('qhint').style.display = (m === 'new' ? items.length : cmp.length) ? 'none' : 'block';
    if (m === 'inv') {
      const po = readPoLines();
      syncInvoiceAccount(po, true);
      syncInvoiceBreakdown(po, true);
    } else {
      $('qacct').value = localStorage.getItem('qpoAcct') || '';
      $('qbd').value = localStorage.getItem('qpo2_qbd') || '';
    }
  }
  $('qmnew').onclick = () => { if (!busy) setMode('new'); };
  $('qminv').onclick = () => { if (!busy) setMode('inv'); };

  // ----- file picker / drag & drop -----
  const drop = $('qdrop');
  const savedDocumentRefs = new Map();
  let priorSelectionKeys=[];
  const fileKey = (f) => [f.name,f.size,f.lastModified].join('|');
  const showFile = () => {
    const files = Array.from($('qfile').files);
    const keys=files.map(fileKey);
    if(files.length===1 && priorSelectionKeys.length && (priorSelectionKeys.length!==1 || priorSelectionKeys[0]!==keys[0]))$('qref').value=savedDocumentRefs.get(keys[0])||'';
    if(keys.length)priorSelectionKeys=keys;
    $('qdoc').textContent=mode==='new'?(files.length>1?'Documents':'Quote'):(files.length>1?'Invoices':'Invoice');
    $('qparse').textContent=mode==='new'?(files.length>1?'Read PDFs':'Read quote'):'Compare with PO';
    $('qfname').textContent = files.length > 1 ? files.length+' PDFs selected' : files[0]?.name || 'Choose or drop PDFs';
    drop.classList.toggle('has', !!files.length);
    $('qclearfile').style.display = files.length ? 'inline-block' : 'none';
    $('qdocrefs').replaceChildren();
    $('qrefwrap').style.display = files.length > 1 && !$('qtext').value.trim() ? 'none' : '';
    if (files.length > 1) files.forEach((file,index) => {
      const row=document.createElement('div');row.style.marginBottom='10px';
      const label=document.createElement('label');label.className='f';label.htmlFor='qdocref'+index;label.textContent=file.name+' — Supplier Ref *';
      const input=document.createElement('input');input.id='qdocref'+index;input.required=true;input.setAttribute('aria-required','true');input.style.width='100%';input.placeholder='Invoice / quote reference for this PDF';input.value=savedDocumentRefs.get(fileKey(file))||'';
      input.addEventListener('input',()=>{savedDocumentRefs.set(fileKey(file),input.value);clearReadPreview();});
      row.append(label,input);$('qdocrefs').append(row);
    });
    clearReadPreview();
  };
  $('qfile').onchange = showFile;
  $('qclearfile').onclick = () => { $('qfile').value = ''; showFile(); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) { $('qfile').files = e.dataTransfer.files; showFile(); }
  });

  // ----- attach option -----
  $('qinvoiceAction').onchange = () => { clearReadPreview(); $('qsub').textContent=$('qinvoiceAction').value==='append'?'Add invoices to this PO and keep its existing lines':'Update this PO to match the supplier invoice'; $('qactionhint').textContent=$('qinvoiceAction').value==='append'?'Add each invoice as separate lines. Existing PO lines are retained.':'Compare one invoice with the PO. Selected missing lines will be deleted.'; $('qapply').textContent=$('qinvoiceAction').value==='append'?'Add ticked invoice lines':'Apply ticked changes'; };
  $('qref').addEventListener('input',()=>{if($('qfile').files.length===1)savedDocumentRefs.set(fileKey($('qfile').files[0]),$('qref').value);if(mode==='inv' && $('qinvoiceAction').value==='append')clearReadPreview();});
  $('qtext').addEventListener('input',()=>{if($('qfile').files.length>1)$('qrefwrap').style.display=$('qtext').value.trim()?'':'none';clearReadPreview();});
  $('qattach').checked = localStorage.getItem('qpoAttach') !== '0';
  $('qattach').onchange = () => localStorage.setItem('qpoAttach', $('qattach').checked ? '1' : '0');
  $('qattachnow').onclick = () => runBusy($('qattachnow'), 'Attaching PDF…', async () => {
    if (await attachFile()) toast('✓ Selected PDF(s) sent to the PO upload box; check their upload status.');
  });

  // ----- backup defaults -----
  ['qcc', 'qbd'].forEach((id) => {
    $(id).value = localStorage.getItem('qpo2_' + id) || '';
    $(id).onchange = () => {
      if (id === 'qbd' && mode === 'inv') syncInvoiceBreakdown(readPoLines());
      else localStorage.setItem('qpo2_' + id, $(id).value.trim());
    };
  });

  // Reads the options from one of Nexvia's dropdown columns on an existing row
  async function readOptions(colName) {
    for (const r of rowEls()) {
      const c = cellIn(r, colName);
      if (!c) continue;
      if (!widgetIn(c) && !c.querySelector('select')) { fire(c); await sleep(CFG.stepDelay); }
      const w = widgetIn(c);
      if (w && w.dataSource) {
        try { if (!w.dataSource.data().length) await w.dataSource.read(); } catch (e) {}
        const tf = w.options && w.options.dataTextField;
        const list = dropdownDataItems(w).map((d) => dropdownText(d, tf)).filter(Boolean);
        if (list.length) return list;
      }
      const sel = c.querySelector('select');
      if (sel) return [...sel.options].map((o) => o.text.trim()).filter(Boolean);
    }
    return [];
  }

  // Saved option lists (loaded from Nexvia once, kept in this browser)
  function optionList(key, col, label) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { list = []; }
    let loading = null;
    return {
      get: () => list,
      set(l) {
        list = [...new Set(l.map((x) => String(x).trim()).filter(Boolean))];
        localStorage.setItem(key, JSON.stringify(list));
      },
      load() {
        if (loading) return loading;
        loading = (async () => {
          try {
            const l = await readOptions(col);
            if (l.length) { this.set(l); log(`Loaded ${l.length} ${label} options from Nexvia.`); }
          } catch (e) { console.warn('[Quote→PO] load ' + label, e); }
          loading = null;
          return list;
        })();
        return loading;
      },
    };
  }
  const acctOpts = optionList('qpoAcctList', CFG.cols.acct, 'Acct#');
  const taxOpts = optionList('qpoTaxList', CFG.cols.tax, 'Tax');
  const measOpts = optionList('qpoMeasureList', CFG.cols.measure, 'Measure');

  // Searchable dropdown (type to filter, arrows + Enter, click to pick)
  const combos = [];
  function makeCombo({ input, box, opts, valueKey, def, minList, noun, preferred }) {
    input.value = localStorage.getItem(valueKey) || def || '';
    let shown = [], act = -1, tried = false;
    const all = () => {
      const l = [...new Set([...(preferred ? preferred() : []), ...opts.get()])];
      return l.length ? l : (def ? [def] : []);
    };
    function renderList(q) {
      const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!tried && all().length < minList) {
        tried = true;   // only try loading from Nexvia once per page
        opts.load().then(() => { if (box.style.display === 'block') renderList(q); });
      }
      const list = all();
      if (!list.length) { box.innerHTML = `<div class="none">Loading ${noun} from Nexvia… (needs at least one row in the PO)</div>`; shown = []; return; }
      shown = list.filter((a) => words.every((w) => a.toLowerCase().includes(w))).slice(0, 300);
      const cur = shown.indexOf(input.value);
      act = shown.length ? (cur >= 0 ? cur : 0) : -1;
      if (!shown.length) { box.innerHTML = `<div class="none">No matching ${noun}</div>`; return; }
      box.innerHTML = shown.map((a, i) => {
        let h = esc(a);
        words.forEach((w) => {
          const re = new RegExp('(' + esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
          h = h.replace(re, '<mark>$1</mark>');
        });
        return '<div class="opt' + (i === act ? ' act' : '') + (a === input.value ? ' sel' : '') + '" data-i="' + i + '">' + h + '</div>';
      }).join('');
    }
    const scrollAct = () => { const el = box.querySelector('.opt.act'); if (el) el.scrollIntoView({ block: 'nearest' }); };
    const open = (q) => { renderList(q); box.style.display = 'block'; scrollAct(); };
    const close = () => { box.style.display = 'none'; };
    const save = () => localStorage.setItem(valueKey, input.value.trim() || def || '');
    function pick(a) { input.value = a; input.style.borderColor = ''; save(); close(); }
    input.addEventListener('focus', () => { input.select(); open(''); });
    input.addEventListener('click', () => { if (box.style.display !== 'block') open(''); });
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (box.style.display !== 'block') return open('');
        if (!shown.length) return;
        act = (act + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        box.querySelectorAll('.opt').forEach((o, i) => o.classList.toggle('act', i === act));
        scrollAct();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (act >= 0 && shown[act]) pick(shown[act]);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.opt');
      if (o) { e.preventDefault(); pick(shown[+o.dataset.i]); }
    });
    input.addEventListener('blur', () => setTimeout(() => {
      close();
      if (def && !input.value.trim()) input.value = def;
      save();
    }, 150));
    const c = { close };
    combos.push(c);
    return c;
  }
  const closeList = () => combos.forEach((c) => c.close());

  makeCombo({ input: $('qacct'), box: $('qacctbox'), opts: acctOpts, valueKey: 'qpoAcct', def: '', minList: 1, noun: 'accounts',
    preferred: () => mode === 'inv' ? invoiceAccounts : [] });
  makeCombo({ input: $('qtaxv'), box: $('qtaxbox'), opts: taxOpts, valueKey: 'qpoTax', def: 'GST Applied', minList: 2, noun: 'tax options' });

  // Map a UOM from the quote (EA, LM, Roll...) to one of Nexvia's Measure options
  function matchMeasure(u) {
    const list = measOpts.get();
    if (!u || !list.length) return u || '';
    const lu = u.toLowerCase();
    const exact = list.find((o) => o.toLowerCase() === lu);
    if (exact) return exact;
    const syn = {
      ea: ['each', 'ea'], each: ['each', 'ea'], pc: ['each', 'piece'], pcs: ['each', 'piece'], no: ['each', 'number'],
      lm: ['lineal', 'linear', 'lm', 'metre', 'meter'], m: ['metre', 'meter', 'lineal', 'linear'],
      m2: ['m2', 'm²', 'square', 'sqm'], sqm: ['m2', 'm²', 'square', 'sqm'],
      kg: ['kg', 'kilo'], hr: ['hour', 'hr'], hrs: ['hour', 'hr'], len: ['length'], sht: ['sheet'], pk: ['pack'],
      set: ['set'], lot: ['lot'], roll: ['roll'], box: ['box'],
    };
    for (const s of (syn[lu] || [lu])) {
      const m = list.find((o) => o.toLowerCase().includes(s));
      if (m) return m;
    }
    return u;
  }

  // ----- open / close -----
  const openPanel = () => { autofillRegisterDetails(); $('qpo').style.display = 'block'; $('qpoBtn').style.display = 'none'; };
  const closePanel = () => { closeList(); $('qpo').style.display = 'none'; $('qpoBtn').style.display = 'block'; };
  $('qpoBtn').onclick = openPanel;
  $('qx').onclick = closePanel;
  $('qdbg').onclick = () => runBusy($('qdbg'), 'Checking grid…', debug);
  $('qclear').onclick = () => runBusy($('qclear'), 'Clearing log…', () => { $('qlog').textContent = ''; });

  // Click outside the panel (or press Esc) closes it - ignored while working
  document.addEventListener('mousedown', (e) => {
    if (!e.isTrusted || busy) return;
    if ($('qpo').style.display !== 'block') return;
    if (panel.contains(e.target)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !busy && $('qpo').style.display === 'block') closePanel();
  });

  // ----- quote lines table -----
  function measureCell(it) {
    const list = measOpts.get();
    if (!list.length) return `<input data-k="measure" value="${esc(it.measure)}" placeholder="Default">`;
    const opts = [...list];
    if (it.measure && !opts.includes(it.measure)) opts.unshift(it.measure);
    return `<select data-k="measure" title="${esc(it.measure || 'Nexvia default')}">` +
      `<option value="">Default</option>` +
      opts.map((o) => `<option value="${esc(o)}"${o === it.measure ? ' selected' : ''}>${esc(o)}</option>`).join('') +
      `</select>`;
  }
  function render() {
    const t = $('qtbl');
    t.innerHTML = '<tr><th>Description</th><th style="width:110px">Measure</th><th style="width:62px">Qty</th>' +
      '<th style="width:80px">Unit $</th><th class="amt" style="width:90px">Amount</th><th style="width:22px"></th></tr>';
    let sum = 0, checks = 0;
    items.forEach((it, i) => {
      const amt = r2(it.quantity * it.unitCost); sum += amt;
      const tr = document.createElement('tr');
      if (it.check !== 'ok') { tr.className = 'check'; checks++; }
      tr.innerHTML = `<td><input data-k="description" value="${esc(it.description)}" title="${esc(it.description)}">${it.supplierRef ? `<small>Ref: ${esc(it.supplierRef)}${it.sourceName?' · '+esc(it.sourceName):''}</small>` : ''}${it.tax ? `<small>${esc(it.tax)} · PDF GST ${money(it.gstAmount)}</small>` : ''}</td>
        <td>${measureCell(it)}</td>
        <td><input data-k="quantity" value="${it.quantity}"></td>
        <td><input data-k="unitCost" value="${it.unitCost}"></td>
        <td class="amt">${money(amt)}</td><td><span class="del" title="Remove line" data-del>✕</span></td>`;
      tr.querySelectorAll('input, select').forEach((inp) => inp.onchange = () => {
        const k = inp.dataset.k;
        if (aiReviewRequired) $('qaireview').checked = false;
        it[k] = (k === 'quantity' || k === 'unitCost') ? num(inp.value) : inp.value;
        it.check = 'ok'; render();
      });
      tr.querySelector('[data-del]').onclick = () => { items.splice(i, 1); if (aiReviewRequired) $('qaireview').checked = false; render(); };
      t.appendChild(tr);
    });
    $('qtot').innerHTML = `<span>${items.length} line${items.length === 1 ? '' : 's'}` +
      (checks ? ` · <span class="warn">${checks} to check (yellow)</span>` : '') +
      `</span><span>Total ex GST <b>${money(sum)}</b></span>`;
    $('qlines').style.display = items.length ? 'block' : 'none';
    $('qhint').style.display = items.length ? 'none' : 'block';
  }

  // ----- invoice comparison table -----
  const LABEL = { keep:'Keep existing', conflict:'Review duplicate ref', same: 'Same', changed: 'Changed', new: 'Not on PO', missing: 'Not on invoice' };
  function renderCmp() {
    const t = $('qctbl');
    t.innerHTML = '<tr><th style="width:24px"></th><th>Description</th><th class="amt">Qty</th>' +
      '<th class="amt">Unit $</th><th class="amt">Amount</th><th>Status</th></tr>';
    let poSum = 0, invSum = 0, nChg = 0, nMissing = 0;
    cmp.forEach((r) => {
      const desc = r.inv ? r.inv.description : r.po.description;
      if (r.po && !isNaN(r.po.amount)) poSum += r.po.amount;
      if (r.inv) invSum += r.invAmt;
      if ((r.status === 'changed' || r.status === 'new') && (!r.append || r.apply)) nChg++;
      if (r.status === 'missing') nMissing++;
      const cell = (oldV, newV, fmt) => {
        if (!r.po) return fmt(newV);
        if (!r.inv) return fmt(oldV);
        const diff = !cents(oldV, newV);
        return diff ? `<span class="old">${fmt(oldV)}</span><span class="chg">${fmt(newV)}</span>` : fmt(newV);
      };
      const q = (v) => isNaN(v) ? '-' : String(+v);
      const tr = document.createElement('tr');
      if (r.status === 'same') tr.className = 'dim';
      const can = ['changed', 'new', 'missing'].includes(r.status);
      tr.innerHTML = `<td>${can ? `<input type="checkbox" title="${r.status === 'missing' ? 'Delete this PO line' : 'Apply this change'}" ${r.apply ? 'checked' : ''}>` : ''}</td>
        <td><div class="desc" title="${esc(desc)}">${esc(desc)}</div>${r.inv?.supplierRef ? `<small>Ref: ${esc(r.inv.supplierRef)}${r.inv.sourceName?' · '+esc(r.inv.sourceName):''}</small>` : ''}${r.inv?.tax ? `<small>${esc(r.inv.tax)} · PDF GST ${money(r.inv.gstAmount)}</small>` : ''}</td>
        <td class="amt">${cell(r.po && r.po.quantity, r.inv && r.inv.quantity, q)}</td>
        <td class="amt">${cell(r.po && r.po.unitCost, r.inv && unitFor(r.inv, r.invAmt), money)}</td>
        <td class="amt">${cell(r.po && r.po.amount, r.invAmt, money)}</td>
        <td><span class="badge b-${r.status}">${r.append&&r.status==='same'?'Already on PO':LABEL[r.status]}</span></td>`;
      const cbx = tr.querySelector('input[type=checkbox]');
      if (cbx) cbx.onchange = () => { r.apply = cbx.checked; if(aiReviewRequired)$('qaireview').checked=false; if(r.append)renderCmp(); };
      t.appendChild(tr);
    });
    const append=cmp.some(r=>r.append);
    if(append)invSum=poSum+cmp.filter(r=>r.status==='new'&&r.apply).reduce((sum,r)=>sum+r.invAmt,0);
    const d = r2(invSum - poSum);
    const summary = [];
    if (nChg) summary.push(`${nChg} line(s) to ${append?'add':'change'}`);
    if(append)summary.push('Existing PO lines retained');
    if(cmp.some(r=>r.status==='conflict'))summary.push('Review duplicate invoice references before applying');
    if (nMissing) summary.push(`${nMissing} not on invoice - untick to keep`);
    $('qctot').innerHTML = `<span>${summary.length ? `<span class="warn">${summary.join(' · ')}</span>` : 'PO already matches the invoice ✓'}</span>` +
      `<span>PO ${money(r2(poSum))} → ${append?'After additions':'Invoice'} <b>${money(r2(invSum))}</b> <span class="${d ? 'chg' : ''}">(${d >= 0 ? '+' : ''}${money(d)})</span></span>`;
    $('qapply').style.display = nChg || nMissing ? 'block' : 'none';
    $('qapply').textContent=append?'Add ticked invoice lines':'Apply ticked changes';
    $('qcmp').style.display = 'block';
    $('qhint').style.display = 'none';
  }

  async function layoutRequest(action,extra={}) {
    const endpoint=aiEndpoint($('qaiurl').value.trim()),token=$('qaitoken').value.trim();
    if(token.length<32||/^sk-/.test(token))throw new Error('Enter your saved AI service URL and proxy token first.');
    const body=JSON.stringify({protocolVersion:1,action,...extra});
    if(body.length>750000)throw new Error('This document is too large for layout learning. Use a smaller one-page example.');
    const response=await fetch(new URL('/templates',endpoint).href,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000),body});
    const raw=await response.text();if(raw.length>1000000)throw new Error('Saved layout response is too large');
    let result;try{result=JSON.parse(raw);}catch{throw new Error('Saved layout service returned invalid JSON');}
    if(!response.ok){const error=new Error(typeof result.error==='string'?result.error.slice(0,500):'Saved layout service returned HTTP '+response.status);error.status=response.status;throw error;}
    if(result.protocolVersion!==1)throw new Error('Saved layout protocol mismatch');return result;
  }

  async function tryLearnedLayout(all) {
    if(!$('quselearned')?.checked)return null;
    try{
      const result=await layoutRequest('match',{items:all});
      if(!result.match){if(result.knownSupplier){const error=new Error('This supplier has saved layouts, but none passed the layout and total checks. Use Read with AI and review this document.');error.layoutReviewRequired=true;throw error;}return null;}
      // Reapply the declarative rules to this PDF locally. Never trust stored
      // sample amounts or execute server-provided parsing code.
      let lines;try{lines=applyTemplate(result.match.template,all);}catch{const error=new Error('Saved layout did not pass local validation. Use Read with AI and review this document.');error.layoutReviewRequired=true;throw error;}
      log('Read using saved layout '+result.match.name+'. Reconciled quantities, net, GST and total locally. No AI request was made. Review the preview before adding.');
      return lines;
    }catch(error){if(error.layoutReviewRequired||error.status===422)throw error;log('Saved layout was not used: '+error.message+'. Trying the standard parser; use Read with AI if needed.');return null;}
  }

  async function learnReviewedLayout() {
    if(!learningSource||!aiReviewRequired||!$('qaireview').checked)throw new Error('Read with AI, check every line against the PDF, then tick the review confirmation before learning.');
    const name=$('qlayoutname').value.trim();if(!name||name.length>80)throw new Error('Enter a layout name of 1–80 characters.');
    const reviewed=(mode==='new'?items:cmp.filter(r=>r.inv).map(r=>r.inv)).map(i=>({...i,amount:r2(i.quantity*i.unitCost)}));
    // Test on the exact training document before saving anything to the NAS.
    trainTemplate(learningSource,reviewed,name);
    const result=await layoutRequest('learn',{items:learningSource,reviewed,name});
    $('quselearned').checked=true;localStorage.setItem('qpoUseLearnedLayouts','1');
    log('Saved layout '+result.name+' on your NAS. Future matching PDFs will try these rules before the standard parser. Unmatched layouts still need AI review.');
    toast('Layout saved. Future matching PDFs can be read without AI.');
  }

  async function showSavedLayouts() {
    const box=$('qlayoutlist');box.textContent='Loading saved layouts…';
    try{
      const result=await layoutRequest('list');box.textContent='';
      if(!Array.isArray(result.templates))throw new Error('Invalid saved layout list');
      if(!result.templates.length){box.textContent='No saved layouts yet.';return;}
      for(const layout of result.templates){
        const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');
        label.textContent=layout.name+' · ABN '+layout.abn+' ';button.textContent='Delete layout';button.className='ghost';button.type='button';
        button.onclick=()=>runBusy(button,'Deleting…',async()=>{await layoutRequest('delete',{id:layout.id});await showSavedLayouts();});
        const details=document.createElement('details'),summary=document.createElement('summary'),rules=document.createElement('pre');summary.textContent='View saved rules';rules.textContent=JSON.stringify(validateTemplate(layout.template),null,2);details.append(summary,rules);row.append(label,button,details);box.append(row);
      }
    }catch(error){box.textContent=error.message;}
  }

  function saveAiSettings() {
    const endpoint=aiEndpoint($('qaiurl').value.trim()),token=$('qaitoken').value.trim();
    if(token.length<32||/^sk-/.test(token))throw new Error('Enter your proxy access token (32+ characters), not an OpenAI API key.');
    const remember=$('qairemember').checked;
    try {
      localStorage.setItem('qpoAiEndpoint',endpoint);
      sessionStorage.setItem('qpoAiProxyToken',token);
      if(remember)localStorage.setItem('qpoAiProxyToken',token);
      else localStorage.removeItem('qpoAiProxyToken');
      localStorage.setItem('qpoAiRememberToken',remember?'1':'0');
      localStorage.setItem('qpoAiShareConsentEndpoint',$('qaiconsent').checked?endpoint:'');
    } catch { throw new Error('The browser blocked saving AI settings. Allow site storage for Nexvia and retry.'); }
    return {endpoint,token};
  }

  function loadAiSettings() {
    try {
      $('qaiurl').value=localStorage.getItem('qpoAiEndpoint')||'';
      const remember=localStorage.getItem('qpoAiRememberToken')==='1';
      $('qairemember').checked=remember;
      $('qaiconsent').checked=!!$('qaiurl').value && localStorage.getItem('qpoAiShareConsentEndpoint')===$('qaiurl').value;
      $('qaitoken').value=(remember?localStorage.getItem('qpoAiProxyToken'):sessionStorage.getItem('qpoAiProxyToken'))||'';
    } catch { log('Browser storage is unavailable. AI settings cannot be restored.'); }
  }

  async function readAiDoc() {
    const files=Array.from($('qfile').files);
    if(files.length!==1||!files[0].name.toLowerCase().endsWith('.pdf')||$('qtext').value.trim())throw new Error('Read with AI supports one PDF at a time. Clear pasted text first.');
    if(mode==='inv'&&$('qinvoiceAction').value!=='append')throw new Error('For AI extraction, choose Add invoices. AI cannot replace or delete existing PO lines.');
    if(!$('qaiconsent').checked)throw new Error('Confirm sharing this PDF’s extracted text with your AI service and OpenAI first.');
    const {endpoint,token}=saveAiSettings();
    if(files[0].size>20*1024*1024)throw new Error('Use a PDF smaller than 20 MB for AI extraction.');
    const all=await pdfToItems(files[0]);
    try { registerFileMetadata.set(files[0],extractRegisterPdfMetadata(all)); } catch {}
    const pages=[...new Set(all.map(i=>i.page))];
    if(pages.length>40)throw new Error('Read with AI supports up to 40 pages.');
    const parts=[];
    for(const page of pages){
      parts.push('Page '+page);
      const rows=[];
      all.filter(i=>i.page===page).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{
        const row=rows.find(r=>Math.abs(r.y-i.y)<3);if(row)row.t.push(i);else rows.push({y:i.y,t:[i]});
      });
      for(const row of rows)parts.push(row.t.sort((a,b)=>a.x-b.x).map(i=>i.s).join(' | '));
    }
    const text=parts.join('\n');
    if(text.length<30||text.length>200000)throw new Error('Extracted text must contain 30–200000 characters. Split this document or use the standard parser.');
    log('Sending extracted text from '+pages.length+' page(s) to your AI service. This builds a review preview only.');
    let response;
    try{response=await fetch(endpoint,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      signal:AbortSignal.timeout(105000),body:JSON.stringify({protocolVersion:1,text})});}
    catch{throw new Error('Could not reach the AI service. Check its URL, access token, CORS and Nexvia content policy. No PO changes were made.');}
    if(Number(response.headers.get('Content-Length')||0)>1000000)throw new Error('AI response is too large.');
    const raw=await response.text();if(raw.length>1000000)throw new Error('AI response is too large.');
    let result;
    try{result=JSON.parse(raw);}catch{throw new Error('AI service returned HTTP '+response.status+' with invalid JSON. No preview was kept.');}
    if(!response.ok){
      const detail=typeof result.error==='string'?result.error.replace(/[\u0000-\u001f]/g,' ').slice(0,400):'Check the service or use the standard parser.';
      throw new Error('AI service HTTP '+response.status+': '+detail+' No preview was kept.');
    }
    if(result.protocolVersion!==1)throw new Error('AI service protocol version is incompatible.');
    const lines=validateAiExtraction(result.document,text);
    learningSource = all.map(i=>({page:i.page,x:i.x,y:i.y,w:i.w||0,s:i.s}));
    log('AI preview: '+lines.length+' line(s), $'+result.document.subtotal.toFixed(2)+' ex GST + $'+result.document.gst.toFixed(2)+' GST = $'+result.document.total.toFixed(2)+'. Compare every line and tax setting with the PDF before adding.');
    return lines;
  }

  function aiPreviewAllowed() {
    if(!aiReviewRequired)return true;
    if(!$('qaireview').checked){toast('Review the AI lines and tick the confirmation before adding.',false);return false;}
    if(mode==='inv'&&$('qinvoiceAction').value!=='append'){toast('AI results can only add invoice lines.',false);return false;}
    return true;
  }

  async function readDoc() {
    const files=Array.from($('qfile').files);
    if(files.length<=1)return readSingleDoc(files[0],$('qtext').value);
    if(!checkSupplierRef())throw new Error('Complete the Supplier Ref for every selected PDF first.');
    const refs=documentReferences(),seen=new Set(),out=[];
    for(let index=0;index<files.length;index++){
      const file=files[index];
      if(!/\.pdf$/i.test(file.name))throw new Error('Choose PDF documents only: '+file.name);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');
      if(seen.has(hash))throw new Error('The same PDF was selected more than once: '+file.name+'. Remove the duplicate before reading again.');
      seen.add(hash);log('Reading document '+(index+1)+'/'+files.length+': '+file.name);
      const lines=await readSingleDoc(file,'');
      if(!lines?.length)throw new Error('No items were read from '+file.name+'. No batch preview was kept.');
      lines.forEach(line=>out.push({...line,supplierRef:refs[index].reference,sourceName:file.name}));
    }
    if($('qtext').value.trim()){
      const lines=await readSingleDoc(null,$('qtext').value);
      lines.forEach(line=>out.push({...line,supplierRef:$('qref').value.trim(),sourceName:'Pasted lines'}));
    }
    log('Read '+files.length+' PDFs into one batch: '+out.length+' line(s). Each document keeps its own supplier reference.');
    return out;
  }

  async function readSingleDoc(f, pastedText) {
    let incGst = false;
    let usedOcr = false;
    let lines = [];
    let fromPdf = null;
    if (f) {
      const all = await pdfToItems(f);
      try { registerFileMetadata.set(f,extractRegisterPdfMetadata(all)); } catch {}
      usedOcr = !!all.ocr;
      // "incl. GST" shown on its own (e.g. under the total) and no separate GST/tax amount line
      incGst = all.some((i) => /^inc(l(uding|\.)?)?\.?\s*gst\.?$/i.test(i.s)) &&
        !all.some((i) => /^(total\s*)?(gst|tax)(\s*10%)?:?$/i.test(i.s));
      fromPdf = await tryLearnedLayout(all);
      if (!fromPdf) fromPdf = parseBydAspleyService(all);
      if (!fromPdf) fromPdf = parseMiddayAluminium(all);
      if (!fromPdf) fromPdf = parsePremierScaffolds(all);
      if (!fromPdf) fromPdf = parseNutBolt(all);
      if (!fromPdf) fromPdf = parseJobfit(all);
      if (!fromPdf) fromPdf = parseMainfreight(all);
      if (!fromPdf) fromPdf = parseOfficeworks(all);
      if (!fromPdf) fromPdf = parseK1Invoice(all);
      if (!fromPdf) fromPdf = parseCapralInvoice(all);
      if (!fromPdf) fromPdf = parseVelocityService(all);
      if (!fromPdf) fromPdf = parseEastCoast(all);
      if (!fromPdf) fromPdf = parseOrderAcknowledgement(all);
      if (!fromPdf) fromPdf = parseAreaPriceTable(all);
      if (!fromPdf) fromPdf = parseGstAmountTable(all);
      if (!fromPdf) fromPdf = parseHireTable(all);
      if (!fromPdf) {
        fromPdf = parseAmountTable(all);
        if (fromPdf) log('Read Description / Amount service lines as quantity 1 per charge. Check these lump-sum lines against the PDF.');
      }
      if (!fromPdf) {
        fromPdf = parseDeliveryTable(all);
        if (fromPdf) log('Read PDF using its Product Description / Total Quantity / Pricing Unit / Rate / Total columns.');
      }
      if (!fromPdf) {
        fromPdf = parseLineBlocks(all);
        if (fromPdf) log('Read PDF as a line-numbered quote (Sales Qty / Unit Pr / Line Amount).');
      }
      if (!fromPdf) { fromPdf = parseColumnar(all); if (fromPdf) log('Read PDF using its Qty / Description / Amount columns.'); }
      if (!fromPdf) { fromPdf = parseTable(all); if (fromPdf) log('Read PDF as a table (one row per item).'); }
      if (!fromPdf) {
        if (usedOcr) throw new Error('OCR read this scan but could not identify its item table. Clear the PDF and paste the item lines manually.');
        lines = await pdfToLines(f); log('Read PDF line by line - please check the lines carefully.');
      }
    }
    if (pastedText.trim()) lines = lines.concat(pastedText.split(/\r?\n/));
    if (!fromPdf && !lines.length) return null;
    const res = (fromPdf || []).concat(lines.length ? parseLines(lines) : []);
    if (!res.length) throw new Error('No line items could be read. Check the PDF layout, or clear the PDF and paste the item lines manually.');
    if (usedOcr) {
      res.forEach((it) => { it.check = 'check'; });
      log('OCR result: check every description, quantity, price and total against the PDF before applying.');
    }
    if(f&&fromPdf?.[0]?.documentMetadata&&typeof registerFileMetadata!=='undefined')registerFileMetadata.set(f,fromPdf[0].documentMetadata);
    if (f && fromPdf && incGst) {
      const inclusiveLines=res.filter((it) => !Number.isFinite(it.gstAmount));
      inclusiveLines.forEach((it) => {
        const amt = !isNaN(it.amount) ? it.amount : it.quantity * it.unitCost;
        it.amount = r2(amt / 1.1);
        it.unitCost = it.quantity ? +(amt / 1.1 / it.quantity).toFixed(4) : it.amount;
      });
      if (inclusiveLines.length) log('Prices on this PDF include GST - converted to ex GST (÷ 1.1).');
    }
    return res;
  }

  function clearReadPreview() {
    if(typeof invalidateRegisterRead==='function')invalidateRegisterRead();
    aiReviewRequired = false;
    if($('qroundingnotice')){$('qroundingnotice').textContent='';$('qroundingnotice').style.display='none';}
    learningSource = null;
    $('qaireview').checked = false;
    $('qaireviewwrap').style.display = 'none';
    items = []; cmp = [];
    $('qlines').style.display = 'none'; $('qcmp').style.display = 'none';
    $('qapply').style.display = 'none'; $('qhint').style.display = 'block';
  }

  $('qrounding').onchange=()=>clearReadPreview();
  $('qparse').onclick = () => runBusy($('qparse'), aiReadRequested ? 'Reading with AI…' : mode === 'new' ? 'Reading quote…' : 'Comparing PO…', async () => {
    clearReadPreview();
    try {
      if(mode==='inv' && $('qinvoiceAction').value==='match' && $('qfile').files.length>1)throw new Error('Use Add invoices to combine multiple PDFs. Match PO compares one document at a time.');
      const append=mode==='inv'&&$('qinvoiceAction').value==='append';
      if(append&&!checkSupplierRef())return;
      // One read action refreshes local Nexvia details as well as PDF lines.
      // This is independent of the register toggle and never writes to the PO.
      try{
        autofillRegisterDetails(true);
        const message=$('qregisterautostatus')?.textContent;
        if(message)log('Nexvia details: '+message);
      }catch(error){log('Nexvia details could not refresh: '+error.message+'. Continuing with the PDF read; check the details manually.');}
      const got = aiReadRequested ? await readAiDoc() : await readDoc();
      if (!got) return toast('Choose a PDF or paste some lines first', false);
      if($('qroundingnotice')){const notes=[...new Set(got.map(i=>i.roundingNote).filter(Boolean))];$('qroundingnotice').textContent=notes.join(' ');$('qroundingnotice').style.display=notes.length?'block':'none';}
      aiReviewRequired = got.some(it => it.aiGenerated);
      $('qaireviewwrap').style.display = aiReviewRequired ? 'block' : 'none';
      // Both quote imports and invoice additions must use Nexvia's labels.
      // Refresh from the live PO so a cached list cannot keep an old unit name.
      if (got.some((it) => it.measure)) {
        await measOpts.load();
        got.forEach((it) => { it.measure = matchMeasure(it.measure); });
      }
      if (mode === 'new') {
        items = got;
        $('qstart').value = 1;
        log(`Found ${items.length} line item(s). Check them against the quote, then click "Add lines".`);
        render();
      } else {
        if (!got.length) return toast('No invoice lines could be read. Check the document before comparing.', false);
        const po = readPoLines();
        if (!po.length && !append) return toast('No lines found on this PO', false);
        syncInvoiceAccount(po, true);
        syncInvoiceBreakdown(po, true);
        if(append)got.forEach(it=>{it.supplierRef=it.supplierRef||$('qref').value.trim();});
        cmp = append?compareAppendInvoice(got,po):compareInvoice(got, po);
        const c = (s) => cmp.filter((r) => r.status === s).length;
        log(`Invoice: ${got.length} line(s). PO: ${po.length} line(s). ${c('same')} same, ${c('changed')} changed, ${c('new')} not on PO, ${c('missing')} not on invoice.`);
        if(append)log('Add invoices: '+c('new')+' new line(s), '+c('same')+' already on PO, '+c('conflict')+' conflict(s). All existing PO lines are retained.');
        else if (!c('same') && !c('changed')) {
          log('No product-code matches found. Invoice lines are selected for addition and existing PO lines for deletion. Untick any existing lines you want to keep.');
          log('Existing PO codes: ' + po.map((line) => codeOf(line.description)).join(', '));
        }
        renderCmp();
      }
      try { refreshRegisterFromRead(got); } catch(e) { log('Register preview could not refresh: '+e.message); }
    } catch (e) { clearReadPreview(); log('Read error: ' + e.message); }
    finally { aiReadRequested = false; }
  });

  loadAiSettings();
  $('quselearned').checked = localStorage.getItem('qpoUseLearnedLayouts')==='1';
  $('quselearned').onchange = () => localStorage.setItem('qpoUseLearnedLayouts',$('quselearned').checked?'1':'0');
  $('qlayoutmanage').onclick = () => runBusy($('qlayoutmanage'),'Loading…',showSavedLayouts);
  $('qlearn').onclick = () => runBusy($('qlearn'),'Learning…',learnReviewedLayout);
  $('qaiurl').addEventListener('input', () => { $('qaiconsent').checked = false; });
  $('qaisave').onclick = () => {
    if(busy)return;
    try { saveAiSettings(); toast($('qairemember').checked?'AI settings saved on this device.':'AI URL saved; access token saved for this tab.'); }
    catch(error){toast(error.message,false);}
  };
  $('qaiconsent').addEventListener('change', () => {
    if (!$('qaiconsent').checked) { try { localStorage.removeItem('qpoAiShareConsentEndpoint'); } catch {} }
  });
  $('qai').onclick = () => { if (busy) return; aiReadRequested = true; return $('qparse').onclick(); };

  async function runBusy(btn, label, fn) {
    if (busy) return;
    busy = true;
    const txt = btn.textContent;
    const previousBusy = btn.getAttribute('aria-busy');
    const controls = [...panel.querySelectorAll('input, textarea, select, button')]
      .map((el) => ({ el, disabled: el.disabled }));
    controls.forEach(({ el }) => { el.disabled = true; });
    btn.disabled = true; btn.textContent = label;
    btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true');
    try { await fn(); }
    catch (e) { log('ERROR: ' + e.message); toast('✕ Action stopped - see the log', false); }
    finally {
      busy = false;
      controls.forEach(({ el, disabled }) => { el.disabled = disabled; });
      syncRegisterLocks();
      btn.textContent = txt;
      btn.classList.remove('is-loading');
      if (previousBusy == null) btn.removeAttribute('aria-busy');
      else btn.setAttribute('aria-busy', previousBusy);
    }
  }

  $('qgo').onclick = () => {
    if (busy || !aiPreviewAllowed() || !checkSupplierRef() || !checkAcct()) return;
    return runBusy($('qgo'), 'Uploading / adding…', async () => {
      const error=validationError();if(error){log('Fix the existing Nexvia validation error first: '+error);return;}
      if(!items.some(i=>i.description)){log('Read and review the PDF before adding lines.');return;}
      preflightPoWorkflow();
      if(items.some(i=>i.roundingNote))await checkRoundingService(items);
      const saveFiles=$('qattach').checked?Array.from($('qfile').files):[];
      if (saveFiles.length) {
        if(uploadedPoFiles(saveFiles))log('Selected PDF(s) are already attached; continuing without another upload.');
        else{
          if (!(await attachFile())) { log('Stopped before adding lines: the requested PDF upload could not be started.'); return; }
          log('PDF upload started first. Adding PO lines while Nexvia uploads the PDF(s).');
        }
      }
      const ok = await pushToNexvia(items.filter((i) => i.description));
      if (!ok) { if(saveFiles.length)log('PO line import was not completed. The PDF may already be attached; review the PO before retrying. No automatic save was attempted.'); return; }
      await autoSavePoAfterChecks(saveFiles);
    });
  };

  $('qapply').onclick = () => {
    if (busy || !aiPreviewAllowed() || !checkSupplierRef()) return;
    const todo=cmp.filter(r=>r.apply&&['new','changed','missing'].includes(r.status));
    if(!todo.length){toast('Nothing ticked to change',false);return;}
    if(cmp.some(r=>r.status==='conflict')){log('Review invoice conflicts before uploading or changing the PO.');return;}
    if(todo.some(r=>r.status==='new')&&!checkAcct())return;
    return runBusy($('qapply'), 'Uploading / updating…', async () => {
      const error=validationError();if(error){log('Fix the existing Nexvia validation error first: '+error);return;}
      preflightPoWorkflow();
      const invoice = cmp.filter((r) => r.inv).map((r) => r.inv);
      if(invoice.some(i=>i.roundingNote))await checkRoundingService(invoice);
      const saveFiles=$('qattach').checked?Array.from($('qfile').files):[];
      if (saveFiles.length) {
        if(uploadedPoFiles(saveFiles))log('Selected PDF(s) are already attached; continuing without another upload.');
        else{
          if (!(await attachFile())) { log('Stopped before changing lines: the requested PDF upload could not be started.'); return; }
          log('PDF upload started first. Updating PO lines while Nexvia uploads the PDF(s).');
        }
      }
      if (!(await applyInvoice(cmp))) { if(saveFiles.length)log('PO line update was not completed. The PDF may already be attached; review the PO before retrying. No automatic save was attempted.'); return; }
      // Recheck against the current PO before attempting its final save.
      cmp = $('qinvoiceAction').value==='append'?compareAppendInvoice(invoice,readPoLines()):compareInvoice(invoice, readPoLines()); renderCmp();
      await autoSavePoAfterChecks(saveFiles);
    });
  };

  initRegister(runBusy);
  initPoSave(runBusy);
  setMode(mode);
  console.log('[Quote→PO] v2.06 button added');
  }

  // Show the button on any Nexvia page that has the PO line grid.
  // Re-adds it if Nexvia redraws the page.
  const onPoPage = () => document.body && document.body.textContent.includes(CFG.addRowText);
  setInterval(() => {
    try {
      if (!document.getElementById('qpoRoot') && onPoPage()) mount();
    } catch (e) { console.error('[Quote→PO] mount error', e); }
  }, 1000);

  // Ctrl+Alt+Q opens the panel even if the button is hidden behind something
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'q') {
      if (!document.getElementById('qpoRoot')) mount();
      $('qpo').style.display = 'block'; $('qpoBtn').style.display = 'none';
    }
  });
  console.log('[Quote→PO] v2.06 loaded');
})();
