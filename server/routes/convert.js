'use strict';
/**
 * convert.js — POST /api/convert-file
 *
 * Accepts AI-generated Markdown content and a target format,
 * returns the binary file for download.
 *
 * Body: { content: string, format: 'docx'|'xlsx'|'pptx'|'pdf'|'csv'|'json', filename?: string }
 */

const express = require('express');
const { convert } = require('../services/fileConvert');

const router = express.Router();

const ALLOWED_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'json']);

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.post('/convert-file', requireAuth, async (req, res) => {
  const { content, format, filename = 'document' } = req.body;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  const fmt = (format || 'docx').toLowerCase().replace(/^\./, '');
  if (!ALLOWED_FORMATS.has(fmt)) {
    return res.status(400).json({ error: `Unsupported format: ${fmt}. Use: ${[...ALLOWED_FORMATS].join(', ')}` });
  }

  // Sanitise filename — keep only safe characters
  const safeName = (filename || 'document')
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .trim()
    .slice(0, 80) || 'document';

  try {
    const { buffer, mimeType, ext } = await convert(content, fmt, safeName);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');

    if (typeof buffer === 'string') {
      res.send(buffer);
    } else {
      res.send(buffer);
    }
  } catch (err) {
    console.error('[convert-file] Error:', err.message);
    res.status(500).json({ error: 'File conversion failed: ' + err.message });
  }
});

module.exports = router;
