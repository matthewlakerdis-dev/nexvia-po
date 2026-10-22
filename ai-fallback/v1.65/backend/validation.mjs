export const AI_PROTOCOL_VERSION = 1;
export function validateAiExtraction(data, sourceText) {
  const fail = message => { throw new Error('AI result rejected: ' + message); };
  const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e8 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-5;
  const equal = (a,b) => Math.abs(a-b) < 0.005;
  const text = s => typeof s === 'string' && s.trim() && s.length <= 4000;
  const normalize = s => s.replace(/\s+/g,' ').trim();
  if (!data || data.protocolVersion !== 1 || data.ready !== true || data.currency !== 'AUD') fail('the document is ambiguous, unsupported or not AUD');
  if (!text(sourceText) && !(typeof sourceText === 'string' && sourceText.length > 4000)) fail('source text is missing');
  const source = normalize(sourceText);
  const proof = s => text(s) && source.includes(normalize(s));
  if (!Array.isArray(data.issues) || data.issues.length) fail('the model reported an unresolved issue');
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 200) fail('invalid item count');
  if (![data.subtotal,data.gst,data.total].every(money) || !equal(round(data.subtotal+data.gst),data.total)) fail('document totals do not reconcile');
  if (!proof(data.totalEvidence) || Number(data.totalEvidence.replace(/[$,\s]/g,'')) !== data.total) fail('the total is not supported by printed source text');
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
export const EXTRACTION_SCHEMA = {
  type:'object',additionalProperties:false,
  properties:{protocolVersion:{type:'integer',enum:[1]},ready:{type:'boolean'},currency:{type:'string',enum:['AUD','OTHER','UNKNOWN']},
    reference:{type:'string'},issues:{type:'array',items:{type:'string'}},subtotal:{type:'number'},gst:{type:'number'},total:{type:'number'},totalEvidence:{type:'string'},taxEvidence:{type:'string'},
    items:{type:'array',items:{type:'object',additionalProperties:false,properties:{description:{type:'string'},quantity:{type:'number'},unitCost:{type:'number'},measure:{type:'string'},amount:{type:'number'},gstAmount:{type:'number'},taxRate:{type:'number',enum:[0,0.1]},evidence:{type:'string'}},
      required:['description','quantity','unitCost','measure','amount','gstAmount','taxRate','evidence']}}},
  required:['protocolVersion','ready','currency','reference','issues','subtotal','gst','total','totalEvidence','taxEvidence','items']
};
