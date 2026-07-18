// Section 16, Category 18: verifies the hand-rolled .xlsx writer produces a genuinely valid ZIP
// container with correct XML content -- not just "doesn't throw." There's no xlsx-parsing
// library in this dependency-light project to check the output against, so this test includes a
// minimal ZIP *reader* (End of Central Directory -> Central Directory -> local entries, stored/
// uncompressed only, matching what the writer produces) written independently from the writer's
// own field layout, specifically so a bug in the writer's byte offsets doesn't have a matching
// bug in the verification reading it the same wrong way.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildXlsxWorkbook, buildZip, crc32 } = require('../server/xlsxWriter');

function readZip(buffer) {
  // Find the End of Central Directory record by scanning backward for its signature (0x06054b50)
  // -- correct in general only when there's no zip comment, true here since the writer never
  // sets one.
  const EOCD_SIGNATURE = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'End of Central Directory record not found');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  assert.equal(eocdOffset, centralDirOffset + centralDirSize, 'central directory size/offset must exactly precede the EOCD record');

  const entries = [];
  let pos = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50, `central directory entry ${i} signature mismatch`);
    const compressionMethod = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf-8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    // Follow the local header to read the actual entry data.
    assert.equal(buffer.readUInt32LE(localHeaderOffset), 0x04034b50, `local header for "${name}" signature mismatch`);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    assert.equal(compressionMethod, 0, `"${name}" must be stored (uncompressed), not DEFLATEd`);
    assert.equal(compressedSize, uncompressedSize, `"${name}" stored entries must have equal compressed/uncompressed size`);
    assert.equal(crc32(data), crc, `"${name}" CRC-32 mismatch -- data was corrupted or the writer computed the wrong CRC`);

    entries.push({ name, data: data.toString('utf-8') });
  }

  return entries;
}

test('buildZip: round-trips arbitrary entries through the independent reader', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello world', 'utf-8') },
    { name: 'dir/b.xml', data: Buffer.from('<root/>', 'utf-8') },
  ];
  const zipBuffer = buildZip(entries);
  const read = readZip(zipBuffer);

  assert.equal(read.length, 2);
  assert.equal(read[0].name, 'a.txt');
  assert.equal(read[0].data, 'hello world');
  assert.equal(read[1].name, 'dir/b.xml');
  assert.equal(read[1].data, '<root/>');
});

test('buildXlsxWorkbook: produces a valid ZIP with all five required OOXML parts', () => {
  const workbook = buildXlsxWorkbook(['ID', 'Amount'], [['t_1', 100], ['t_2', 250.5]]);
  const entries = readZip(workbook);
  const names = entries.map((e) => e.name);

  assert.ok(names.includes('[Content_Types].xml'));
  assert.ok(names.includes('_rels/.rels'));
  assert.ok(names.includes('xl/workbook.xml'));
  assert.ok(names.includes('xl/_rels/workbook.xml.rels'));
  assert.ok(names.includes('xl/worksheets/sheet1.xml'));
});

test('buildXlsxWorkbook: the sheet XML contains the header row and correctly typed data cells', () => {
  const workbook = buildXlsxWorkbook(['ID', 'Amount'], [['t_1', 100]]);
  const entries = readZip(workbook);
  const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data;

  assert.match(sheet, /<t>ID<\/t>/);
  assert.match(sheet, /<t>Amount<\/t>/);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t>t_1<\/t><\/is><\/c>/);
  // Amount (a number) must be a plain numeric cell, not inlineStr -- Excel would otherwise treat
  // it as text and every SUM/AVERAGE formula over the column would silently ignore it.
  assert.match(sheet, /<c r="B2"><v>100<\/v><\/c>/);
});

test('buildXlsxWorkbook: escapes XML special characters in text cells', () => {
  const workbook = buildXlsxWorkbook(['Note'], [['<script>alert(1)</script> & "quotes"']]);
  const entries = readZip(workbook);
  const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data;

  assert.ok(!sheet.includes('<script>'), 'raw unescaped markup must not appear in the XML');
  assert.match(sheet, /&lt;script&gt;/);
  assert.match(sheet, /&amp;/);
});

test('buildXlsxWorkbook: handles more than 26 columns (multi-letter column references)', () => {
  const headers = Array.from({ length: 30 }, (_, i) => `col${i}`);
  const workbook = buildXlsxWorkbook(headers, [headers.map((_, i) => i)]);
  const entries = readZip(workbook);
  const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data;

  // Column 27 (0-indexed 26) is "AA".
  assert.match(sheet, /<c r="AA1"/);
});
