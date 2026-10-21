// ==UserScript==
// @name         Nexvia - Quote to PO Lines
// @namespace    lennox-nexvia
// @version      1.59
// @description  Import supplier quote lines into a Nexvia PO, or update an existing PO from the supplier invoice
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (!/nexvia/i.test(location.hostname)) return;
  console.log('[Quote→PO] v1.59 starting on', location.href);

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
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!ocrLoader) ocrLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = OCR_CDN + 'tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => { ocrLoader = null; reject(new Error('Could not load the OCR reader. Clear the PDF and paste the item lines instead.')); };
      document.head.appendChild(script);
    });
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
    const h = findHeader(headerText);
    if (!h) return null;
    h.scrollIntoView({ block: 'nearest', inline: 'center' });
    const hr = h.getBoundingClientRect();
    const x = hr.left + hr.width / 2;
    return [...row.querySelectorAll('td, .tabulator-cell, [role=gridcell]')]
      .find((c) => { const r = c.getBoundingClientRect(); return r.left <= x && x <= r.right; }) || null;
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
      const boundMatch = item != null && normalizedText(dropdownText(item, tf)) === t &&
        (expectedId == null || itemId != null && String(itemId) === String(expectedId));
      const uidMatch = !!(match?.uid && uid === match.uid);
      const labelMatch = [node.textContent, node.getAttribute?.('aria-label'), node.getAttribute?.('title')]
        .some((label) => label != null && normalizedText(label) === t);
      const visible = !node.getClientRects || node.getClientRects().length > 0;
      const disabled = node.getAttribute?.('aria-disabled') === 'true' ||
        node.getAttribute?.('role') === 'group' || node.classList?.contains('k-list-group-item') ||
        node.classList?.contains('k-disabled') || node.classList?.contains('k-state-disabled');
      return { node, item, visible, disabled, matches: boundMatch || uidMatch || labelMatch };
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
      log('Breakdown dropdown diagnostic: ' + JSON.stringify({ version: '1.55', reason,
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

  async function selectByText(w, text, exact = false) {
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
      const data = Array.from(ds.data() || []).filter((d) => d != null && textOf(d));
      const matches = data.filter((d) => textOf(d) === t);
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
    if (!match) return false;
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

  async function editCell(row, headerText, value) {
    try { return await editCellValue(row, headerText, value); }
    catch (error) { throw new Error(`Could not set ${headerText}: ${error.message}`); }
  }

  async function editCellValue(row, headerText, value) {
    if (value === '' || value == null) return true;
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
        const ok = await selectByText(w, value, headerText === CFG.cols.breakdown || headerText === CFG.cols.tax);
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
      const exact = [...ed.options].filter((o) => normalizedText(o.text) === normalizedText(value));
      const opt = headerText === CFG.cols.breakdown || headerText === CFG.cols.tax ? (exact.length === 1 ? exact[0] : null) :
        exact[0] || [...ed.options].find((o) => normalizedText(o.text).includes(normalizedText(value)));
      if (!opt) { log(`No "${value}" option in ${headerText}`); return false; }
      ed.value = opt.value; ed.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
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

  async function verifyBreakdown(row, expected) {
    let actual = '';
    for (let i = 0; i < 10; i++) {
      actual = cellText(liveRow(row), CFG.cols.breakdown);
      if (normalizedText(actual) === normalizedText(expected)) return;
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
      if (!(await editCell(row(), col, v))) throw new Error(`${col}: no option matching "${v}"`);
    }
    if (requireBreakdown) await verifyBreakdown(row(), breakdown);
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
      try { await verifyBreakdown(row(), breakdown); }
      catch (error) {
        if (referenceInfo) log('Breakdown diagnostic (existing reference): ' + JSON.stringify(referenceInfo));
        log('Breakdown diagnostic (before save): ' + JSON.stringify(beforeSave));
        log(`Nexvia did not retain Breakdown Type "${breakdown}". Reapplying it once and checking the saved row again.`);
        if (!(await editCell(row(), CFG.cols.breakdown, breakdown))) throw error;
        await verifyBreakdown(row(), breakdown);
        await fillNumbers();
        await saveRow(row());
        await verifyBreakdown(row(), breakdown);
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

  async function setBatchNotes(refs) {
    refs=[...new Set(refs.filter(Boolean))];
    if(refs.length>1){
      const input=poNotesBox();let value=input.value;
      for(const ref of refs)if(!value.split(/\r?\n/).some(line=>line.trim()==='Supplier reference: '+ref))value+=(value&&!/\n$/.test(value)?'\n':'')+'Supplier reference: '+ref;
      if(input.maxLength>0 && value.length>input.maxLength)throw new Error('The supplier references would exceed the PO Notes length limit. No PO lines were changed.');
    }
    for(const ref of refs)await setPoNotesReference(ref);
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
    await setBatchNotes(refs);
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
    await setBatchNotes(refs);
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
    const money = (v) => '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    log(`Done - ${upd} updated, ${add} added, ${removed} deleted. PO total ${money(before)} → ${money(after)}. Click Save in Nexvia.`);
    toast(`✓ PO updated - ${upd} changed, ${add} added, ${removed} deleted. Total ${money(before)} → ${money(after)}. Click Save.`);
    return true;
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
          <label><input type="checkbox" id="qattach"> Attach the selected PDFs to the PO when finished</label>
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
          <button class="pri" id="qparse">Read quote</button>
        </div>
        <small id="qhint" style="margin:0">Choose a PDF above, then click the button.</small>
        <div id="qlines" style="display:none">
          <div class="tblwrap"><table id="qtbl"></table></div>
          <div class="tot" id="qtot"></div>
          <button class="go" id="qgo">Add lines to Nexvia PO</button>
        </div>
        <div id="qcmp" style="display:none">
          <div class="tblwrap"><table id="qctbl"></table></div>
          <div class="tot" id="qctot"></div>
          <button class="go" id="qapply">Apply ticked changes</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:0">
        <div class="loghead">
          <div class="h" style="margin:0">Log</div>
          <div><button class="ghost" id="qdbg">Debug grid</button> <button class="ghost" id="qclear">Clear log</button></div>
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
        const list = Array.from(w.dataSource.data() || []).map((d) => dropdownText(d, tf)).filter(Boolean);
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
  const openPanel = () => { $('qpo').style.display = 'block'; $('qpoBtn').style.display = 'none'; };
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
        it[k] = (k === 'quantity' || k === 'unitCost') ? num(inp.value) : inp.value;
        it.check = 'ok'; render();
      });
      tr.querySelector('[data-del]').onclick = () => { items.splice(i, 1); render(); };
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
      if (cbx) cbx.onchange = () => { r.apply = cbx.checked; if(r.append)renderCmp(); };
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
      usedOcr = !!all.ocr;
      // "incl. GST" shown on its own (e.g. under the total) and no separate GST/tax amount line
      incGst = all.some((i) => /^inc(l(uding|\.)?)?\.?\s*gst\.?$/i.test(i.s)) &&
        !all.some((i) => /^(total\s*)?(gst|tax)(\s*10%)?:?$/i.test(i.s));
      fromPdf = parseEastCoast(all);
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
    items = []; cmp = [];
    $('qlines').style.display = 'none'; $('qcmp').style.display = 'none';
    $('qapply').style.display = 'none'; $('qhint').style.display = 'block';
  }

  $('qparse').onclick = () => runBusy($('qparse'), mode === 'new' ? 'Reading quote…' : 'Comparing PO…', async () => {
    clearReadPreview();
    try {
      if(mode==='inv' && $('qinvoiceAction').value==='match' && $('qfile').files.length>1)throw new Error('Use Add invoices to combine multiple PDFs. Match PO compares one document at a time.');
      const append=mode==='inv'&&$('qinvoiceAction').value==='append';
      if(append&&!checkSupplierRef())return;
      const got = await readDoc();
      if (!got) return toast('Choose a PDF or paste some lines first', false);
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
    } catch (e) { log('Read error: ' + e.message); }
  });

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
      btn.textContent = txt;
      btn.classList.remove('is-loading');
      if (previousBusy == null) btn.removeAttribute('aria-busy');
      else btn.setAttribute('aria-busy', previousBusy);
    }
  }

  $('qgo').onclick = () => {
    if (busy || !checkSupplierRef()) return;
    return runBusy($('qgo'), 'Adding lines…', async () => {
      const ok = await pushToNexvia(items.filter((i) => i.description));
      if (ok && $('qattach').checked && $('qfile').files[0]) {
        if (await attachFile()) toast(`✓ Import complete - ${ok} line(s) added and selected PDFs sent to the upload box. Check totals, then click Create.`);
      }
    });
  };

  $('qapply').onclick = () => {
    if (busy || !checkSupplierRef()) return;
    return runBusy($('qapply'), 'Updating PO…', async () => {
      const invoice = cmp.filter((r) => r.inv).map((r) => r.inv);
      if (!(await applyInvoice(cmp))) return;
      if ($('qattach').checked && $('qfile').files[0]) {
        if (await attachFile()) log('Selected invoice PDF(s) sent to the upload box. Check upload completion in Nexvia.');
      }
      // refresh the comparison so you can see the result
      cmp = $('qinvoiceAction').value==='append'?compareAppendInvoice(invoice,readPoLines()):compareInvoice(invoice, readPoLines()); renderCmp();
    });
  };

  setMode(mode);
  console.log('[Quote→PO] v1.59 button added');
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
  console.log('[Quote→PO] v1.59 loaded');
})();
