const express = require('express');
const router = express.Router();
const stats = require('../services/statsService');


router.get('/stats', (req, res) => {
  const filters = {
    account: req.query.account,
    dateStart: req.query.dateStart,
    dateEnd: req.query.dateEnd,
  };
  res.json(stats.getDashboardStats(filters));
});

router.get('/pnl-over-time', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  const data = stats.getPnlOverTime(filters);
  // Compute cumulative
  let cum = 0;
  const result = data.map(d => {
    cum += d.daily_pnl || 0;
    return { ...d, cumulative_pnl: parseFloat(cum.toFixed(2)) };
  });
  res.json(result);
});

router.get('/strategy-performance', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getStrategyPerformance(filters));
});

router.get('/market-performance', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getMarketPerformance(filters));
});

router.get('/winrate-by-day', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getWinRateByDay(filters));
});

router.get('/duration-distribution', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getDurationDistribution(filters));
});

router.get('/balance-over-time', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getBalanceOverTime(filters));
});

router.get('/plan-adherence', (req, res) => {
  const filters = { account: req.query.account, dateStart: req.query.dateStart, dateEnd: req.query.dateEnd };
  res.json(stats.getPlanAdherence(filters));
});

module.exports = router;
