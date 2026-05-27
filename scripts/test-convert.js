'use strict';
const { convert, parseMarkdownElements } = require('../server/services/fileConvert');

const md = [
  '# Q3 Sales Report',
  '',
  '## Summary',
  'Total revenue increased by 23% this quarter.',
  '',
  '## Sales by Region',
  '| Region | Q2     | Q3     | Growth |',
  '|--------|--------|--------|--------|',
  '| North  | 1.2M   | 1.45M  | +20.8% |',
  '| South  | 0.98M  | 1.23M  | +25.5% |',
  '| East   | 0.76M  | 0.95M  | +25.0% |',
  '',
  '- Strong North and South performance',
  '- East consistent growth',
  '',
  '## Action Items',
  '1. Expand North team',
  '2. Launch loyalty program',
  '3. Review pricing strategy',
].join('\n');

const els = parseMarkdownElements(md);
console.log('Parsed', els.length, 'elements:', els.map(e => e.type).join(', '));

async function run() {
  const docx = await convert(md, 'docx', 'test');
  console.log('docx:', docx.buffer.length, 'bytes  ✅');

  const xlsx = await convert(md, 'xlsx', 'test');
  console.log('xlsx:', xlsx.buffer.byteLength, 'bytes  ✅');

  const pptx = await convert(md, 'pptx', 'test');
  console.log('pptx:', pptx.buffer.byteLength, 'bytes  ✅');

  const pdf = await convert(md, 'pdf', 'test');
  console.log('pdf:', pdf.buffer.length, 'bytes  ✅');

  const csv = await convert(md, 'csv', 'test');
  console.log('csv:', csv.buffer.length, 'chars  ✅');
  console.log(csv.buffer.split('\n').slice(0, 4).join('\n'));

  const json = await convert(md, 'json', 'test');
  console.log('json:', json.buffer.length, 'chars  ✅');
  console.log(json.buffer.slice(0, 200));

  console.log('\n✅ ALL 6 FORMATS OK');
}

run().catch(err => { console.error('FAIL:', err); process.exit(1); });
