const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.NEXVIA_TEST_SCRIPT || path.join(__dirname,'../downloads/nexvia-quote-to-po-v1.55.user.js'),'utf8');

function harness(items, options = {}) {
  const messages = [];
  const file = { arrayBuffer: async () => new ArrayBuffer(0) };
  const ui = { qfile: { files: [file] }, qtext: { value: '' } };
  const pages = Math.max(...items.map((item) => item.page));
  const context = vm.createContext({
    console: { log() {} },
    location: { hostname: 'nexvia.test', href: 'https://nexvia.test/po' },
    window: { pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({
      numPages: pages,
      getPage: async (page) => ({ getTextContent: async () => ({
        items: items.filter((item) => item.page === page).map((item) => ({
          str: item.s, transform: [1, 0, 0, 1, item.x, item.y], width: item.w,
        })),
      }) }),
    }) }) } },
    getUi: (id) => ui[id],
    recordLog: (message) => messages.push(message),
    readScanned: async () => {
      if (options.ocrFailure) throw new Error(options.ocrFailure);
      return options.ocrItems;
    },
  });
  const parsingSource = source.slice(0, source.indexOf('  // ---------- NEXVIA GRID ----------'));
  const readDocSource = source.slice(source.indexOf('  async function readDoc() {'), source.indexOf("  $('qparse').onclick"));
  vm.runInContext(parsingSource + `
    const $ = getUi;
    const log = recordLog;
    ${readDocSource}
    ${options.ocrItems || options.ocrFailure ? 'ocrPdfPages = readScanned;' : ''}
    globalThis.api = { num, isNum, parseTable, parseColumnar, parseLineBlocks, parseLines, parseAmountTable, needsOcr, ocrWordsToItems, readDoc };
  })();`, context);
  return { api: context.api, messages };
}

// Real PDF.js geometry, retaining only the item table and financial totals.
// Customer addresses, references and account details have been omitted.
const order = require('./fixtures/order-acknowledgement-items.json');
const round = value => Math.round(value * 100) / 100;

test('order acknowledgement reads Quantity Ordered and $/EA, retaining code, dimensions and finish', async () => {
  const { api,messages }=harness(order);
  const lines=await api.readDoc();
  assert.equal(lines.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(lines[0])),{
    description:'100129 3.00 1200 2400 MF 5005 H34 MILL FINISH',
    quantity:4,unitCost:174.23,measure:'EA',check:'ok',amount:696.92,
  });
  assert.equal(round(lines[0].quantity*lines[0].unitCost),696.92);
  assert.ok(messages.some(m=>/Quantity Ordered, Value \/ UOM and Line Total/.test(m)));
  assert.doesNotMatch(lines[0].description,/23\.10\.2026|Ordered|Value|Acceptance|GST|Sub Total/);
});

test('order acknowledgement accepts joined or split quantity/rate tokens, reordered extraction and combined headings', async () => {
  const split=order.flatMap(i=>i.s==='174.23 $/EA'?[{...i,s:'174.23',w:24},{...i,x:i.x+25,s:'$ / EA',w:20}]:i);
  const joined=order.filter(i=>i.s!=='EA').map(i=>i.s==='4'?{...i,s:'4EA',w:21}:i);
  const combined=order.filter(i=>!['Ordered','Del. Date','(AUD)'].includes(i.s)).map(i=>({ ...i,
    s:i.s==='Quantity'?'Quantity Ordered':i.s==='Estimated'?'Estimated Del. Date':i.s==='Value'?'Value (AUD)':i.s==='Line Total'?'Line Total (AUD)':i.s,
  }));
  for(const items of [split,joined,combined,[...order].reverse()]){
    const lines=await harness(items).api.readDoc();
    assert.equal(lines.length,1);
    assert.equal(lines[0].quantity,4);
    assert.equal(lines[0].unitCost,174.23);
    assert.equal(lines[0].amount,696.92);
  }
});

test('order acknowledgement keeps multiple item blocks separate and uses the subtotal rather than the inclusive total', async () => {
  const second=order.filter(i=>i.y>310&&i.y<340).map(i=>({ ...i,y:i.y-60,
    s:i.s==='10'?'20':i.s==='4'?'2':i.s==='174.23 $/EA'?'99.99 $/EA':i.s==='696.92'?'199.98':
      i.s==='100129 3.00 1200 2400 MF 5005 H34'?'200245 1.60 1200 2400 MF 5005 H34':i.s==='MILL FINISH'?'WRAPPED FINISH':i.s,
  }));
  const items=order.map(i=>i.y<100?{...i,s:i.s==='696.92'?'896.90':i.s==='69.69'?'89.69':i.s==='766.61'?'986.59':i.s}:i).concat(second);
  const lines=await harness(items).api.readDoc();
  assert.equal(lines.length,2);
  assert.match(lines[0].description,/^100129 .* MILL FINISH$/);
  assert.match(lines[1].description,/^200245 .* WRAPPED FINISH$/);
  assert.deepEqual(Array.from(lines,l=>l.quantity),[4,2]);
  assert.equal(round(lines.reduce((s,l)=>s+l.quantity*l.unitCost,0)),896.9);
});

test('order acknowledgement fails before importing partial items when quantities, rates, units or financial totals are ambiguous', async () => {
  const change=(pred,update)=>order.flatMap(i=>pred(i)?update({...i}):[{...i}]);
  const cases=[
    ['missing item number',change(i=>i.s==='10',()=>[])],
    ['missing qty',change(i=>i.s==='4',()=>[])],
    ['duplicate qty',change(i=>i.s==='4',i=>[i,{...i,x:i.x+1}])],
    ['missing quantity unit',change(i=>i.s==='EA',()=>[])],
    ['missing price',change(i=>i.s==='174.23 $/EA',()=>[])],
    ['duplicate price',change(i=>i.s==='174.23 $/EA',i=>[i,{...i,x:i.x+1}])],
    ['missing price unit',change(i=>i.s==='174.23 $/EA',i=>[{...i,s:'174.23'}])],
    ['conflicting billing unit',change(i=>i.s==='174.23 $/EA',i=>[{...i,s:'174.23 $/M2'}])],
    ['missing line amount',change(i=>i.s==='696.92'&&i.y>100,()=>[])],
    ['duplicated amount',change(i=>i.s==='696.92'&&i.y>100,i=>[i,{...i,x:i.x+1}])],
    ['missing description',change(i=>i.s.startsWith('100129'),()=>[])],
    ['zero qty',change(i=>i.s==='4',i=>[{...i,s:'0'}])],
    ['wrong price',change(i=>i.s==='174.23 $/EA',i=>[{...i,s:'174.00 $/EA'}])],
    ['subtotal mismatch',change(i=>i.s==='696.92'&&i.y<100,i=>[{...i,s:'700.00'}])],
    ['subtotal missing',change(i=>i.s==='Sub Total (AUD)',()=>[])],
    ['GST missing',change(i=>i.s==='Total GST (AUD)',()=>[])],
    ['gross mismatch',change(i=>i.s==='766.61',i=>[{...i,s:'766.62'}])],
    ['Value heading missing',change(i=>i.s==='Value',()=>[])],
    ['Ordered heading missing',change(i=>i.s==='Ordered',()=>[])],
  ];
  for(const [label,items] of cases) await assert.rejects(harness(items).api.readDoc(),/order acknowledgement safely/,label);
});
