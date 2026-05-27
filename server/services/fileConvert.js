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

// ── Professional colour palettes (one picked randomly per document) ──────────
// Each palette: headingHex, accentHex, bodyHex (all WITHOUT leading #)
// argb = FF + hex (for ExcelJS / docx shading)
const PALETTES = [
  { name: 'NavyGold',     heading: '1B3A6B', accent: 'B07D2A', body: '1A1A2E', headerBg: 'D6E4F0' },
  { name: 'CharcoalTeal', heading: '2D3748', accent: '0D7377', body: '1A1A1A', headerBg: 'C6F6F5' },
  { name: 'ForestAmber',  heading: '1B4332', accent: 'B45309', body: '1A1A1A', headerBg: 'D1FAE5' },
  { name: 'SlateSapphire',heading: '1E3A5F', accent: '2563EB', body: '1E293B', headerBg: 'DBEAFE' },
  { name: 'BurgundySlate',heading: '7B1D1D', accent: '374151', body: '1F2937', headerBg: 'FEE2E2' },
  { name: 'IndigoGold',   heading: '312E81', accent: 'B45309', body: '1E1B4B', headerBg: 'EDE9FE' },
  { name: 'EmeraldNavy',  heading: '065F46', accent: '1E3A8A', body: '064E3B', headerBg: 'D1FAE5' },
];

function pickPalette() {
  return PALETTES[Math.floor(Math.random() * PALETTES.length)];
}

// Convert 6-char hex → { r, g, b } for pdfkit
function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

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
    Table, TableRow, TableCell, WidthType, BorderStyle,
    AlignmentType, ShadingType,
  } = require('docx');

  const pal = pickPalette();

  // Helper: Calibri TextRun at 9pt (size = half-points, so 9pt = 18)
  const body = (text, opts = {}) => new TextRun({
    text,
    font: 'Calibri',
    size: 18,                    // 9 pt
    color: opts.color || pal.body,
    bold:  opts.bold  || false,
    italics: opts.italics || false,
  });

  // Heading sizes: H1=24pt, H2=18pt, H3=14pt (half-points)
  const HEADING_SIZES = { h1: 48, h2: 36, h3: 28 };

  const children = [];

  for (const el of elements) {
    if (el.type === 'h1' || el.type === 'h2' || el.type === 'h3') {
      children.push(new Paragraph({
        children: [new TextRun({
          text: el.text,
          font: 'Calibri',
          size: HEADING_SIZES[el.type],
          bold: true,
          color: el.type === 'h1' ? pal.heading : el.type === 'h2' ? pal.accent : pal.heading,
        })],
        spacing: { before: el.type === 'h1' ? 240 : 180, after: 80 },
      }));

    } else if (el.type === 'paragraph') {
      children.push(new Paragraph({
        children: [body(el.text)],
        spacing: { after: 80 },
      }));

    } else if (el.type === 'bullets') {
      for (const item of el.items) {
        children.push(new Paragraph({
          children: [body(item)],
          bullet: { level: 0 },
          spacing: { after: 40 },
        }));
      }

    } else if (el.type === 'numbered') {
      el.items.forEach((item, idx) => {
        children.push(new Paragraph({
          children: [
            body(`${idx + 1}.  `, { bold: true }),
            body(item),
          ],
          spacing: { after: 40 },
        }));
      });

    } else if (el.type === 'code') {
      children.push(new Paragraph({
        children: [new TextRun({ text: el.text, font: 'Courier New', size: 16, color: '333333' })],
        shading: { type: ShadingType.SOLID, color: 'F4F4F4' },
        spacing: { after: 80 },
      }));

    } else if (el.type === 'table') {
      const tableRows = el.rows.map((row, rowIdx) =>
        new TableRow({
          tableHeader: rowIdx === 0,
          children: row.map(cell =>
            new TableCell({
              shading: rowIdx === 0
                ? { type: ShadingType.SOLID, color: pal.headerBg }
                : undefined,
              children: [new Paragraph({
                children: [body(cell, { bold: rowIdx === 0, color: rowIdx === 0 ? pal.heading : pal.body })],
                spacing: { before: 40, after: 40 },
              })],
              margins: { top: 60, bottom: 60, left: 80, right: 80 },
            })
          ),
        })
      );
      children.push(new Table({
        rows: tableRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      }));
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 18 },
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Excel (.xlsx) ─────────────────────────────────────────────────────────────
async function toXlsx(elements) {
  const ExcelJS = require('exceljs');
  const wb  = new ExcelJS.Workbook();
  const pal = pickPalette();

  // Helper: apply professional header styling to a row
  function styleHeaderRow(row) {
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FF' + pal.heading } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + pal.headerBg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF' + pal.accent } },
      };
    });
    row.height = 18;
  }

  function styleDataRow(row, isAlt) {
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 9, color: { argb: 'FF' + pal.body } };
      if (isAlt) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      }
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    row.height = 16;
  }

  function styleHeadingCell(ws, text, level) {
    const row = ws.addRow([text]);
    const cell = row.getCell(1);
    const sizes = { h1: 14, h2: 11, h3: 10 };
    cell.font = {
      name: 'Calibri',
      size: sizes[level] || 10,
      bold: true,
      color: { argb: 'FF' + (level === 'h1' ? pal.heading : pal.accent) },
    };
    row.height = sizes[level] ? sizes[level] + 4 : 14;
  }

  function autoWidth(ws) {
    ws.columns.forEach(col => {
      let maxLen = 8;
      col.eachCell({ includeEmpty: false }, cell => {
        const val = cell.value ? String(cell.value) : '';
        if (val.length > maxLen) maxLen = val.length;
      });
      col.width = Math.min(maxLen + 3, 55);
    });
  }

  const tables = elements.filter(e => e.type === 'table');

  if (tables.length > 0) {
    tables.forEach((tbl, tblIdx) => {
      const tblPos = elements.indexOf(tbl);
      let sheetName = `Sheet${tblIdx + 1}`;
      for (let k = tblPos - 1; k >= 0; k--) {
        if (['h1', 'h2', 'h3'].includes(elements[k].type)) {
          sheetName = elements[k].text.slice(0, 31);
          break;
        }
      }

      const ws = wb.addWorksheet(sheetName);
      ws.properties.defaultRowHeight = 16;

      tbl.rows.forEach((row, rowIdx) => {
        const wsRow = ws.addRow(row);
        if (rowIdx === 0) {
          styleHeaderRow(wsRow);
        } else {
          styleDataRow(wsRow, rowIdx % 2 === 0);
        }
      });

      autoWidth(ws);
      // Freeze header row
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    });

    // Notes sheet for non-table content
    const nonTable = elements.filter(e => e.type !== 'table');
    if (nonTable.length > 0) {
      const ws = wb.addWorksheet('Notes');
      ws.properties.defaultRowHeight = 16;
      nonTable.forEach(el => {
        if (['h1', 'h2', 'h3'].includes(el.type)) {
          styleHeadingCell(ws, el.text, el.type);
        } else if (el.type === 'paragraph') {
          const r = ws.addRow([el.text]);
          r.getCell(1).font = { name: 'Calibri', size: 9 };
        } else if (el.type === 'bullets') {
          el.items.forEach(item => {
            const r = ws.addRow([`• ${item}`]);
            r.getCell(1).font = { name: 'Calibri', size: 9 };
          });
        } else if (el.type === 'numbered') {
          el.items.forEach((item, i) => {
            const r = ws.addRow([`${i + 1}. ${item}`]);
            r.getCell(1).font = { name: 'Calibri', size: 9 };
          });
        }
      });
      ws.getColumn(1).width = 80;
    }
  } else {
    // No tables — structured content sheet
    const ws = wb.addWorksheet('Content');
    ws.properties.defaultRowHeight = 16;
    elements.forEach(el => {
      if (['h1', 'h2', 'h3'].includes(el.type)) {
        styleHeadingCell(ws, el.text, el.type);
      } else if (el.type === 'paragraph') {
        const r = ws.addRow([el.text]);
        r.getCell(1).font = { name: 'Calibri', size: 9 };
      } else if (el.type === 'bullets') {
        el.items.forEach(item => {
          const r = ws.addRow([`• ${item}`]);
          r.getCell(1).font = { name: 'Calibri', size: 9, color: { argb: 'FF' + pal.body } };
        });
      } else if (el.type === 'numbered') {
        el.items.forEach((item, i) => {
          const r = ws.addRow([`${i + 1}. ${item}`]);
          r.getCell(1).font = { name: 'Calibri', size: 9 };
        });
      } else if (el.type === 'code') {
        const r = ws.addRow([el.text]);
        r.getCell(1).font = { name: 'Courier New', size: 9, color: { argb: 'FF333333' } };
      }
    });
    ws.getColumn(1).width = 80;
  }

  return wb.xlsx.writeBuffer();
}

// ── PowerPoint (.pptx) ───────────────────────────────────────────────────────
async function toPptx(elements) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  const pal  = pickPalette();
  pptx.layout = 'LAYOUT_WIDE';  // 13.33 × 7.5 inches

  // Slide background: near-white with a subtle left accent bar added per slide
  pptx.defineSlideMaster({
    title: 'PROF_MASTER',
    background: { color: 'FAFAFA' },
  });

  // Group elements into slides: each H1/H2 starts a new slide
  const slides = [];
  let current = null;

  for (const el of elements) {
    if (el.type === 'h1' || el.type === 'h2') {
      if (current) slides.push(current);
      current = { title: el.text, isTitle: el.type === 'h1', content: [] };
    } else if (el.type === 'h3') {
      if (!current) current = { title: el.text, isTitle: false, content: [] };
      else current.content.push({ type: 'heading', text: el.text });
    } else if (el.type === 'paragraph') {
      if (!current) current = { title: '', isTitle: false, content: [] };
      current.content.push({ type: 'text', text: el.text });
    } else if (el.type === 'bullets') {
      if (!current) current = { title: '', isTitle: false, content: [] };
      current.content.push({ type: 'bullets', items: el.items });
    } else if (el.type === 'numbered') {
      if (!current) current = { title: '', isTitle: false, content: [] };
      current.content.push({ type: 'numbered', items: el.items });
    } else if (el.type === 'table') {
      if (!current) current = { title: '', isTitle: false, content: [] };
      current.content.push({ type: 'table', rows: el.rows });
    }
  }
  if (current) slides.push(current);

  if (slides.length === 0 && elements.length > 0) {
    slides.push({
      title: '',
      isTitle: false,
      content: elements.map(e => {
        if (['paragraph','h1','h2','h3'].includes(e.type)) return { type: 'text', text: e.text };
        if (e.type === 'bullets')  return { type: 'bullets',  items: e.items };
        if (e.type === 'numbered') return { type: 'numbered', items: e.items };
        if (e.type === 'table')    return { type: 'table',    rows: e.rows };
        return null;
      }).filter(Boolean),
    });
  }

  slides.forEach((slide, slideIdx) => {
    const s = pptx.addSlide();

    // Accent bar on left edge
    s.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 0.08, h: 7.5,
      fill: { color: pal.heading },
      line: { color: pal.heading },
    });

    // Slide number (bottom right)
    s.addText(`${slideIdx + 1}`, {
      x: 12.5, y: 7.1, w: 0.7, h: 0.3,
      fontSize: 7, color: 'AAAAAA', align: 'right',
    });

    // Title bar
    if (slide.title) {
      // Title background strip
      s.addShape(pptx.ShapeType.rect, {
        x: 0.2, y: 0.12, w: 13, h: slide.isTitle ? 1.3 : 0.9,
        fill: { color: slide.isTitle ? pal.heading : pal.headerBg },
        line: { color: slide.isTitle ? pal.heading : pal.headerBg },
        rectRadius: 0.05,
      });
      s.addText(slide.title, {
        x: 0.3, y: slide.isTitle ? 0.18 : 0.15,
        w: 12.5, h: slide.isTitle ? 1.1 : 0.75,
        fontSize: slide.isTitle ? 26 : 20,
        bold: true,
        color: slide.isTitle ? 'FFFFFF' : pal.heading,
        fontFace: 'Calibri',
        valign: 'middle',
      });
    }

    const contentY = slide.title ? (slide.isTitle ? 1.6 : 1.2) : 0.3;
    const contentH = 7.5 - contentY - 0.4;

    // Separate table items from text items so tables render with addTable
    const textItems = [];
    const tableItems = [];

    for (const item of slide.content) {
      if (item.type === 'table') {
        // Flush accumulated text lines first
        if (textItems.length > 0) {
          s.addText([...textItems], {
            x: 0.25, y: contentY, w: 12.8, h: contentH,
            fontFace: 'Calibri', fontSize: 10,
            valign: 'top', wrap: true,
          });
          textItems.length = 0;
        }
        tableItems.push(item);
      } else if (item.type === 'heading') {
        textItems.push({ text: item.text + '\n', options: { fontSize: 13, bold: true, color: pal.accent, fontFace: 'Calibri' } });
      } else if (item.type === 'text') {
        textItems.push({ text: item.text + '\n', options: { fontSize: 10, color: '333333', fontFace: 'Calibri' } });
      } else if (item.type === 'bullets') {
        item.items.forEach(b => textItems.push({
          text: b + '\n',
          options: { fontSize: 10, color: '333333', fontFace: 'Calibri', bullet: { type: 'bullet', characterCode: '25CF', color: pal.accent } },
        }));
      } else if (item.type === 'numbered') {
        item.items.forEach((b, i) => textItems.push({
          text: `${i + 1}. ${b}\n`,
          options: { fontSize: 10, color: '333333', fontFace: 'Calibri' },
        }));
      }
    }

    // Flush remaining text lines
    if (textItems.length > 0) {
      s.addText(textItems, {
        x: 0.25, y: contentY, w: 12.8, h: contentH,
        fontFace: 'Calibri', fontSize: 10,
        valign: 'top', wrap: true,
      });
    }

    // Render tables using pptxgenjs addTable
    let tableY = contentY;
    tableItems.forEach(item => {
      const rows = item.rows.map((row, ri) =>
        row.map(cell => ({
          text: cell,
          options: {
            fontFace: 'Calibri',
            fontSize: 9,
            bold: ri === 0,
            color: ri === 0 ? pal.heading : '333333',
            fill: ri === 0 ? pal.headerBg : (ri % 2 === 0 ? 'F8F8F8' : 'FFFFFF'),
            align: 'left',
            valign: 'middle',
            margin: [3, 6, 3, 6],
            border: [
              { type: 'solid', pt: 0.5, color: 'DDDDDD' },
              { type: 'solid', pt: 0.5, color: 'DDDDDD' },
              { type: 'solid', pt: 0.5, color: 'DDDDDD' },
              { type: 'solid', pt: 0.5, color: 'DDDDDD' },
            ],
          },
        }))
      );
      s.addTable(rows, {
        x: 0.25, y: tableY, w: 12.8,
        colW: Array(item.rows[0] ? item.rows[0].length : 1).fill(12.8 / (item.rows[0] ? item.rows[0].length : 1)),
      });
      tableY += item.rows.length * 0.32 + 0.2;
    });
  });

  return pptx.write({ outputType: 'nodebuffer' });
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function toPdf(elements) {
  const PDFDocument = require('pdfkit');
  const pal = pickPalette();
  const hRgb = hexToRgb(pal.heading);
  const aRgb = hexToRgb(pal.accent);
  const bRgb = hexToRgb(pal.body);
  const bgRgb = hexToRgb(pal.headerBg);

  return new Promise((resolve, reject) => {
    const MARGIN = 56;
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const W     = pageW - MARGIN * 2;   // usable text width

    // Draw a thin left accent rule on each page
    const drawAccentBar = () => {
      doc.save()
        .rect(MARGIN - 14, MARGIN - 10, 3, doc.page.height - MARGIN * 2 + 20)
        .fill(`#${pal.heading}`)
        .restore();
    };
    drawAccentBar();
    doc.on('pageAdded', drawAccentBar);

    for (const el of elements) {
      // Page break guard — if less than 60pt remaining, add new page
      if (doc.y > doc.page.height - MARGIN - 60) doc.addPage();

      if (el.type === 'h1') {
        doc.moveDown(0.6)
          .font('Helvetica-Bold').fontSize(18)
          .fillColor(`#${pal.heading}`)
          .text(el.text, { width: W });
        // Underline rule
        const lineY = doc.y + 2;
        doc.save()
          .moveTo(MARGIN, lineY).lineTo(MARGIN + W, lineY)
          .strokeColor(`#${pal.accent}`).lineWidth(1).stroke()
          .restore();
        doc.moveDown(0.4);

      } else if (el.type === 'h2') {
        doc.moveDown(0.5)
          .font('Helvetica-Bold').fontSize(13)
          .fillColor(`#${pal.accent}`)
          .text(el.text, { width: W });
        doc.moveDown(0.25);

      } else if (el.type === 'h3') {
        doc.moveDown(0.3)
          .font('Helvetica-Bold').fontSize(11)
          .fillColor(`#${pal.heading}`)
          .text(el.text, { width: W });
        doc.moveDown(0.15);

      } else if (el.type === 'paragraph') {
        doc.font('Helvetica').fontSize(9)
          .fillColor(`#${pal.body}`)
          .text(el.text, { width: W, lineGap: 2 });
        doc.moveDown(0.3);

      } else if (el.type === 'bullets') {
        el.items.forEach(item => {
          const bx = MARGIN + 8;
          const tx = MARGIN + 18;
          const ty = doc.y;
          // Bullet dot
          doc.save()
            .circle(bx, ty + 3.5, 2)
            .fill(`#${pal.accent}`)
            .restore();
          doc.font('Helvetica').fontSize(9)
            .fillColor(`#${pal.body}`)
            .text(item, tx, ty, { width: W - 18, lineGap: 2 });
        });
        doc.moveDown(0.3);

      } else if (el.type === 'numbered') {
        el.items.forEach((item, i) => {
          const tx = MARGIN + 18;
          const ty = doc.y;
          doc.font('Helvetica-Bold').fontSize(9)
            .fillColor(`#${pal.accent}`)
            .text(`${i + 1}.`, MARGIN + 2, ty, { width: 14, lineBreak: false });
          doc.font('Helvetica').fontSize(9)
            .fillColor(`#${pal.body}`)
            .text(item, tx, ty, { width: W - 18, lineGap: 2 });
        });
        doc.moveDown(0.3);

      } else if (el.type === 'code') {
        const codeY = doc.y;
        doc.save()
          .rect(MARGIN, codeY, W, 14)
          .fill('#F4F4F4')
          .restore();
        doc.font('Courier').fontSize(8).fillColor('#333333')
          .text(el.text, MARGIN + 4, codeY + 3, { width: W - 8, lineGap: 1 });
        doc.moveDown(0.3);

      } else if (el.type === 'table') {
        const colCount = el.rows[0] ? el.rows[0].length : 1;
        const colW     = Math.floor(W / colCount);
        const ROW_H    = 16;

        el.rows.forEach((row, ri) => {
          if (doc.y + ROW_H > doc.page.height - MARGIN) doc.addPage();
          const rowY    = doc.y;
          const isHeader = ri === 0;
          const isAlt   = ri % 2 === 0 && !isHeader;

          // Row background
          doc.save()
            .rect(MARGIN, rowY, W, ROW_H)
            .fill(isHeader ? `#${pal.headerBg}` : isAlt ? '#F8F8F8' : '#FFFFFF')
            .restore();

          // Left border highlight on header
          if (isHeader) {
            doc.save()
              .rect(MARGIN, rowY, 3, ROW_H)
              .fill(`#${pal.heading}`)
              .restore();
          }

          // Cell text
          row.forEach((cell, ci) => {
            doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
              .fontSize(9)
              .fillColor(isHeader ? `#${pal.heading}` : `#${pal.body}`)
              .text(cell, MARGIN + ci * colW + 4, rowY + 4,
                { width: colW - 6, lineBreak: false, ellipsis: true });
          });

          // Bottom cell border
          doc.save()
            .moveTo(MARGIN, rowY + ROW_H).lineTo(MARGIN + W, rowY + ROW_H)
            .strokeColor('#DDDDDD').lineWidth(0.5).stroke()
            .restore();

          doc.y = rowY + ROW_H;
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
