const express = require('express');
const cors = require('cors');
const path = require('path');

// Catch anything that escapes route handlers — prevents silent crashes
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught Exception:', err.message, err.stack);
  // Don't exit — keep the server alive so subsequent requests still work
});
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled Promise Rejection:', reason);
});

const tradesRouter = require('./routes/trades');
const dashboardRouter = require('./routes/dashboard');
const calendarRouter = require('./routes/calendar');
const accountsRouter = require('./routes/accounts');
const importRouter = require('./routes/importRoutes');
const withdrawalPlanRouter = require('./routes/withdrawalPlan');
const journalRouter        = require('./routes/journal');
const keySetupsRouter      = require('./routes/keySetups');
const keyLessonsRouter     = require('./routes/keyLessons');
const mistakeTypesRouter   = require('./routes/mistakeTypes');
const metadriftRouter      = require('./routes/metadrift');
const newsRouter           = require('./routes/news');

const app = express();
const PORT = process.env.PORT || 3001;

// Allow any localhost origin — covers Vite on 5173, 5174, etc. and direct-to-backend calls
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
}));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Routes
app.use('/api/trades', tradesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/import', importRouter);
app.use('/api/withdrawal-plan', withdrawalPlanRouter);
app.use('/api/journal',         journalRouter);
app.use('/api/key-setups',      keySetupsRouter);
app.use('/api/key-lessons',     keyLessonsRouter);
app.use('/api/mistake-types',   mistakeTypesRouter);
app.use('/api/metadrift',       metadriftRouter);
app.use('/api/news',           newsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve built React frontend (used in Electron / production — only active when dist exists)
const frontendDist = process.env.FRONTEND_DIST || path.join(__dirname, '../../frontend/dist');
const fs = require('fs');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    }
  });
}

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.path} not found` });
});

// Error handler — surface the real message so the frontend can display it
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.type || '', err.message, err.stack);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large — try a smaller file or contact support.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: `JSON parse error: ${err.message}` });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Trading Journal API running on http://localhost:${PORT}`);
  console.log(`   Database: ${path.resolve(__dirname, '../data/journal.db')}\n`);
});

module.exports = app;
