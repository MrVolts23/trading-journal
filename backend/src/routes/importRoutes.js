const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const importService = require('../services/importService');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB hard cap

// Reads the raw request body as a Buffer — no body-parser middleware needed.
// Works for any Content-Type, bypasses all express.json / express.urlencoded
// interactions that caused intermittent 500s with the previous approach.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy();
        return reject(Object.assign(new Error('File too large (max 100 MB)'), { status: 413 }));
      }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── In-memory upload session store ──────────────────────────────────────────
// uploadId → { filename, tempPath, rowCount, processedRows?, balanceRows?, created }
const uploadSessions = new Map();

// Clean up sessions older than 1 hour every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, session] of uploadSessions) {
    if (session.created < cutoff) {
      try { if (session.tempPath) fs.unlinkSync(session.tempPath); } catch (_) {}
      uploadSessions.delete(id);
    }
  }
}, 300_000);

// ─── Mapping config endpoints ─────────────────────────────────────────────────
router.get('/mapping/default',  (req, res) => res.json(importService.getDefaultMapping()));
router.get('/mapping/presets',  (req, res) => res.json(importService.getPresetMappings()));
router.get('/mapping/saved',    (req, res) => res.json(importService.getSavedMappings()));
router.post('/mapping/save',    (req, res) => {
  const { name, broker, mapping } = req.body;
  const result = importService.saveMapping(name, broker, mapping);
  res.json({ id: result.lastInsertRowid });
});

// ─── STEP 1 — POST /upload ────────────────────────────────────────────────────
// Receives the file as application/octet-stream (raw binary, no multipart).
// Reads the body via raw Node.js streams — no body-parser middleware involved.
// Filename comes from the X-Filename header (URL-encoded).
router.post('/upload', async (req, res) => {
  try {
    const buffer = await readRawBody(req);
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No file received — body is empty' });
    }

    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.xlsx');
    console.log('[upload]', filename, buffer.length, 'bytes');

    // Persist to temp dir
    const uploadId = crypto.randomUUID();
    const tempPath = path.join(os.tmpdir(), `trade-import-${uploadId}`);
    fs.writeFileSync(tempPath, buffer);

    // Detect columns so the frontend can render the mapping UI immediately
    const rows    = importService.parseFile(buffer, filename);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // Detect broker Login IDs (EightCap MT5 format has a Login column per account)
    const detectedLogins = importService.detectLoginsFromRows(rows);

    uploadSessions.set(uploadId, {
      filename,
      tempPath,
      rowCount: rows.length,
      created:  Date.now(),
    });

    console.log('[upload] stored', uploadId, '—', rows.length, 'rows,', columns.length, 'columns', detectedLogins.length ? `| logins: ${detectedLogins.join(', ')}` : '');
    res.json({ uploadId, filename, size: buffer.length, columns, rowCount: rows.length, detectedLogins });
  } catch (e) {
    console.error('[upload] error:', e.message, e.stack?.split('\n')[1]);
    const status = e.status || 400;
    if (!res.headersSent) res.status(status).json({ error: e.message });
  }
});

// ─── STEP 2 — POST /preview ───────────────────────────────────────────────────
// Plain JSON.  Reads the temp file identified by uploadId, applies the provided
// mapping, and stores the processed rows in the session for the commit step.
router.post('/preview', (req, res) => {
  try {
    const { uploadId, mapping: mappingConfig, importFromDate, account } = req.body;
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found — please re-upload your file' });
    }

    const buffer  = fs.readFileSync(session.tempPath);
    const mapping = mappingConfig || importService.getDefaultMapping();
    console.log('[preview] uploadId:', uploadId, '| mode:', mapping.mode || 'standard', '| fromDate:', importFromDate || 'all', '| account:', account || 'default');

    const rows    = importService.parseFile(buffer, session.filename);
    const preview = importService.previewImport(rows, mapping, importFromDate || null, account || null);
    console.log('[preview] new:', preview.new_count, '| dups:', preview.duplicate_count, '| noise:', preview.noise_count);

    // Cache for commit — avoids re-processing and eliminates the large all_rows round-trip
    session.processedRows = preview.all_rows;
    session.balanceRows   = preview.balance_rows || [];

    res.json({ ...preview, columns: rows.length > 0 ? Object.keys(rows[0]) : [] });
  } catch (e) {
    console.error('[preview] error:', e.message, e.stack?.split('\n')[1]);
    res.status(400).json({ error: e.message });
  }
});

// ─── STEP 3 — POST /commit ────────────────────────────────────────────────────
// Plain JSON.  Commits the rows that were cached during /preview.
router.post('/commit', (req, res) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

    const session = uploadSessions.get(uploadId);
    if (!session)            return res.status(404).json({ error: 'Upload session not found — please re-upload your file' });
    if (!session.processedRows) return res.status(400).json({ error: 'No preview data — run /preview before /commit' });

    const result = importService.commitImport(session.processedRows);
    if (session.balanceRows?.length) {
      const balResult = importService.commitAccountActivity(session.balanceRows);
      result.account_activity_inserted = balResult.inserted;
    }

    // Clean up temp file and session
    try { fs.unlinkSync(session.tempPath); } catch (_) {}
    uploadSessions.delete(uploadId);

    res.json(result);
  } catch (e) {
    console.error('[commit] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
