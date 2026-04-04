export function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return parseFloat(n).toFixed(decimals);
}

export function fmtCurrency(n, showSign = false) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const str = abs >= 1000
    ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : abs.toFixed(2);
  const prefix = n < 0 ? '-$' : showSign && n > 0 ? '+$' : '$';
  return prefix + str;
}

export function fmtPct(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  const val = parseFloat(n);
  const sign = val > 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(decimals)}%`;
}

export function fmtPnl(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + fmtCurrency(n);
}

export function pnlClass(n) {
  if (n == null || isNaN(n) || n === 0) return 'pnl-zero';
  return n > 0 ? 'pnl-positive' : 'pnl-negative';
}

export function statusBadgeClass(status) {
  switch (status?.toUpperCase()) {
    case 'WIN': return 'badge-win';
    case 'LOSS': return 'badge-loss';
    case 'B/E': return 'badge-be';
    case 'OPEN': return 'badge-open';
    default: return 'badge-be';
  }
}

export function formatDate(dt) {
  if (!dt) return '—';
  try {
    const d = new Date(dt);
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dt; }
}

export function formatDateTime(dt) {
  if (!dt) return '—';
  try {
    const d = new Date(dt);
    return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return dt; }
}

export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function getFirstDayOfMonth(year, month) {
  return new Date(year, month - 1, 1).getDay();
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const STRATEGY_COLORS = {
  'ASIA Scalp': '#00ff88',
  'ASIA Check Six': '#4488ff',
  'Asia Flag': '#ffaa00',
  'NY DUMBNESS': '#ff6644',
};

export const CHART_COLORS = ['#00ff88', '#4488ff', '#ffaa00', '#ff6644', '#aa44ff', '#44ffee'];
