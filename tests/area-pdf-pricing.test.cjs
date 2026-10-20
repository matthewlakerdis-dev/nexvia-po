const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.NEXVIA_TEST_SCRIPT || path.join(__dirname,'../downloads/nexvia-quote-to-po-v1.54.user.js'),'utf8');

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

// Native PDF.js geometry from the supplied area-priced quotation. Only the
// item table and financial totals are retained; customer/bank details omitted.
const areaPerQuote = require('./fixtures/area-per-quotation-items.json');
const money = (value) => Math.round(value * 100) / 100;

test('area-priced quotation uses Per billing quantities, keeps wrapped descriptions and reconciles all 11 items', async () => {
  const { api, messages } = harness(areaPerQuote);
  const lines = await api.readDoc();
  assert.equal(lines.length, 11);
  assert.deepEqual(Array.from(lines, (l) => l.quantity), [32.38,124,1,84,126,504,6,2,1,1,1]);
  assert.deepEqual(Array.from(lines, (l) => l.measure), ['M2','M2','EA','EA','EA','EA','BOX','EA','EA','EA','EA']);
  assert.deepEqual(Array.from(lines, (l) => l.amount), [2623.10,17112,47.5,2757.99,701.99,2134.21,4629.22,372.67,337.64,213,307.16]);
  assert.equal(money(lines.reduce((sum,l) => sum+money(l.quantity*l.unitCost),0)),31236.48);
  for (const line of lines) assert.equal(money(line.quantity*line.unitCost),line.amount,line.description);
  assert.match(lines[0].description,/2530mm x 1280mmFinish: Untrimmed Panel/);
  assert.match(lines[0].description,/sheet quantity 10; billed 32.38 m²/);
  assert.match(lines[1].description,/sheet quantity 32; billed 124 m²/);
  assert.match(lines[2].description,/per Half Litre/);
  assert.match(lines[4].description,/#1549012/);
  assert.doesNotMatch(lines[5].description,/#1549012/);
  assert.match(lines[5].description,/#1549015/);
  assert.doesNotMatch(lines[6].description,/#1549015/);
  assert.match(lines[6].description,/QTY - 250 Per Box/);
  assert.match(lines[7].description,/VHM-6.0 x 40.5/);
  assert.doesNotMatch(lines.map((l)=>l.description).join(' '),/Ex GST|Price Amount|SUB TOTAL/);
  assert.equal(lines.filter(l=>l.check==='check').length,7);
  assert.equal(lines[5].sourceUnitPrice,4.23);
  assert.equal(lines[5].sourceQuantity,504);
  assert.match(lines[5].description,/quoted \$4.23\/EA; rate adjusted to printed amount/);
  assert.ok(messages.some(m=>/M²-priced items use their area/.test(m)));
  assert.ok(messages.some(m=>/Check GST: PDF lists \$3123.67; standard 10% GST gives \$3123.65/.test(m)));
});

test('area quotation stops on incomplete or ambiguous quantities, price basis, headings and subtotal', async () => {
  const change=(predicate, update)=>areaPerQuote.flatMap(i=>predicate(i)?update(i):[{...i}]);
  const first=(s)=>(i)=>i.s===s&&Math.abs(i.y-475.5)<1;
  const cases=[
    ['missing area',change(first('32.38'),()=>[])],
    ['duplicated area',change(first('32.38'),i=>[{...i},{...i,x:i.x+1}])],
    ['missing sheet count',change(first('10.0'),()=>[])],
    ['missing price',change(first('$81.00'),()=>[])],
    ['duplicated price',change(first('$81.00'),i=>[{...i},{...i,x:i.x+1}])],
    ['missing amount',change(first('$2,623.10'),()=>[])],
    ['wrong Per',change(first('M2'),i=>[{...i,s:'EA'}])],
    ['unknown Per',change(first('M2'),i=>[{...i,s:'PALLET'}])],
    ['zero area',change(first('32.38'),i=>[{...i,s:'0'}])],
    ['unreconciled price',change(first('$81.00'),i=>[{...i,s:'$8.10'}])],
    ['subtotal mismatch',change(i=>i.s==='$31,236.48',i=>[{...i,s:'$31,236.49'}])],
    ['missing subtotal',change(i=>/^SUB TOTAL/.test(i.s),()=>[])],
    ['inclusive total mismatch',change(i=>i.s==='$34,360.15',i=>[{...i,s:'$34,360.14'}])],
    ['missing Ex GST',change(i=>i.s==='Ex GST',()=>[])],
    ['missing Amount heading',change(i=>i.s==='Amount',()=>[])],
  ];
  for (const [label,items] of cases) {
    await assert.rejects(harness(items).api.readDoc(), /Quantity \/ M² \/ Per quotation safely/,label);
  }
});

test('area quotation accepts combined ex-GST headings and reordered extraction', async () => {
  const combined=areaPerQuote.filter(i=>i.s!=='Ex GST').map(i=>i.s==='Price'||i.s==='Amount'?{...i,s:'Ex GST '+i.s}:i).reverse();
  const lines=await harness(combined).api.readDoc();
  assert.equal(lines.length,11);
  assert.equal(money(lines.reduce((sum,l)=>sum+l.amount,0)),31236.48);

});
