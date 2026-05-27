'use strict';
/**
 * fileConvert.js — Convert AI-generated Markdown to office file formats
 *
 * Supported: docx (Word), xlsx (Excel), pptx (PowerPoint), pdf, csv, json
 *
 * Flow:
 *   1. parseMarkdownElements(text) — turns Markdown into a structured element array
 *   2. Format-specific builder  (toDocx / toXlsx / toPptx / toPdf / toCsv / toJson)
 *   3. convert(content, format, filename) — public entry point → { buffer, mimeType, ext }
 */

// ── Inline-format stripper ───────────────────────────────────────────────────
function stripInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')       // italic
    .replace(/`(.+?)`/g, '$1')         // inline code
    .replace(/~~(.+?)~~/g, '$1')       // strikethrough
    .replace(/\[(.+?)\]\(.+?\)/g, '$1'); // links
}

// ── Markdown element parser ──────────────────────────────────────────────────
/**
 * Turns a Markdown string into a flat list of typed elements:
 *   { type: 'h1'|'h2'|'h3', text }
 *   { type: 'paragraph', text }
 *   { type: 'bullets', items: string[] }
 *   { type: 'numbered', items: string[] }
 *   { type: 'table', rows: string[][] }   ← first row = header
 *   { type: 'code', lang, text }
 */
function parseMarkdownElements(text) {
  // Remove any "coming soon" or disclaimer lines the old system instruction added
  const cleaned = text
    .replace(/📄\s*\*?File download.*?\*?\n?/gi, '')
    .replace(/\*File download.*?\*\n?/gi, '')
    .trim();

  const lines = cleaned.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { i++; continue; }

    // ── Fenced code block ─────────────────────────────────────────
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      elements.push({ type: 'code', lang, text: code.join('\n') });
      i++; // skip closing ```
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────
    if (line.startsWith('### ')) { elements.push({ type: 'h3', text: stripInline(line.slice(4)) }); i++; continue; }
    if (line.startsWith('## '))  { elements.push({ type: 'h2', text: stripInline(line.slice(3)) }); i++; continue; }
    if (line.startsWith('# '))   { elements.push({ type: 'h1', text: stripInline(line.slice(2)) }); i++; continue; }

    // ── Table (lines containing |) ────────────────────────────────
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim()
          .split('|')
          .slice(1, -1)                 // remove empty outer segments from "| a | b |"
          .map(c => stripInline(c.trim()));
        // Skip separator rows (| --- | --- |)
        if (!cells.every(c => /^[-:= ]+$/.test(c))) {
          rows.push(cells);
        }
        i++;
      }
      if (rows.length) elements.push({ type: 'table', rows });
      continue;
    }

    // ── Bullet list ───────────────────────────────────────────────
    if (/^[-*•] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*•] /.test(lines[i].trim())) {
        items.push(stripInline(lines[i].trim().replace(/^[-*•] /, '')));
        i++;
      }
      elements.push({ type: 'bullets', items });
      continue;
    }

    // ── Numbered list ─────────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
        items.push(stripInline(lines[i].trim().replace(/^\d+\. /, '')));
        i++;
      }
      elements.push({ type: 'numbered', items });
      continue;
    }

    // ── Plain paragraph ───────────────────────────────────────────
    elements.push({ type: 'paragraph', text: stripInline(line) });
    i++;
  }

  return elements;
}

// ── Word (.docx) ─────────────────────────────────────────────────────────────
async function toDocx(elements) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType,
  } = require('docx');

  const HEADING_MAP = {
    h1: HeadingLevel.HEADING_1,
    h2: HeadingLevel.HEADING_2,
    h3: HeadingLevel.HEADING_3,
  };

  const children = [];
  for (const el of elements) {
    if (el.type === 'h1' || el.type === 'h2' || el.type === 'h3') {
      children.push(new Paragraph({ text: el.text, heading: HEADING_MAP[el.type] }));

    } else if (el.type === 'paragraph') {
      children.push(new Paragraph({ children: [new TextRun(el.text)] }));

    } else if (el.type === 'bullets') {
      for (const item of el.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
      }

    } else if (el.type === 'numbered') {
      el.items.forEach((item, idx) => {
        children.push(new Paragraph({
          children: [new TextRun(`${idx + 1}. ${item}`)],
        }));
      });

    } else if (el.type === 'code') {
      children.push(new Paragraph({
        children: [new TextRun({ text: el.text, font: 'Courier New', size: 18 })],
      }));

    } else if (el.type === 'table') {
      const tableRows = el.rows.map((row, rowIdx) =>
        new TableRow({
          children: row.map(cell =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: cell, bold: rowIdx === 0 }),
                  ],
                }),
              ],
            })
          ),
        })
      );
      children.push(
        new Table({
          rows: tableRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      );
      children.push(new Paragraph('')); // spacer after table
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Excel (.xlsx) ─────────────────────────────────────────────────────────────
async function toXlsx(elements) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();

  // Find all tables; if none, put everything as plain text
  const tables = elements.filter(e => e.type === 'table');

  if (tables.length > 0) {
    // One worksheet per table (or Sheet1 / Sheet2 ...)
    tables.forEach((tbl, tblIdx) => {
      // Find the heading right before this table
      const tblPos = elements.indexOf(tbl);
      let sheetName = `Sheet${tblIdx + 1}`;
      for (let k = tblPos - 1; k >= 0; k--) {
        if (['h1', 'h2', 'h3'].includes(elements[k].type)) {
          sheetName = elements[k].text.slice(0, 31); // Excel sheet name max 31 chars
          break;
        }
      }

      const ws = wb.addWorksheet(sheetName);

      tbl.rows.forEach((row, rowIdx) => {
        const wsRow = ws.addRow(row);
        if (rowIdx === 0) {
          // Style header row
          wsRow.eachCell(cell => {
            cell.font = { bold: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
          });
        }
      });

      // Auto-width columns
      ws.columns.forEach(col => {
        let maxLen = 10;
        col.eachCell({ includeEmpty: true }, cell => {
          const val = cell.value ? String(cell.value) : '';
          if (val.length > maxLen) maxLen = val.length;
        });
        col.width = Math.min(maxLen + 2, 60);
      });
    });

    // If there are non-table elements, add a Notes sheet
    const nonTable = elements.filter(e => e.type !== 'table');
    if (nonTable.length > 0) {
      const ws = wb.addWorksheet('Notes');
      nonTable.forEach(el => {
        if (el.type === 'paragraph' || el.type === 'h1' || el.type === 'h2' || el.type === 'h3') {
          ws.addRow([el.text]);
        } else if (el.type === 'bullets' || el.type === 'numbered') {
          el.items.forEach((item, i) => ws.addRow([`${el.type === 'numbered' ? `${i + 1}.` : '•'} ${item}`]));
        }
      });
    }
  } else {
    // No tables — dump all text into a single "Content" sheet
    const ws = wb.addWorksheet('Content');
    elements.forEach(el => {
      if (el.type === 'paragraph' || el.type === 'h1' || el.type === 'h2' || el.type === 'h3') {
        ws.addRow([el.text]);
      } else if (el.type === 'bullets' || el.type === 'numbered') {
        el.items.forEach((item, i) => ws.addRow([`${el.type === 'numbered' ? `${i + 1}.` : '•'} ${item}`]));
      } else if (el.type === 'code') {
        ws.addRow([el.text]);
      }
    });
  }

  return wb.xlsx.writeBuffer();
}

// ── PowerPoint (.pptx) ───────────────────────────────────────────────────────
async function toPptx(elements) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  // Group elements into slides: each H1/H2 starts a new slide
  const slides = [];
  let current = null;

  for (const el of elements) {
    if (el.type === 'h1' || el.type === 'h2') {
      if (current) slides.push(current);
      current = { title: el.text, subtitle: '', content: [] };
    } else if (el.type === 'h3') {
      if (!current) current = { title: el.text, subtitle: '', content: [] };
      else current.content.push({ type: 'heading', text: el.text });
    } else if (el.type === 'paragraph') {
      if (!current) current = { title: '', subtitle: '', content: [] };
      current.content.push({ type: 'text', text: el.text });
    } else if (el.type === 'bullets') {
      if (!current) current = { title: '', subtitle: '', content: [] };
      current.content.push({ type: 'bullets', items: el.items });
    } else if (el.type === 'numbered') {
      if (!current) current = { title: '', subtitle: '', content: [] };
      current.content.push({ type: 'numbered', items: el.items });
    } else if (el.type === 'table') {
      if (!current) current = { title: '', subtitle: '', content: [] };
      current.content.push({ type: 'table', rows: el.rows });
    }
  }
  if (current) slides.push(current);

  // If no structured slides found, make a single slide with all content
  if (slides.length === 0 && elements.length > 0) {
    slides.push({
      title: '',
      content: elements.map(e => {
        if (e.type === 'paragraph' || e.type === 'h1' || e.type === 'h2' || e.type === 'h3') return { type: 'text', text: e.text };
        if (e.type === 'bullets') return { type: 'bullets', items: e.items };
        if (e.type === 'numbered') return { type: 'numbered', items: e.items };
        return null;
      }).filter(Boolean),
    });
  }

  slides.forEach(slide => {
    const s = pptx.addSlide();

    // Title
    if (slide.title) {
      s.addText(slide.title, {
        x: 0.5, y: 0.3, w: 12, h: 1.2,
        fontSize: 28, bold: true, color: '363062',
      });
    }

    // Content area — build line by line
    let y = slide.title ? 1.7 : 0.5;
    const contentLines = [];

    for (const item of slide.content) {
      if (item.type === 'text' || item.type === 'heading') {
        contentLines.push({
          text: item.text,
          options: { fontSize: item.type === 'heading' ? 16 : 14, bold: item.type === 'heading' },
        });
      } else if (item.type === 'bullets') {
        item.items.forEach(b => contentLines.push({ text: `• ${b}`, options: { fontSize: 14 } }));
      } else if (item.type === 'numbered') {
        item.items.forEach((b, i) => contentLines.push({ text: `${i + 1}. ${b}`, options: { fontSize: 14 } }));
      } else if (item.type === 'table') {
        // Render table as formatted text on the slide
        item.rows.forEach((row, ri) => {
          contentLines.push({
            text: row.join('  |  '),
            options: { fontSize: 12, bold: ri === 0, fontFace: 'Courier New' },
          });
        });
      }
    }

    if (contentLines.length > 0) {
      s.addText(contentLines, {
        x: 0.5, y, w: 12, h: 7.5 - y,
        fontSize: 14,
        valign: 'top',
        wrap: true,
      });
    }
  });

  return pptx.write({ outputType: 'nodebuffer' });
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function toPdf(elements) {
  const PDFDocument = require('pdfkit');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 120; // usable width

    for (const el of elements) {
      if (el.type === 'h1') {
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(22).text(el.text, { width: W });
        doc.moveDown(0.3);
      } else if (el.type === 'h2') {
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(17).text(el.text, { width: W });
        doc.moveDown(0.2);
      } else if (el.type === 'h3') {
        doc.moveDown(0.3).font('Helvetica-Bold').fontSize(13).text(el.text, { width: W });
        doc.moveDown(0.1);
      } else if (el.type === 'paragraph') {
        doc.font('Helvetica').fontSize(11).text(el.text, { width: W });
        doc.moveDown(0.3);
      } else if (el.type === 'bullets') {
        el.items.forEach(item => {
          doc.font('Helvetica').fontSize(11).text(`• ${item}`, { width: W - 10, indent: 10 });
        });
        doc.moveDown(0.3);
      } else if (el.type === 'numbered') {
        el.items.forEach((item, i) => {
          doc.font('Helvetica').fontSize(11).text(`${i + 1}. ${item}`, { width: W - 10, indent: 10 });
        });
        doc.moveDown(0.3);
      } else if (el.type === 'code') {
        doc.font('Courier').fontSize(9)
          .rect(doc.x, doc.y, W, 1).fillAndStroke('#f4f4f4', '#e0e0e0')
          .fillColor('#333333').text(el.text, { width: W - 10, indent: 5 });
        doc.moveDown(0.3);
      } else if (el.type === 'table') {
        const colCount = el.rows[0] ? el.rows[0].length : 1;
        const colW = Math.floor(W / colCount);

        el.rows.forEach((row, ri) => {
          const rowY = doc.y;
          const isHeader = ri === 0;
          if (isHeader) {
            doc.rect(60, rowY, W, 16).fill('#E0E7FF').fillColor('#000000');
          }
          row.forEach((cell, ci) => {
            doc
              .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
              .fontSize(9)
              .text(cell, 60 + ci * colW, rowY + 3, { width: colW - 4, ellipsis: true, lineBreak: false });
          });
          doc.y = rowY + 18;
        });
        doc.moveDown(0.5);
      }
    }

    doc.end();
  });
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function toCsv(elements) {
  const tables = elements.filter(e => e.type === 'table');
  if (tables.length === 0) {
    // No tables — export all text as a two-column key/value CSV
    const rows = [['Type', 'Content']];
    for (const el of elements) {
      if (el.type === 'paragraph' || el.type === 'h1' || el.type === 'h2' || el.type === 'h3') {
        rows.push([el.type.toUpperCase(), el.text]);
      } else if (el.type === 'bullets' || el.type === 'numbered') {
        el.items.forEach(item => rows.push(['ITEM', item]));
      }
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  }

  // Export all tables combined (with blank row separator)
  const allRows = [];
  tables.forEach((tbl, idx) => {
    if (idx > 0) allRows.push([]);
    tbl.rows.forEach(row => allRows.push(row));
  });
  return allRows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(val) {
  if (val === undefined || val === null) return '';
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── JSON ──────────────────────────────────────────────────────────────────────
function toJson(elements) {
  const tables = elements.filter(e => e.type === 'table');

  if (tables.length > 0) {
    // Convert each table to an array of objects keyed by header row
    const result = tables.map(tbl => {
      const [headers, ...dataRows] = tbl.rows;
      if (!headers) return [];
      return dataRows.map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
        return obj;
      });
    });
    return JSON.stringify(tables.length === 1 ? result[0] : result, null, 2);
  }

  // No tables — build a structured document object
  const doc = { sections: [] };
  let current = null;

  for (const el of elements) {
    if (el.type === 'h1' || el.type === 'h2') {
      if (current) doc.sections.push(current);
      current = { heading: el.text, content: [] };
    } else if (current) {
      if (el.type === 'paragraph') current.content.push(el.text);
      else if (el.type === 'bullets') current.content.push({ bullets: el.items });
      else if (el.type === 'numbered') current.content.push({ numbered: el.items });
    } else {
      if (el.type === 'paragraph') doc.sections.push({ text: el.text });
    }
  }
  if (current) doc.sections.push(current);

  return JSON.stringify(doc, null, 2);
}

// ── Public entry point ────────────────────────────────────────────────────────
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:  'application/pdf',
  csv:  'text/csv',
  json: 'application/json',
};

/**
 * @param {string} content   - Raw AI Markdown content
 * @param {string} format    - 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv' | 'json'
 * @param {string} filename  - Desired filename without extension
 * @returns {Promise<{ buffer: Buffer|string, mimeType: string, ext: string }>}
 */
async function convert(content, format, filename = 'document') {
  const elements = parseMarkdownElements(content);
  const mimeType = MIME[format] || MIME.docx;
  const ext = format;

  let buffer;
  switch (format) {
    case 'docx': buffer = await toDocx(elements); break;
    case 'xlsx': buffer = await toXlsx(elements); break;
    case 'pptx': buffer = await toPptx(elements); break;
    case 'pdf':  buffer = await toPdf(elements);  break;
    case 'csv':  buffer = toCsv(elements);  break;
    case 'json': buffer = toJson(elements); break;
    default: throw new Error(`Unsupported format: ${format}`);
  }

  return { buffer, mimeType, ext };
}

module.exports = { convert, parseMarkdownElements };
