// Quant Desk mount. The desk lives in a sibling folder (trading-journal/desk) with its OWN
// node_modules (better-sqlite3 built for the system node). If that folder or its install is
// missing, the app still boots and this route answers 503.
const express = require('express');
const path = require('path');

let router;
try {
  router = require(path.join(__dirname, '../../../desk/src/api.js'));
} catch (e) {
  console.error('[desk] module not available:', e.message);
  router = express.Router();
  router.use((req, res) => {
    res.status(503).json({ error: 'desk module not available', detail: e.message });
  });
}

module.exports = router;
