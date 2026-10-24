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
export function validateTemplate(t){
 const keys=['version','name','abn','basis','taxRate','measure','columns','descriptionLeft','descriptionRight','headers','unit'];
 if(!t||Object.keys(t).some(k=>!keys.includes(k))||t.version!==1||typeof t.name!=='string'||!t.name.trim()||t.name.length>80||/[<>\x00-\x1f]/.test(t.name)||!/^\d{11}$/.test(t.abn)||!['net','gross'].includes(t.basis)||![0,.1].includes(t.taxRate)||typeof t.measure!=='string'||t.measure.length>80||/[<>\x00-\x1f]/.test(t.measure))throw Error('Invalid declarative template');
 if(!t.columns||Object.keys(t.columns).sort().join(',')!=='amount,price,quantity'||!Object.values(t.columns).every(n=>Number.isFinite(n)&&n>=0&&n<=5000)||!(t.columns.quantity+15<t.columns.price&&t.columns.price+15<t.columns.amount))throw Error('Invalid template columns');
 if(![t.descriptionLeft,t.descriptionRight].every(n=>Number.isFinite(n)&&n>=0&&n<=5000)||!(t.descriptionLeft<t.descriptionRight&&t.descriptionRight<t.columns.price))throw Error('Invalid description bounds');
 if(!t.unit||Object.keys(t.unit).sort().join(',')!=='text,x'||typeof t.unit.text!=='string'||!/^[a-z²/ ]{1,30}$/.test(t.unit.text)||!Number.isFinite(t.unit.x)||t.unit.x<t.columns.price||t.unit.x>t.columns.amount)throw Error('Invalid printed unit rule');
 if(!Array.isArray(t.headers)||t.headers.length!==4||new Set(t.headers.map(h=>h.role)).size!==4||!t.headers.every(h=>Object.keys(h).sort().join(',')==='role,text,w,x'&&['quantity','description','price','amount'].includes(h.role)&&typeof h.text==='string'&&/^[a-z ]{2,30}$/.test(h.text)&&[h.x,h.w].every(n=>Number.isFinite(n)&&n>=0&&n<=5000)))throw Error('Invalid header anchors');
 return structuredClone(t);
}
export function applyTemplate(template,input){
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
export function trainTemplate(input,reviewed,name){
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

export function readSupplierAbn(input){return abn(checkItems(input));}
