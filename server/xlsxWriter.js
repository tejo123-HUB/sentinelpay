// Section 16, Category 18: a real, working Excel (.xlsx) writer using only Node's built-ins --
// no `exceljs`/`xlsx` dependency. An .xlsx file is a ZIP archive of XML parts (the Office Open
// XML SpreadsheetML format); this hand-constructs both the ZIP container (stored/uncompressed
// entries -- simpler and less error-prone than DEFLATE, and still a fully valid ZIP: the format
// has always allowed uncompressed entries) and the minimal XML parts a spreadsheet needs.

// ---- CRC-32 (required by the ZIP format for every entry, regardless of compression method) ----
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Minimal ZIP writer (stored/uncompressed entries) ----
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const DOS_DATE_1980_01_01 = 0x0021; // MS-DOS date field: a fixed, valid date; the actual value doesn't matter to any real consumer of this file

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 = stored
    localHeader.writeUInt16LE(0, 10); // last mod file time
    localHeader.writeUInt16LE(DOS_DATE_1980_01_01, 12); // last mod file date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size == uncompressed size (stored)
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIR_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // last mod file time
    centralHeader.writeUInt16LE(DOS_DATE_1980_01_01, 14); // last mod file date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirStart = offset;
  const centralDirBuffer = Buffer.concat(centralParts);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(ZIP_END_OF_CENTRAL_DIR_SIGNATURE, 0);
  endRecord.writeUInt16LE(0, 4); // number of this disk
  endRecord.writeUInt16LE(0, 6); // disk where central directory starts
  endRecord.writeUInt16LE(entries.length, 8); // central directory records on this disk
  endRecord.writeUInt16LE(entries.length, 10); // total central directory records
  endRecord.writeUInt32LE(centralDirBuffer.length, 12); // size of central directory
  endRecord.writeUInt32LE(centralDirStart, 16); // offset of start of central directory
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirBuffer, endRecord]);
}

// ---- Minimal SpreadsheetML (the XML dialect inside an .xlsx) ----
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function columnLetter(index) {
  // 1-based column index -> spreadsheet column letter (1 -> A, 26 -> Z, 27 -> AA, ...).
  let n = index;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildSheetXml(headers, rows) {
  const headerRow = `<row r="1">${headers
    .map((h, i) => `<c r="${columnLetter(i + 1)}1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`)
    .join('')}</row>`;

  const dataRows = rows
    .map((row, rowIndex) => {
      const r = rowIndex + 2; // row 1 is the header
      const cells = row
        .map((value, colIndex) => {
          const cellRef = `${columnLetter(colIndex + 1)}${r}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${cellRef}"><v>${value}</v></c>`;
          }
          return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${dataRows}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {Buffer} a valid .xlsx file
 */
function buildXlsxWorkbook(headers, rows) {
  const sheetXml = buildSheetXml(headers, rows);

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf-8') },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK_XML, 'utf-8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS_XML, 'utf-8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf-8') },
  ];

  return buildZip(entries);
}

module.exports = { buildXlsxWorkbook, buildZip, crc32, columnLetter };
