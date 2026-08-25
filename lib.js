// Общая логика подсчёта статистики — используется на Дашборде и странице
// "Выводы и банк", чтобы не дублировать формулы в двух файлах.

export function fmtMoney(n) {
  const sign = n < 0 ? '−' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\.00$/, '');
}

// Профит по одной ставке в $. null — если ставка ещё не сыграна (Pending).
export function computeProfit(bet) {
  if (bet.result === 'Win') return Number(bet.stake) * (Number(bet.odds) - 1);
  if (bet.result === 'Loss') return -Number(bet.stake);
  if (bet.result === 'Push') return 0;
  return null;
}

// Сводная статистика по массиву ставок + выводов + стартовому банку.
export function computeStats(bets, withdrawals, startingBankroll) {
  const settled = bets.filter(b => b.result !== 'Pending');
  const wins = settled.filter(b => b.result === 'Win').length;
  const losses = settled.filter(b => b.result === 'Loss').length;
  const pushes = settled.filter(b => b.result === 'Push').length;
  const pending = bets.length - settled.length;

  const totalStaked = settled
    .filter(b => b.result !== 'Push')
    .reduce((s, b) => s + Number(b.stake || 0), 0);

  const totalProfit = settled.reduce((s, b) => s + (computeProfit(b) || 0), 0);

  const decided = wins + losses;
  const winrate = decided ? (wins / decided * 100) : null;
  const roi = totalStaked ? (totalProfit / totalStaked * 100) : null;

  const withOdds = bets.filter(b => b.odds != null);
  const avgOdds = withOdds.length
    ? withOdds.reduce((s, b) => s + Number(b.odds || 0), 0) / withOdds.length
    : null;

  const totalWithdrawn = withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0);
  const currentBank = Number(startingBankroll || 0) + totalProfit - totalWithdrawn;
  const bankGrowthPct = startingBankroll ? (totalProfit / startingBankroll * 100) : null;

  return {
    total: bets.length, wins, losses, pushes, pending,
    totalProfit, roi, winrate, avgOdds,
    totalWithdrawn, currentBank, bankGrowthPct,
    startingBankroll: Number(startingBankroll || 0),
  };
}
