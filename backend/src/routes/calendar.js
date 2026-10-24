const express = require('express');
const router = express.Router();
const { getCalendarData } = require('../services/statsService');

router.get('/', (req, res) => {
  const { year, month, account, dateFrom, dateTo } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || new Date().getMonth() + 1;
  const filters = account && account !== 'All' ? { account } : {};
  const data = getCalendarData(y, m, filters, dateFrom || null, dateTo || null);
  res.json({ year: y, month: m, days: data });
});

module.exports = router;
