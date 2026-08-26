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

// Группирует ставки по произвольному ключу (дисциплина, букмекер, тип ставки,
// эдж-паттерн — что угодно) и считает статистику внутри каждой группы. Ставки
// без значения ключа (null/пусто) в группировку не попадают — вызывающий код
// сам решает, показывать ли отдельно "без метки".
export function groupBets(bets, keyFn) {
  const groups = new Map();
  bets.forEach(b => {
    const key = keyFn(b);
    if (key == null || key === '') return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });
  return Array.from(groups.entries())
    .map(([key, list]) => ({ key, list, ...computeStats(list, [], 0) }))
    .sort((a, b) => b.total - a.total);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Рендерит таблицу "группа → статистика" — используется на страницах
// По дисциплинам / По букмекерам / Сегментация / Найденные эджи, чтобы не
// повторять одну и ту же вёрстку таблицы четыре раза.
export function renderGroupTable(groups, labelHeader) {
  if (!groups.length) {
    return '<div class="empty-state">Пока нет данных для этой разбивки — добавь ставки с этим полем на странице «Ставки».</div>';
  }
  const rows = groups.map(g => `
    <tr>
      <td>${escapeHtml(g.key)}</td>
      <td class="num">${g.total}</td>
      <td class="num">${g.wins}-${g.losses}-${g.pushes}</td>
      <td class="num">${g.winrate == null ? '—' : g.winrate.toFixed(1) + '%'}</td>
      <td class="num ${g.roi > 0 ? 'pos-text' : g.roi < 0 ? 'neg-text' : ''}">${g.roi == null ? '—' : g.roi.toFixed(2) + '%'}</td>
      <td class="num ${g.totalProfit > 0 ? 'pos-text' : g.totalProfit < 0 ? 'neg-text' : ''}">${fmtMoney(g.totalProfit)}</td>
    </tr>`).join('');
  return `
    <div class="table-wrap">
      <div class="table-scroll">
        <table class="bets-table">
          <thead><tr><th>${labelHeader}</th><th>Ставок</th><th>W-L-P</th><th>Винрейт</th><th>ROI</th><th>Профит</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}
