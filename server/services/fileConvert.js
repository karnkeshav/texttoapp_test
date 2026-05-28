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
    size: 20,                    // 10 pt
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
        children: [new TextRun({ text: el.text, font: 'Courier New', size: 18, color: '333333' })],
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
          run: { font: 'Calibri', size: 20 },
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

// ── PPT colour themes — one per purpose (1–5) plus a default ─────────────────
// Each theme drives every colour constant inside toPptx.
// isDark: true  → slide background is dark, body text is light
// isDark: false → slide background is light, body text is dark
// TITLE_TEXT    → text colour for slide titles (always WHITE — title bar uses ACCENT/BG2 bg)
const PPT_THEMES = {
  // Purpose 1 — Business / Strategy: clean corporate navy/gold
  '1': {
    isDark:     false,
    BG:         'FAFBFE',   // near-white slide background
    BG2:        'E8EEF8',   // soft blue-grey wash (decorative, alt table rows)
    BG3:        'D0DCF4',   // slightly deeper wash
    ACCENT:     '1B3A6B',   // navy — pillar, title bar, headings, bullets
    ACCENT2:    'B07D2A',   // gold — secondary accent
    WHITE:      'FFFFFF',
    BODY:       '1E2D4A',   // near-navy — body text
    MUTED:      '6B7280',   // grey — footer / dates
    WARN:       'B07D2A',
    TITLE_TEXT: 'FFFFFF',   // white text on navy title bar
  },
  // Purpose 2 — Teaching / Training: friendly indigo/orange
  '2': {
    isDark:     false,
    BG:         'F5F6FF',
    BG2:        'E0E4FF',
    BG3:        'C7CFFF',
    ACCENT:     '3730A3',   // deep indigo
    ACCENT2:    'EA580C',   // orange
    WHITE:      'FFFFFF',
    BODY:       '1E1B4B',
    MUTED:      '6B7280',
    WARN:       'EA580C',
    TITLE_TEXT: 'FFFFFF',
  },
  // Purpose 3 — Report / Research / Data: steel-blue precision
  '3': {
    isDark:     false,
    BG:         'FFFFFF',
    BG2:        'F1F5F9',
    BG3:        'E2E8F0',
    ACCENT:     '0C4A6E',   // deep ocean blue
    ACCENT2:    '0284C7',   // lighter blue
    WHITE:      'FFFFFF',
    BODY:       '0F172A',   // near-black
    MUTED:      '64748B',
    WARN:       '0284C7',
    TITLE_TEXT: 'FFFFFF',
  },
  // Purpose 4 — Pitch / Proposal: bold dark indigo/gold
  '4': {
    isDark:     true,
    BG:         '0F172A',   // midnight navy
    BG2:        '1E293B',
    BG3:        '273549',
    ACCENT:     '818CF8',   // soft indigo
    ACCENT2:    'F59E0B',   // gold
    WHITE:      'FFFFFF',
    BODY:       'CBD5E1',
    MUTED:      '64748B',
    WARN:       'F59E0B',
    TITLE_TEXT: 'FFFFFF',
  },
  // Purpose 5 — Marketing / Public Speaking: electric magenta/amber
  '5': {
    isDark:     true,
    BG:         '120726',   // deep violet-black
    BG2:        '1E0A40',
    BG3:        '2D1060',
    ACCENT:     'D946EF',   // bright magenta
    ACCENT2:    'FBBF24',   // amber
    WHITE:      'FFFFFF',
    BODY:       'EDE9FE',   // soft lavender — readable body text
    MUTED:      'A78BFA',
    WARN:       'FBBF24',
    TITLE_TEXT: 'FFFFFF',
  },
  // Default / "Other" — modern dark teal (original theme)
  'default': {
    isDark:     true,
    BG:         '0A1628',
    BG2:        '0F2040',
    BG3:        '162848',
    ACCENT:     '14B8A6',
    ACCENT2:    '3B82F6',
    WHITE:      'FFFFFF',
    BODY:       'CBD5E1',
    MUTED:      '64748B',
    WARN:       'F59E0B',
    TITLE_TEXT: 'FFFFFF',
  },
};

// ── PowerPoint (.pptx) ───────────────────────────────────────────────────────
async function toPptx(elements, purposeKey) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  // ── Dimensions ────────────────────────────────────────────────
  const SW = 13.33;  // slide width  inches
  const SH = 7.5;    // slide height inches

  // ── Pick theme based on purpose ───────────────────────────────
  const T = PPT_THEMES[String(purposeKey)] || PPT_THEMES['default'];
  const { BG, BG2, BG3, ACCENT, ACCENT2, WHITE, BODY, MUTED, WARN, TITLE_TEXT, isDark } = T;
  // Title bar bg: accent-coloured bar for light themes, subtler dark for dark themes
  const TITLE_BAR = isDark ? BG2 : ACCENT;

  // ── Shape helpers ─────────────────────────────────────────────
  const R = pptx.ShapeType.rect;
  const bgFill = (s) =>
    s.addShape(R, { x:0, y:0, w:SW, h:SH, fill:{ color:BG }, line:{ color:BG } });
  const box = (s, x, y, w, h, color, lineColor) =>
    s.addShape(R, { x, y, w, h, fill:{ color }, line:{ color: lineColor || color } });

  function footer(s, num) {
    s.addText(String(num), {
      x: SW - 0.55, y: SH - 0.4, w: 0.4, h: 0.28,
      fontFace:'Calibri', fontSize:8, color:MUTED, align:'right',
    });
    // Thin bottom accent line
    box(s, 0, SH - 0.08, SW, 0.08, ACCENT);
  }

  // ── TITLE SLIDE ───────────────────────────────────────────────
  function makeTitleSlide(title, subtitle) {
    const s = pptx.addSlide();
    bgFill(s);
    // Left accent pillar
    box(s, 0, 0, 0.65, SH, ACCENT);
    // Decorative circle (top-right) — uses BG2 so it's subtle on any theme
    s.addShape(pptx.ShapeType.ellipse, {
      x: SW - 2.8, y: -1.4, w: 4.2, h: 4.2,
      fill:{ color:BG2 }, line:{ color:BG2 },
    });
    // Bottom right decorative circle
    s.addShape(pptx.ShapeType.ellipse, {
      x: SW - 1.8, y: SH - 2.0, w: 3.0, h: 3.0,
      fill:{ color:BG3 }, line:{ color:BG3 },
    });

    // Title text colour: white on dark themes; heading-dark on light themes
    const titleColor = isDark ? WHITE : ACCENT;
    s.addText(title || 'Presentation', {
      x:1.0, y:1.5, w:10.0, h:2.8,
      fontFace:'Calibri', fontSize:42, bold:true, color:titleColor,
      valign:'middle', wrap:true, lineSpacingMultiple:1.1,
    });
    // Accent bar under title
    box(s, 1.0, 4.45, 3.8, 0.07, ACCENT);
    // Subtitle
    if (subtitle) {
      s.addText(subtitle, {
        x:1.0, y:4.65, w:10.5, h:1.0,
        fontFace:'Calibri', fontSize:17, color:BODY,
        valign:'top', wrap:true, italic:true,
      });
    }
    // Date
    s.addText(new Date().toLocaleDateString('en-GB',{year:'numeric',month:'long'}), {
      x:1.0, y:SH - 0.65, w:5, h:0.35,
      fontFace:'Calibri', fontSize:9, color:MUTED,
    });
  }

  // ── AGENDA SLIDE ──────────────────────────────────────────────
  function makeAgendaSlide(secTitles) {
    const s = pptx.addSlide();
    bgFill(s);
    box(s, 0, 0, 0.65, SH, ACCENT);
    // Heading
    const headColor = isDark ? WHITE : ACCENT;
    s.addText('Contents', {
      x:0.9, y:0.45, w:5, h:0.7,
      fontFace:'Calibri', fontSize:28, bold:true, color:headColor,
    });
    box(s, 0.9, 1.22, 2.8, 0.06, ACCENT);

    secTitles.slice(0, 8).forEach((t, i) => {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const x   = 0.9 + col * 3.1;
      const y   = 1.5 + row * 2.5;
      // Card
      box(s, x, y, 2.85, 2.15, BG2);
      box(s, x, y, 0.07, 2.15, ACCENT);
      // Number
      s.addText(String(i+1).padStart(2,'0'), {
        x:x+0.2, y:y+0.15, w:1.5, h:0.55,
        fontFace:'Calibri', fontSize:22, bold:true, color:ACCENT,
      });
      // Title
      s.addText(t, {
        x:x+0.2, y:y+0.72, w:2.5, h:1.2,
        fontFace:'Calibri', fontSize:11.5, color:BODY, wrap:true, valign:'top',
      });
    });
    footer(s, 2);
  }

  // ── SECTION DIVIDER SLIDE ─────────────────────────────────────
  function makeSectionSlide(title, secNum, slideNum) {
    const s = pptx.addSlide();
    bgFill(s);
    box(s, 0, 0, 0.65, SH, ACCENT);
    // Huge watermark number — uses BG2 so it sits behind the title text subtly
    const wmColor = isDark ? BG2 : BG3;
    s.addText(String(secNum).padStart(2,'0'), {
      x:7.5, y:0.0, w:5.5, h:SH,
      fontFace:'Calibri', fontSize:220, bold:true, color:wmColor,
      align:'right', valign:'middle',
    });
    // Section chip
    s.addText(`SECTION  ${String(secNum).padStart(2,'0')}`, {
      x:0.9, y:1.8, w:8, h:0.5,
      fontFace:'Calibri', fontSize:12, bold:true, color:ACCENT, charSpacing:4,
    });
    box(s, 0.9, 2.4, 3.5, 0.07, ACCENT);
    const secTitleColor = isDark ? WHITE : ACCENT;
    s.addText(title, {
      x:0.9, y:2.6, w:10.5, h:2.8,
      fontFace:'Calibri', fontSize:34, bold:true, color:secTitleColor,
      valign:'top', wrap:true,
    });
    footer(s, slideNum);
  }

  // ── CONTENT SLIDE ─────────────────────────────────────────────
  function makeContentSlide(title, contentItems, slideNum) {
    const s = pptx.addSlide();
    bgFill(s);
    box(s, 0, 0, 0.65, SH, ACCENT);    // left accent pillar
    box(s, 0.65, 0, SW - 0.65, 1.15, TITLE_BAR);  // title bar (ACCENT for light, BG2 for dark)
    box(s, 0.65, 1.15, SW - 0.65, 0.06, ACCENT);  // accent underline

    if (title) {
      s.addText(title, {
        x:0.85, y:0.1, w:SW - 1.1, h:0.96,
        fontFace:'Calibri', fontSize:19, bold:true, color:TITLE_TEXT,
        valign:'middle', wrap:true,
      });
    }

    const CY = 1.35;
    const CH = SH - CY - 0.45;

    const tables  = contentItems.filter(i => i.type === 'table');
    const nonTbls = contentItems.filter(i => i.type !== 'table');
    const hasBoth = tables.length > 0 && nonTbls.length > 0;

    // ── Left / full-width text column ─────────────────────────
    const textX = 0.85;
    const textW = hasBoth ? 5.8 : SW - 1.0;
    const tblX  = hasBoth ? 7.0 : 0.85;
    const tblW  = hasBoth ? SW - 7.2 : SW - 1.0;

    if (nonTbls.length > 0) {
      const lines = [];
      for (const item of nonTbls) {
        if (item.type === 'heading') {
          if (lines.length) lines.push({ text:'\n', options:{ fontSize:5, breakLine:true } });
          lines.push({ text: item.text, options:{
            fontFace:'Calibri', fontSize:13.5, bold:true, color:ACCENT,
            paraSpaceBefore:6, paraSpaceAfter:4, breakLine:true,
          }});
        } else if (item.type === 'text') {
          lines.push({ text: '›  ' + item.text, options:{
            fontFace:'Calibri', fontSize:12, color:BODY,
            paraSpaceAfter:6, breakLine:true,
          }});
        } else if (item.type === 'bullets') {
          item.items.forEach(b => lines.push({ text: b, options:{
            fontFace:'Calibri', fontSize:12, color:BODY,
            bullet:{ type:'bullet', characterCode:'25B6', color:ACCENT },
            paraSpaceBefore:2, paraSpaceAfter:7, indentLevel:0, breakLine:true,
          }}));
        } else if (item.type === 'numbered') {
          item.items.forEach((b, idx) => lines.push({ text: `${idx+1}.   ${b}`, options:{
            fontFace:'Calibri', fontSize:12, color:BODY,
            paraSpaceBefore:2, paraSpaceAfter:7, breakLine:true,
          }}));
        }
      }
      if (lines.length) {
        s.addText(lines, { x:textX, y:CY, w:textW, h:CH, valign:'top', wrap:true });
      }
    }

    // ── Table column ──────────────────────────────────────────
    // Header: always ACCENT bg + white text for strong contrast on any theme
    // Alt rows: BG2 / BG3 — subtle on light themes, visible on dark
    const tblAlt1 = isDark ? BG3 : BG2;
    const tblAlt2 = isDark ? '132038' : BG3;
    let ty = CY;
    tables.forEach(tbl => {
      const cols = tbl.rows[0] ? tbl.rows[0].length : 1;
      const cw   = tblW / cols;
      const rows = tbl.rows.map((row, ri) =>
        row.map(cell => ({
          text: cell || '',
          options:{
            fontFace:'Calibri', fontSize:10, bold: ri === 0,
            color: ri === 0 ? WHITE : BODY,
            fill:  ri === 0 ? ACCENT : (ri % 2 === 0 ? tblAlt1 : tblAlt2),
            align:'left', valign:'middle',
            margin:[4,8,4,8],
            border:[
              {type:'solid', pt:0.5, color:BG3},
              {type:'solid', pt:0.5, color:BG3},
              {type:'solid', pt:0.5, color:BG3},
              {type:'solid', pt:0.5, color:BG3},
            ],
          },
        }))
      );
      s.addTable(rows, { x:tblX, y:ty, w:tblW, colW:Array(cols).fill(cw), rowH:0.32 });
      ty += tbl.rows.length * 0.34 + 0.2;
    });

    footer(s, slideNum);
  }

  // ── Parse Markdown elements → presentation structure ──────────
  // H1 first = title slide; subsequent H1 = section dividers
  // H2 = content slide; H3 = sub-heading within slide
  let presTitle    = '';
  let presSubtitle = '';
  let firstH1      = false;
  const sections   = [];
  let curSection   = null;
  let curSlide     = null;

  function flushSlide() {
    if (!curSlide) return;
    if (!curSection) curSection = { title:'', slides:[] };
    curSection.slides.push(curSlide);
    curSlide = null;
  }
  function flushSection() {
    flushSlide();
    if (curSection) { sections.push(curSection); curSection = null; }
  }
  function ensureSlide() {
    if (!curSlide) {
      if (!curSection) curSection = { title:'', slides:[] };
      curSlide = { title:'', content:[] };
    }
  }

  for (const el of elements) {
    // Skip horizontal rules (--- renders as literal text otherwise)
    if (el.type === 'paragraph' && /^-{3,}$/.test(el.text.trim())) continue;

    if (el.type === 'h1') {
      if (!firstH1) { firstH1 = true; presTitle = el.text; }
      else { flushSection(); curSection = { title: el.text, slides:[] }; }
    } else if (el.type === 'h2') {
      flushSlide();
      if (!curSection) curSection = { title:'', slides:[] };
      curSlide = { title: el.text, content:[] };
    } else if (el.type === 'h3') {
      if (!curSlide) { ensureSlide(); curSlide.title = el.text; }
      else curSlide.content.push({ type:'heading', text: el.text });
    } else if (el.type === 'paragraph') {
      if (!firstH1) { presSubtitle = el.text; firstH1 = true; }
      else { ensureSlide(); curSlide.content.push({ type:'text', text: el.text }); }
    } else if (el.type === 'bullets')  { ensureSlide(); curSlide.content.push({ type:'bullets',  items: el.items }); }
    else if (el.type === 'numbered')   { ensureSlide(); curSlide.content.push({ type:'numbered', items: el.items }); }
    else if (el.type === 'table')      { ensureSlide(); curSlide.content.push({ type:'table',    rows:  el.rows  }); }
    else if (el.type === 'code')       { ensureSlide(); curSlide.content.push({ type:'text',     text:  el.text  }); }
  }
  flushSection();

  if (sections.length === 0) {
    sections.push({ title:'', slides:[{ title:'', content: elements.flatMap(e => {
      if (e.type === 'bullets')  return [{ type:'bullets',  items: e.items }];
      if (e.type === 'numbered') return [{ type:'numbered', items: e.items }];
      if (e.type === 'table')    return [{ type:'table',    rows:  e.rows  }];
      if (['h1','h2','h3','paragraph'].includes(e.type)) return [{ type:'text', text: e.text }];
      return [];
    }) }] });
  }

  // ── Hard cap: 10 total slides (title counts as 1) ─────────────
  // Count potential slides: 1 (title) + 1 (agenda if >1 section) +
  // per section: 1 divider + N content slides.
  // Trim sections/slides until we fit within 10.
  const MAX_SLIDES = 10;

  function countSlides(secs) {
    const hasAgenda = secs.filter(s => s.title).length > 1;
    let n = 1 + (hasAgenda ? 1 : 0);
    for (const sec of secs) {
      if (sec.title) n++;
      for (const sl of sec.slides) {
        // Each slide might split — approximate as 1
        n++;
      }
    }
    return n;
  }

  // Trim excess content slides from the end until within cap
  while (countSlides(sections) > MAX_SLIDES) {
    let trimmed = false;
    for (let si = sections.length - 1; si >= 0; si--) {
      if (sections[si].slides.length > 0) {
        sections[si].slides.pop();
        trimmed = true;
        break;
      }
    }
    if (!trimmed) break; // safety valve
  }
  // Remove now-empty trailing sections
  while (sections.length > 0 && sections[sections.length-1].slides.length === 0 && !sections[sections.length-1].title) {
    sections.pop();
  }

  // ── Render slides ─────────────────────────────────────────────
  let slideNum = 1;
  makeTitleSlide(presTitle, presSubtitle);

  const secTitles = sections.map(s => s.title).filter(Boolean);
  if (secTitles.length > 1) {
    makeAgendaSlide(secTitles);
    slideNum = 2;
  }

  let secIdx = 0;
  for (const section of sections) {
    slideNum++;
    if (section.title) { secIdx++; makeSectionSlide(section.title, secIdx, slideNum); slideNum++; }
    for (const sl of section.slides) {
      makeContentSlide(sl.title, sl.content, slideNum);
      slideNum++;
    }
  }

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
 * @param {string} content        - Raw AI Markdown content
 * @param {string} format         - 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv' | 'json'
 * @param {string} filename       - Desired filename without extension
 * @param {object} [options]      - Optional extra settings
 * @param {string} [options.purposeKey] - PPT purpose key ('1'–'5') for theme selection
 * @returns {Promise<{ buffer: Buffer|string, mimeType: string, ext: string }>}
 */
async function convert(content, format, filename = 'document', options = {}) {
  const elements = parseMarkdownElements(content);
  const mimeType = MIME[format] || MIME.docx;
  const ext = format;

  let buffer;
  switch (format) {
    case 'docx': buffer = await toDocx(elements); break;
    case 'xlsx': buffer = await toXlsx(elements); break;
    case 'pptx': buffer = await toPptx(elements, options.purposeKey); break;
    case 'pdf':  buffer = await toPdf(elements);  break;
    case 'csv':  buffer = toCsv(elements);  break;
    case 'json': buffer = toJson(elements); break;
    default: throw new Error(`Unsupported format: ${format}`);
  }

  return { buffer, mimeType, ext };
}

module.exports = { convert, parseMarkdownElements };
