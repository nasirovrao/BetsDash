// Общая логика подсчёта статистики — используется на Дашборде и странице
// "Выводы и банк", чтобы не дублировать формулы в двух файлах.

export function fmtMoney(n) {
  const sign = n < 0 ? '−' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\.00$/, '');
}

// Разметка для карточки "W / L / P" — вместо голого "15 / 11 / 1" (непонятно
// с ходу, где какое число) показывает три мягких цветных пилюли-бейджа:
// победы зелёным, поражения красным, пуши нейтральным — тот же визуальный
// язык, что и у res-pill (Win/Loss/Push в ленте ставок), только покрупнее.
// Общий helper — чтобы дашборд и все страницы с разбивкой
// (renderBreakdownDetail) выглядели одинаково, а не по-своему на каждой странице.
export function renderWLP(wins, losses, pushes) {
  return `
    <div class="wlp-row">
      <span class="wlp-pill wlp-w"><b>${wins}</b>W</span>
      <span class="wlp-pill wlp-l"><b>${losses}</b>L</span>
      <span class="wlp-pill wlp-p"><b>${pushes}</b>P</span>
    </div>`;
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

// Точки кривой банка по дням: старт → каждый день с решённой ставкой и/или
// выводом → накопительный банк на этот момент. Используется для графика
// "Динамика банка" на странице bank.html. Pending-ставки в кривую не входят
// (у них ещё нет результата). withdrawn — вывод в этот день, отдельно от
// профита по ставкам (это не поражение, а факт того что деньги сняли).
export function computeBankPoints(bets, withdrawals, startingBankroll) {
  const start = Number(startingBankroll || 0);
  const settledSorted = (bets || [])
    .filter(b => b.result !== 'Pending')
    .slice()
    .sort((a, b) => (a.bet_date || '').localeCompare(b.bet_date || '') || (a.id - b.id));
  if (!settledSorted.length) return null;
  const dates = Array.from(new Set([
    ...settledSorted.map(b => b.bet_date),
    ...(withdrawals || []).map(w => w.w_date),
  ])).sort();
  let cum = start;
  const points = [{ label: 'Старт', bank: start, delta: null, withdrawn: 0 }];
  dates.forEach(d => {
    const dayProfit = settledSorted.filter(b => b.bet_date === d).reduce((s, b) => s + (computeProfit(b) || 0), 0);
    const dayWithdrawn = (withdrawals || []).filter(w => w.w_date === d).reduce((s, w) => s + Number(w.amount || 0), 0);
    cum += dayProfit - dayWithdrawn;
    points.push({ label: d, bank: cum, delta: dayProfit, withdrawn: dayWithdrawn });
  });
  return points;
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

// Объединяет ЗАРЕГИСТРИРОВАННЫЕ эджи (таблица edges — можно завести название
// и описание заранее, ещё до первой ставки) со статистикой, посчитанной по
// факту тегирования ставок полем edge_tag. Эдж без единой ставки просто
// получает нулевую карточку (0 ставок, профит $0) — так видно, что он
// заведён и ждёт своих ставок, а не потерян где-то в форме.
export function mergeEdgeGroups(edgeDefs, betGroups) {
  const byKey = new Map(betGroups.map(g => [g.key, g]));
  const seen = new Set();
  const merged = [];
  (edgeDefs || []).forEach(e => {
    const key = (e && e.name || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const existing = byKey.get(key);
    merged.push(existing
      ? { ...existing, description: e.description || '' }
      : { key, list: [], description: e.description || '', ...computeStats([], [], 0) });
  });
  betGroups.forEach(g => {
    if (seen.has(g.key)) return;
    seen.add(g.key);
    merged.push(g);
  });
  return merged.sort((a, b) => b.total - a.total);
}

// ---- Разбивка по месяцу ставки (мини-дашборд "По месяцам") ----
const MONTH_NAMES_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

// "2026-07-15" -> "2026-07" — ключ месяца, используется в URL (?key=2026-07)
// и для сортировки, потому что YYYY-MM сравнивается как строка правильно.
export function monthKeyOf(dateStr) {
  return dateStr ? String(dateStr).slice(0, 7) : null;
}

// "2026-07" (или полная дата) -> "Июль 2026" — человекочитаемая подпись.
export function monthLabelOf(monthKey) {
  if (!monthKey) return '—';
  const [y, m] = String(monthKey).slice(0, 7).split('-');
  return `${MONTH_NAMES_RU[Number(m) - 1] || m} ${y}`;
}

// Как groupBets, но: 1) группирует по месяцу bet_date, 2) сортирует по
// хронологии (свежий месяц сверху), а не по числу ставок — для "по месяцам"
// это понятнее, чем прыгающий порядок по активности, 3) у каждой группы есть
// человекочитаемый label ("Июль 2026") отдельно от key ("2026-07"), который
// остаётся в URL и используется для точного поиска группы.
export function groupBetsByMonth(bets) {
  const groups = groupBets(bets, b => monthKeyOf(b.bet_date));
  groups.forEach(g => { g.label = monthLabelOf(g.key); });
  return groups.sort((a, b) => b.key.localeCompare(a.key));
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
// Сегментация, чтобы не повторять одну и ту же вёрстку таблицы.
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

// ---- Разбивки нового вида (карточки + переход в полную статистику) ----
// Используется на страницах По букмекерам / Рынки / Команды / Найденные эджи.
// Каждая карточка — сущность (букмекер/рынок/команда/эдж) с ключевыми цифрами
// и мини-полоской винрейта; если pageFile задан — карточка кликабельна и
// ведёт на ?key=... той же страницы, где renderBreakdownDetail() покажет
// полную статистику и список ставок именно по этой сущности.
export function renderGroupCards(groups, labelHeader, pageFile) {
  if (!groups.length) {
    return '<div class="empty-state">Пока нет данных для этой разбивки — добавь ставки с этим полем на странице «Ставки».</div>';
  }
  // Полоска под названием отражает ПРОФИТ, не винрейт: зелёная и заполняется
  // тем больше, чем больше плюс, красная и заполняется тем больше, чем
  // больше минус. Заполнение нормировано на максимальный |профит| среди
  // карточек этой же страницы — так самая прибыльная/убыточная сущность
  // получает полную полоску, а остальные видны относительно неё.
  const maxAbsProfit = Math.max(1, ...groups.map(g => Math.abs(g.totalProfit)));
  const cards = groups.map(g => {
    const profitCls = g.totalProfit > 0 ? 'pos-text' : g.totalProfit < 0 ? 'neg-text' : '';
    const barCls = g.totalProfit > 0 ? 'pos' : g.totalProfit < 0 ? 'neg' : 'neu';
    const barPct = Math.min(100, Math.abs(g.totalProfit) / maxAbsProfit * 100);
    const inner = `
      <div class="bd-card-head">
        <div class="bd-card-name">${escapeHtml(g.label || g.key)}</div>
        <div class="bd-card-count">${g.total} ${g.total === 1 ? 'ставка' : 'ставок'}</div>
      </div>
      ${g.description ? `<div class="bd-card-desc">${escapeHtml(g.description)}</div>` : ''}
      <div class="bd-card-bar"><div class="bd-card-bar-fill ${barCls}" style="width:${barPct.toFixed(1)}%;"></div></div>
      <div class="bd-card-stats">
        <div class="bd-card-stat"><span class="bd-card-stat-label">Винрейт</span><span class="bd-card-stat-value">${g.winrate == null ? '—' : g.winrate.toFixed(1) + '%'}</span></div>
        <div class="bd-card-stat"><span class="bd-card-stat-label">ROI</span><span class="bd-card-stat-value ${g.roi > 0 ? 'pos-text' : g.roi < 0 ? 'neg-text' : ''}">${g.roi == null ? '—' : g.roi.toFixed(1) + '%'}</span></div>
        <div class="bd-card-stat"><span class="bd-card-stat-label">Профит</span><span class="bd-card-stat-value ${profitCls}">${fmtMoney(g.totalProfit)}</span></div>
      </div>
      ${pageFile ? '<div class="bd-card-arrow">→</div>' : ''}
    `;
    if (pageFile) {
      // pageFile обычно просто "bookmakers.html", но публичная страница
      // профиля (public.html?u=имя&tab=bookmakers) уже приходит со своей
      // строкой параметров — дописываем через "&", а не всегда через "?".
      const sep = pageFile.includes('?') ? '&' : '?';
      const href = `${pageFile}${sep}key=${encodeURIComponent(g.key)}`;
      return `<a class="bd-card bd-card-link" href="${href}">${inner}</a>`;
    }
    return `<div class="bd-card">${inner}</div>`;
  }).join('');
  return `<div class="bd-grid">${cards}</div>`;
}

// Полная статистика по одной сущности (клик по карточке из renderGroupCards) —
// повторяет вид дашборда (сетка stat-card) + список конкретных ставок ниже.
export function renderBreakdownDetail(labelHeader, keyLabel, group, backHref, hideBookmakerCol) {
  if (!group) {
    return `
      <a class="bd-back" href="${backHref}">← Назад к списку</a>
      <div class="empty-state">Не нашлось данных по «${escapeHtml(keyLabel)}» — возможно, ставки с этим значением были изменены или удалены.</div>`;
  }
  const cards = [
    { label: 'Ставок', value: group.total, sub: group.pending ? `${group.pending} в ожидании` : '' },
    { label: 'W / L / P', value: renderWLP(group.wins, group.losses, group.pushes), sub: '' },
    { label: 'Винрейт', value: group.winrate == null ? '—' : group.winrate.toFixed(1) + '%', sub: (group.wins + group.losses) ? `${group.wins + group.losses} решённых` : '' },
    { label: 'Профит', value: fmtMoney(group.totalProfit), cls: group.totalProfit > 0 ? 'pos' : group.totalProfit < 0 ? 'neg' : '', sub: '' },
    { label: 'ROI', value: group.roi == null ? '—' : group.roi.toFixed(2) + '%', cls: group.roi > 0 ? 'pos' : group.roi < 0 ? 'neg' : '', sub: '' },
    { label: 'Средний кэф', value: group.avgOdds == null ? '—' : group.avgOdds.toFixed(2), sub: '' },
  ];
  const statHtml = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls || ''}">${c.value}</div>
      ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ''}
    </div>
  `).join('');
  return `
    <a class="bd-back" href="${backHref}">← Назад к списку</a>
    <div class="bd-detail-head">
      <div class="bd-detail-label">${labelHeader}</div>
      <h3 class="bd-detail-name">${escapeHtml(keyLabel)}</h3>
      ${group.description ? `<div class="bd-detail-desc">${escapeHtml(group.description)}</div>` : ''}
    </div>
    <div class="stat-grid stat-grid-3">${statHtml}</div>
    ${renderBetsFlatTable(group.list, { hideBookmaker: !!hideBookmakerCol })}
  `;
}

// Плоская таблица ставок (без группировки по месяцам) — используется в
// детальном виде разбивок (renderBreakdownDetail) и может пригодиться где-то
// ещё, где нужен просто список ставок с ключевыми полями. opts.hideBookmaker
// прячет колонку «Букмекер», когда сама разбивка уже идёт по букмекеру
// (там она была бы одинаковой в каждой строке и просто дублировала бы шапку).
// Дата+время в человеческом виде для тултипов с тайм-стемпами (см. ниже) —
// например "07.08.2026, 14:32".
function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// "Сигнал доверия" (не криптографическое доказательство, но ловит основной
// паттерн жульничества капперов — тихо переписать историю ПОСЛЕ того, как
// матч прошёл): settled_at проставляется один раз, в момент первого выхода
// из Pending (см. триггер bets_touch_timestamps в schema_milestone10.sql).
// Если updated_at заметно (>5 сек — запас на саму операцию сохранения)
// позже settled_at, значит строку трогали ЕЩЁ раз уже после того, как
// исход был известен.
function wasEditedAfterSettle(b) {
  if (!b.settled_at || !b.updated_at) return false;
  return new Date(b.updated_at).getTime() - new Date(b.settled_at).getTime() > 5000;
}

export function renderBetsFlatTable(bets, opts) {
  if (!bets || !bets.length) {
    return '<div class="empty-state">Ставок не найдено.</div>';
  }
  const hideBookmaker = !!(opts && opts.hideBookmaker);
  const sorted = bets.slice().sort((a, b) => (b.bet_date || '').localeCompare(a.bet_date || '') || (b.id - a.id));
  const rows = sorted.map(b => {
    const profit = computeProfit(b);
    const profitCls = profit == null ? '' : profit > 0 ? 'pos-text' : profit < 0 ? 'neg-text' : '';
    const title = b.match || b.pick || '—';
    const addedTitle = b.created_at ? `Добавлено в систему: ${fmtDateTime(b.created_at)}` : '';
    const edited = wasEditedAfterSettle(b);
    const editedBadge = edited
      ? `<span class="edited-badge" title="Расcчитана: ${fmtDateTime(b.settled_at)} · последняя правка: ${fmtDateTime(b.updated_at)} — запись меняли уже после того, как исход стал известен">✎ изменено</span>`
      : '';
    return `
      <tr>
        <td class="num" title="${escapeHtml(addedTitle)}">${b.bet_date ? b.bet_date.split('-').reverse().join('.') : '—'}</td>
        <td>${escapeHtml(title)}</td>
        <td>${escapeHtml(b.discipline || '—')}</td>
        ${hideBookmaker ? '' : `<td>${escapeHtml(b.bookmaker || '—')}</td>`}
        <td class="num">${b.odds != null ? Number(b.odds).toFixed(2) : '—'}</td>
        <td><span class="res-pill ${{ Win: 'win', Loss: 'loss', Push: 'push', Pending: 'pending', Sold: 'sold' }[b.result] || 'pending'}">${escapeHtml(b.result)}</span>${editedBadge}</td>
        <td class="num ${profitCls}">${profit == null ? '—' : fmtMoney(profit)}</td>
      </tr>`;
  }).join('');
  return `
    <div class="table-wrap" style="margin-top:22px;">
      <div class="table-scroll">
        <table class="bets-table">
          <thead><tr><th>Дата</th><th>Матч / Пик</th><th>Дисциплина</th>${hideBookmaker ? '' : '<th>Букмекер</th>'}<th>Кэф</th><th>Результат</th><th>Профит</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ---- Текущая серия (streak) для дашборда ----
// Берёт последние n РЕШЁННЫХ ставок (по дате, затем по id — свежие последние),
// классифицирует каждую по фактическому профиту (не по полю result напрямую,
// чтобы Sold с отрицательным manual_profit тоже считался поражением, а не
// нейтральной ставкой) и считает текущую серию с конца списка. Push
// (профит 0) прерывает серию — это осознанно простая трактовка.
export function computeStreak(bets, n = 10) {
  const settled = (bets || [])
    .filter(b => b.result !== 'Pending')
    .slice()
    .sort((a, b) => (a.bet_date || '').localeCompare(b.bet_date || '') || (a.id - b.id));
  const recent = settled.slice(-n).map(b => {
    const p = computeProfit(b);
    const outcome = p > 0 ? 'W' : p < 0 ? 'L' : 'P';
    return { bet: b, outcome };
  });
  let streakType = null, streakLen = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const o = recent[i].outcome;
    if (o === 'P') break;
    if (streakType === null) { streakType = o; streakLen = 1; }
    else if (o === streakType) streakLen++;
    else break;
  }
  return { recent, streakType, streakLen, sampleSize: recent.length };
}

// ---- CLV Tracker — отдельный, независимый от "bets" журнал ----
// CLV% = (входной кэф / кэф закрытия − 1) × 100 — стандартная формула
// closing line value: положительная, если ты поймал кэф лучше, чем итоговая
// линия закрытия рынка.
export function computeClv(entryOdds, closingOdds) {
  if (entryOdds == null || closingOdds == null || !closingOdds) return null;
  return (Number(entryOdds) / Number(closingOdds) - 1) * 100;
}

// Профит от полного хеджа — классическая формула трейдера/арбитражника.
// На противоположную сторону ставится сумма hedgeStake = stake × entryOdds /
// hedgeOdds — она уравнивает выплату независимо от исхода, поэтому
// гарантированный профит НЕ зависит от того, кто выиграет:
//   profit = stake × entryOdds − stake − hedgeStake
// Если 1/entryOdds + 1/hedgeOdds ⩾ 1 — реальной вилки нет, профит выйдет
// нулевым или отрицательным, и это тоже честный, ожидаемый результат
// формулы (не ошибка), просто хедж в моменте оказался невыгодным.
export function computeHedgeProfit(entryOdds, hedgeOdds, stake) {
  if (entryOdds == null || hedgeOdds == null || stake == null) return null;
  const S = Number(stake), O1 = Number(entryOdds), O2 = Number(hedgeOdds);
  if (!O2) return null;
  const hedgeStake = S * O1 / O2;
  return S * O1 - S - hedgeStake;
}

// Профит по одной CLV-записи. В отличие от обычного журнала ставок, здесь
// НЕТ исхода Win/Loss по формуле "кэф × сумма" — записи в CLV Tracker это
// пойманные эджи, которые закрываются одним из двух способов:
//   • Hedged (захеджирована) — профит считается АВТОМАТИЧЕСКИ по формуле
//     computeHedgeProfit() из кэфов входа/хеджа и суммы ставки;
//   • Sold (продана/кэшаут) — сумма кэшаута определяется букмекером, а не
//     формулой, поэтому вводится вручную (manual_profit).
export function computeClvProfit(entry) {
  if (entry.result === 'Hedged') {
    return computeHedgeProfit(entry.entry_odds, entry.hedge_odds, entry.stake);
  }
  if (entry.result === 'Sold') {
    return entry.manual_profit != null ? Number(entry.manual_profit) : 0;
  }
  return null; // Pending — исход ещё не зафиксирован
}

// Сводная статистика для верхних плашек CLV Tracker.
export function computeClvStats(entries) {
  const list = entries || [];
  const closed = list.filter(e => e.result !== 'Pending');
  const pending = list.filter(e => e.result === 'Pending');
  const inPlay = pending.reduce((s, e) => s + Number(e.stake || 0), 0);
  const totalProfit = closed.reduce((s, e) => s + (computeClvProfit(e) || 0), 0);
  const totalStaked = closed.reduce((s, e) => s + Number(e.stake || 0), 0);
  const roi = totalStaked ? (totalProfit / totalStaked * 100) : null;
  const withClv = list.filter(e => e.closing_odds != null);
  const avgClv = withClv.length
    ? withClv.reduce((s, e) => s + (computeClv(e.entry_odds, e.closing_odds) || 0), 0) / withClv.length
    : null;
  return { total: list.length, inPlay, totalProfit, roi, avgClv };
}
