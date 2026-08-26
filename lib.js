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
  // Продана/закрыта досрочно — фактический профит не выводится по формуле,
  // а вводится вручную в момент продажи (может быть как в плюс, так и в минус).
  if (bet.result === 'Sold') return bet.manual_profit != null ? Number(bet.manual_profit) : 0;
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

// Группирует ставки по произвольному НАБОРУ ключей — один и тот же bet может
// попасть сразу в несколько групп (нужно для "Команды": ставка на матч А vs Б
// учитывается в статистике ОБЕИХ команд, а не только той, на которую ставили —
// вопрос не "за кого ставка", а "как я играю на матчах с участием этой команды").
export function groupBetsMulti(bets, keysFn) {
  const groups = new Map();
  bets.forEach(b => {
    const keys = keysFn(b) || [];
    keys.forEach(key => {
      if (key == null || key === '') return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    });
  });
  return Array.from(groups.entries())
    .map(([key, list]) => ({ key, list, ...computeStats(list, [], 0) }))
    .sort((a, b) => b.total - a.total);
}

// ---- Классификация рынка по тексту пика ----
// Портировано из старого журнала как есть — эвристики уже проверены на реальной
// истории ставок (666 записей), переизобретать не нужно.
export function classifyMarket(bet) {
  const pick = bet && bet.pick;
  if (bet && bet.discipline === 'CS2' && (bet.tournament || '').trim() === 'XSE Pro League') return 'Дуэли 1x1 (CS2)';
  if (!pick) return 'Другое';
  const p = pick.toLowerCase();
  if (p.includes('экспресс') || p.includes('parlay')) return 'Экспресс';
  if (p.includes('индивидуальный')) return 'Индивидуальный тотал';
  if (p.includes('мегакрип')) return 'Мегакрипы (спец.)';
  if (p.includes('фора') || p.includes('handicap') || p.includes('гандикап')) return 'Фора / гандикап';
  if (p.includes('тотал') || p.includes(' ou') || p.includes('total')) return 'Тотал (килы)';
  if (p.includes('продолжительност')) return 'Продолжительность карты';
  if (p.includes('первые 10') || p.includes('first to reach') || p.includes('kill') || p.includes('первую кровь') || p.includes('first blood')) return 'Гонка до N-го килла';
  if (p.includes('башн') || p.includes('tower')) return 'Разрушение построек';
  if (p.includes('победитель') || p.includes('1x2') || p.includes('исход') || p.includes('результат матча') || p.includes('ничья') || /(^|\s)п[12](\s|:|$)/.test(p)) return 'Победитель (матч/карта)';
  return 'Другое';
}

// ---- Каноническое имя команды из поля "Матч" ----
// Тоже портировано из старого журнала: названия команд пишутся непоследовательно
// (LevelUP / LEVEL UP / Level Up, L1 / L1GA, 1W / 1WIN / 1Win) — приводим к одному имени.
function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-zа-яё0-9]/gi, ''); }

const TEAM_ALIAS_GROUPS = [
  ['1Win', ['1W', '1WIN', '1Win']],
  ['Aurora Gaming', ['Aurora', 'Aurora Gaming', 'Aurora (продана досрочно)']],
  ['BB Team', ['BB', 'BB Team', 'BetBoom Team']],
  ['Team Falcons', ['Falcons', 'Team Falcons']],
  ['GamerLegion', ['GamerLegion', 'GamerLegion (Kills)']],
  ['Inner Circle', ['Inner Circle']],
  ['L1GA', ['L1', 'L1GA', 'L1ga']],
  ['LevelUP', ['LEVEL UP', 'Level UP', 'Level Up', 'LevelUP']],
  ['LGD Gaming', ['LGD', 'LGD Gaming']],
  ['Team Liquid', ['Liquid', 'Team Liquid']],
  ['MOUZ', ['MOUZ', 'MOUZ (Kills)']],
  ['Team Nemesis', ['Nemesis', 'Team Nemesis', 'Team nemesis']],
  ['Nigma Galaxy', ['Nigma Galaxy', 'Nigma Galaxy (Kills)']],
  ['Team OG', ['OG', 'Team OG']],
  ['PARIVISION', ['PARIVISION']],
  ['PlayTime', ['PlayTime', 'Плейтайм']],
  ['Poor Rangers', ['Poor Rangers']],
  ['RE.Arise', ['RE.Arise']],
  ['REKONIX', ['REKONIX']],
  ['Sharks Esports', ['Sharks Esports', 'DENDELE', 'DENDELE CS']],
  ['Rune Eaters', ['RUNE EATERS', 'Rune Eaters', 'Rune Eaters (Kills)']],
  ['Spirit', ['Spirit', 'Team Spirit']],
  ['Spirit Academy', ['Spirit Academy']],
  ['Vici Gaming', ['Vici', 'Vici (Kills)', 'Vici Gaming']],
  ['Virtus.pro', ['Virtus.pro']],
  ['Xtreme Gaming', ['Xtreme', 'Xtreme Gaming']],
  ['Yandex', ['Yandex', 'Team Yandex']],
  ['ZEDI Esports', ['ZEDI', 'ZEDI ESPORTS']],
  // Добавлено при сборке нового сайта — в исходном алиас-списке не было разных
  // капитализаций этих команд, из-за чего они дробились на отдельные строки.
  ['Heroic', ['Heroic', 'HEROIC']],
  ['Ninjas in Pyjamas', ['Ninjas in Pyjamas', 'Ninjas In Pyjamas', 'NiP']],
  ['paiN Gaming', ['paiN Gaming', 'paiN']],
  ['FURIA Esports', ['FURIA', 'FURIA Esports']],
];
const TEAM_ALIASES = {};
TEAM_ALIAS_GROUPS.forEach(([canon, variants]) => {
  variants.forEach(v => { TEAM_ALIASES[normKey(v)] = canon; });
});

export function canonicalTeam(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const key = normKey(stripped) || normKey(raw);
  return TEAM_ALIASES[key] || stripped || raw;
}

export function getMatchTeams(bet) {
  if (!bet || !bet.match) return null;
  const parts = bet.match.split(/\s+vs\s+/i);
  if (parts.length !== 2) return null;
  return [canonicalTeam(parts[0].trim()), canonicalTeam(parts[1].trim())];
}

// Дуэли 1x1 (игрок vs игрок) — не командные ставки, исключаем из статистики по командам.
const DUEL_PLAYER_NAMES = new Set(['tailung', 'midone', 'collapse', 'ace', 'dm', 'noticed', 'kataomi', 'dukalis', 'banjo', 'pr'].map(normKey));

export function isDuelBet(bet) {
  if (!bet) return false;
  if (bet.discipline === 'CS2' && (bet.tournament || '').trim() === 'XSE Pro League') return true;
  const match = String(bet.match || '');
  const parts = match.split(/\s+vs\s+/i);
  if (parts.length !== 2) return false;
  const structural = /^[^()]+\([^)]+\)$/;
  if (structural.test(parts[0].trim()) && structural.test(parts[1].trim())) return true;
  const nameA = normKey(parts[0].trim());
  const nameB = normKey(parts[1].trim());
  if (DUEL_PLAYER_NAMES.has(nameA) && DUEL_PLAYER_NAMES.has(nameB)) return true;
  return false;
}

// Ключи команд для группировки по "Команды" — ставка засчитывается ОБЕИМ командам матча.
export function teamKeysForBet(bet) {
  if (isDuelBet(bet)) return [];
  const teams = getMatchTeams(bet);
  if (!teams) return [];
  return teams.filter(Boolean);
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
