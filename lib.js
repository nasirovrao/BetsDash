// Общая логика подсчёта статистики — используется на Дашборде и странице
// "Выводы и банк", чтобы не дублировать формулы в двух файлах.

// 02.09.2026: "Валюта отображения" — личная настройка каждого пользователя
// (profiles.display_currency, schema_milestone30.sql), НЕ то, как данные
// хранятся (bets.stake и т.п. всегда доллары для всех) — только то, КАК
// число показывается КОНКРЕТНОМУ зрителю. currency/rate необязательны
// (по умолчанию USD, rate=1) — старый код, вызывающий fmtMoney(n) одним
// аргументом, продолжает работать ровно как раньше, ничего не ломается.
export const CURRENCY_SYMBOLS = { USD: '$', RUB: '₽', EUR: '€', KZT: '₸', UAH: '₴' };

export function fmtMoney(n, currency = 'USD', rate = 1) {
  const converted = n * rate;
  const symbol = CURRENCY_SYMBOLS[currency] || '$';
  const sign = converted < 0 ? '−' : '';
  return sign + symbol + Math.abs(converted).toFixed(2).replace(/\.00$/, '');
}

// Достаёт личную валюту отображения текущего пользователя и, если она не
// доллар, актуальный курс USD→эта_валюта (open.er-api.com, публичный, без
// ключа). Результат кэшируется в памяти модуля на время жизни вкладки —
// эта функция вызывается почти на каждой странице с деньгами, незачем
// дёргать и profiles, и курс заново при каждом вызове. userId может быть
// null (например анонимный зритель feed.html/public.html) — тогда просто
// USD без похода в сеть.
let _displayCurrencyCache = null;
export async function getDisplayCurrency(supabase, userId) {
  if (_displayCurrencyCache) return _displayCurrencyCache;
  let currency = 'USD';
  if (userId) {
    try {
      const { data } = await supabase.from('profiles').select('display_currency').eq('user_id', userId).maybeSingle();
      if (data && data.display_currency) currency = data.display_currency;
    } catch (e) {
      console.warn('getDisplayCurrency: не удалось прочитать profiles.display_currency', e && e.message);
    }
  }
  let rate = 1;
  if (currency !== 'USD') {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      const json = await res.json();
      if (json && json.rates && typeof json.rates[currency] === 'number') rate = json.rates[currency];
    } catch (e) {
      console.warn('getDisplayCurrency: не удалось получить курс, показываю как доллары', e && e.message);
      currency = 'USD'; // не смогли сконвертировать — честнее показать доллары, чем соврать курсом 1:1 под чужим значком
    }
  }
  _displayCurrencyCache = { currency, rate };
  return _displayCurrencyCache;
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

// Профит по одной ставке в ФЛЕТАХ (не в $) — та же формула, что computeProfit,
// только вместо bet.stake считает от bet.flat_mult (сколько флетов было
// поставлено). Смысл отдельно от $-профита: флет — единица ставки, заданная
// не в деньгах, а "во сколько раз больше/меньше обычной ставки" — она не
// плывёт вместе с ростом банка (проставил 10 лет по 1-2 флета — сумма в $ за
// это время могла вырасти в разы просто потому, что банк вырос, а "доходность
// по флетам" всё равно сравнивает похожее с похожим). Продана/закрыта
// досрочно (Sold) — manual_profit введён в $, конвертируем в флеты через
// фактическую "цену одного флета" именно в ЭТОЙ ставке (stake/flat_mult), а
// не через текущий default_flat_size — тот мог с тех пор измениться.
export function computeProfitInFlats(bet) {
  const flat = Number(bet.flat_mult);
  if (!flat) return null;
  if (bet.result === 'Win') return flat * (Number(bet.odds) - 1);
  if (bet.result === 'Loss') return -flat;
  if (bet.result === 'Push') return 0;
  if (bet.result === 'Sold') {
    if (bet.manual_profit == null) return 0;
    const stake = Number(bet.stake);
    if (!stake) return null;
    return Number(bet.manual_profit) * flat / stake;
  }
  return null;
}

// Доходность по флетам — тот же ROI, что computeStats().roi, только знаменатель
// и профит считаются в флетах, а не в $ (см. комментарий у computeProfitInFlats
// выше). flatsProfit — суммарный профит в флетах (например "+14.2 флета"),
// flatRoi — он же в процентах от суммарно поставленных флетов.
export function computeFlatStats(bets) {
  const settled = (bets || []).filter(b => b.result !== 'Pending' && b.flat_mult);
  const flatsStaked = settled
    .filter(b => b.result !== 'Push')
    .reduce((s, b) => s + Number(b.flat_mult || 0), 0);
  const flatsProfit = settled.reduce((s, b) => s + (computeProfitInFlats(b) || 0), 0);
  const flatRoi = flatsStaked ? (flatsProfit / flatsStaked * 100) : null;
  return { flatsStaked, flatsProfit, flatRoi };
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

// Milestone 24: то же самое, что monthKeyOf/monthLabelOf выше, но для дня и
// недели — добавлено по просьбе, чтобы на дашборде можно было смотреть
// стату не только за месяц. Родительный падеж месяца отдельно от
// MONTH_NAMES_RU (там именительный — "Август", тут "30 августа").
const MONTH_NAMES_RU_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTH_NAMES_RU_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

// "2026-08-30" -> "2026-08-30" — bet_date уже хранится в этом формате,
// функция здесь просто для симметрии с monthKeyOf/weekKeyOf (единый
// интерфейс {keyOf, labelOf} для всех трёх гранулярностей на дашборде).
export function dayKeyOf(dateStr) {
  return dateStr ? String(dateStr).slice(0, 10) : null;
}

// "2026-08-30" -> "30 августа 2026"
export function dayLabelOf(dayKey) {
  if (!dayKey) return '—';
  const [y, m, d] = String(dayKey).slice(0, 10).split('-');
  return `${Number(d)} ${MONTH_NAMES_RU_GEN[Number(m) - 1] || m} ${y}`;
}

// Понедельник ISO-недели (год, номер недели) — стандартный алгоритм через
// четверг этой недели (ISO 8601: неделя 1 — та, что содержит первый четверг
// года / 4 января).
function mondayOfISOWeek(year, week) {
  const jan4 = new Date(year, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7; // Пн=0 ... Вс=6
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - jan4Day);
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (week - 1) * 7);
  return monday;
}

// "2026-08-30" -> "2026-W35" — ISO-номер недели (Пн—Вс), тот же принцип,
// что monthKeyOf: строковый ключ, по которому удобно и сравнивать/
// сортировать, и хранить в value у <option>.
export function weekKeyOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const dayNr = (d.getDay() + 6) % 7; // Пн=0
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - dayNr + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
  const firstThursdayOfWeek1 = new Date(firstThursday);
  firstThursdayOfWeek1.setDate(firstThursday.getDate() - firstThursdayDay + 3);
  const week = 1 + Math.round((thursday - firstThursdayOfWeek1) / (7 * 24 * 3600 * 1000));
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// "2026-W35" -> "25–31 авг" (или "29 авг – 4 сен", если неделя переходит
// через месяц) — диапазон Пн—Вс понятнее голого номера недели.
export function weekLabelOf(weekKey) {
  if (!weekKey) return '—';
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(weekKey));
  if (!m) return String(weekKey);
  const monday = mondayOfISOWeek(Number(m[1]), Number(m[2]));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  if (monday.getMonth() === sunday.getMonth()) {
    return `${monday.getDate()}–${sunday.getDate()} ${MONTH_NAMES_RU_SHORT[monday.getMonth()]}`;
  }
  return `${monday.getDate()} ${MONTH_NAMES_RU_SHORT[monday.getMonth()]} – ${sunday.getDate()} ${MONTH_NAMES_RU_SHORT[sunday.getMonth()]}`;
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
  if (p.includes('фора') || p.includes('handicap') || p.includes('гандикап')) return 'Фора / гандикап';
  if (p.includes('тотал') || p.includes(' ou') || p.includes('total')) return 'Тотал (килы)';
  if (p.includes('продолжительност')) return 'Продолжительность карты';
  if (p.includes('первые 10') || p.includes('first to reach') || p.includes('kill') || p.includes('первую кровь') || p.includes('first blood')) return 'Гонка до N-го килла';
  if (p.includes('башн') || p.includes('tower')) return 'Разрушение построек';
  if (p.includes('победитель') || p.includes('1x2') || p.includes('исход') || p.includes('результат матча') || p.includes('ничья') || /(^|\s)п[12](\s|:|$)/.test(p)) return 'Победитель (матч⁠/⁠карта)';
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
export function renderGroupCards(groups, labelHeader, pageFile, currency, rate) {
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
        <div class="bd-card-stat"><span class="bd-card-stat-label">Профит</span><span class="bd-card-stat-value ${profitCls}">${fmtMoney(g.totalProfit, currency, rate)}</span></div>
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
export function renderBreakdownDetail(labelHeader, keyLabel, group, backHref, hideBookmakerCol, currency, rate) {
  if (!group) {
    return `
      <a class="bd-back" href="${backHref}">← Назад к списку</a>
      <div class="empty-state">Не нашлось данных по «${escapeHtml(keyLabel)}» — возможно, ставки с этим значением были изменены или удалены.</div>`;
  }
  const cards = [
    { label: 'Ставок', value: group.total, sub: group.pending ? `${group.pending} в ожидании` : '' },
    { label: 'W / L / P', value: renderWLP(group.wins, group.losses, group.pushes), sub: '' },
    { label: 'Винрейт', value: group.winrate == null ? '—' : group.winrate.toFixed(1) + '%', sub: (group.wins + group.losses) ? `${group.wins + group.losses} решённых` : '' },
    { label: 'Профит', value: fmtMoney(group.totalProfit, currency, rate), cls: group.totalProfit > 0 ? 'pos' : group.totalProfit < 0 ? 'neg' : '', sub: '' },
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
    ${renderBetsFlatTable(group.list, { hideBookmaker: !!hideBookmakerCol, currency, rate })}
  `;
}

// Плоская таблица ставок (без группировки по месяцам) — используется в
// детальном виде разбивок (renderBreakdownDetail) и может пригодиться где-то
// ещё, где нужен просто список ставок с ключевыми полями. opts.hideBookmaker
// прячет колонку «Букмекер», когда сама разбивка уже идёт по букмекеру
// (там она была бы одинаковой в каждой строке и просто дублировала бы шапку).
// Дата+время в человеческом виде для тултипов с тайм-стемпами (см. ниже) —
// например "07.08.2026, 14:32".
export function fmtDateTime(iso) {
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
// 01.09.2026: экспортирована (была локальной) — нужна не только
// renderBetsFlatTable(), но и dashboard.html/public.html для честного
// счётчика "N изменений после исхода видны" (не выдуманная цифра, тот же
// самый признак, что уже красит бейдж "✎ изменено" на карточках ставок).
export function wasEditedAfterSettle(b) {
  if (!b.settled_at || !b.updated_at) return false;
  return new Date(b.updated_at).getTime() - new Date(b.settled_at).getTime() > 5000;
}

export function renderBetsFlatTable(bets, opts) {
  if (!bets || !bets.length) {
    return '<div class="empty-state">Ставок не найдено.</div>';
  }
  const hideBookmaker = !!(opts && opts.hideBookmaker);
  const dispCurrency = (opts && opts.currency) || 'USD';
  const dispRate = (opts && opts.rate) || 1;
  const sorted = bets.slice().sort((a, b) => (b.bet_date || '').localeCompare(a.bet_date || '') || (b.id - a.id));
  const rows = sorted.map(b => {
    const profit = computeProfit(b);
    const profitCls = profit == null ? '' : profit > 0 ? 'pos-text' : profit < 0 ? 'neg-text' : '';
    // Раньше здесь показывался ТОЛЬКО матч (или, если его не было, только
    // пик) — колонка называется "Матч / Пик", но реальный пик (на что
    // именно ставили) не попадал в таблицу вовсе, если матч был указан.
    // Теперь показываем оба: матч — основной строкой, пик — приглушённой
    // строкой под ним (как на карточках ставок в app.html), и только если
    // они реально разные значения — не дублируем одно и то же дважды.
    const matchTitle = b.match || '';
    const pickTitle = b.pick || '';
    const titleHtml = matchTitle
      ? `${escapeHtml(matchTitle)}${pickTitle && pickTitle !== matchTitle ? `<div class="bd-table-sub">${escapeHtml(pickTitle)}</div>` : ''}`
      : escapeHtml(pickTitle || '—');
    const addedTitle = b.created_at ? `Добавлено в систему: ${fmtDateTime(b.created_at)}` : '';
    const edited = wasEditedAfterSettle(b);
    // Бейдж в таблице остаётся коротким (не ломает вёрстку на мобильном),
    // а тултип теперь ведёт с КОНКРЕТИКОЙ — что именно поменяли (edit_note
    // из триггера, milestone11), например "пик: П1 → П2" — а не только с
    // датами, как раньше. Даты остаются вторым планом, в скобках.
    const editedTitle = edited
      ? (b.edit_note
          ? `${b.edit_note} (после исхода: ${fmtDateTime(b.settled_at)} → ${fmtDateTime(b.updated_at)})`
          : `Изменено после того, как исход стал известен: ${fmtDateTime(b.settled_at)} → ${fmtDateTime(b.updated_at)}`)
      : '';
    const editedBadge = edited
      ? `<span class="edited-badge" title="${escapeHtml(editedTitle)}">✎ изменено</span>`
      : '';
    return `
      <tr>
        <td class="num" title="${escapeHtml(addedTitle)}">${b.bet_date ? b.bet_date.split('-').reverse().join('.') : '—'}</td>
        <td>${titleHtml}</td>
        <td>${escapeHtml(b.discipline || '—')}</td>
        ${hideBookmaker ? '' : `<td>${escapeHtml(b.bookmaker || '—')}</td>`}
        <td class="num">${b.odds != null ? Number(b.odds).toFixed(2) : '—'}</td>
        <td><span class="res-pill ${{ Win: 'win', Loss: 'loss', Push: 'push', Pending: 'pending', Sold: 'sold' }[b.result] || 'pending'}">${escapeHtml(b.result)}</span>${editedBadge}</td>
        <td class="num ${profitCls}">${profit == null ? '—' : fmtMoney(profit, dispCurrency, dispRate)}</td>
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

// ============================================================
// Мульти-канал / совместное редактирование — Milestone 12.
//
// Раньше переключатель канала жил только на app.html, хардкодом на 2
// варианта ("default"/"cybervalue"), и переход на любую другую приватную
// страницу тут же сбрасывал контекст обратно на "default" — статистика
// не-default канала была не видна нигде, кроме самой ленты ставок.
// Ниже — общий механизм: канал+владелец читаются из URL, сохраняются на
// всех внутренних ссылках, а список каналов для переключателя собирается
// динамически (свои каналы + каналы, куда тебя одобрили редактором),
// а не хардкодится.
// ============================================================

// ?channel= — какой канал показываем. ?owner= — user_id владельца, ЗАДАЁТСЯ
// только когда смотришь канал, которым сам не владеешь (тебе дали доступ
// редактора) — для своих каналов владелец всегда просто "я".
export function getChannelParams() {
  const p = new URLSearchParams(location.search);
  return { channel: p.get('channel') || 'default', owner: p.get('owner') || null };
}

// Список каналов, которые пользователь может выбрать в переключателе:
//   - "default" — всегда, это личный дневник;
//   - любой другой канал, где у пользователя есть СВОИ ставки (он владелец);
//   - каналы, куда его одобрили редактором (channel_members, status=approved).
export async function loadMyChannels(supabase, myUserId) {
  const [{ data: ownBets }, { data: memberRows }, { data: myProfile }] = await Promise.all([
    supabase.from('bets').select('channel').eq('user_id', myUserId),
    supabase.from('channel_members').select('owner_user_id, channel, channel_label, status').eq('member_user_id', myUserId).eq('status', 'approved'),
    supabase.from('profiles').select('channel, display_name, username').eq('user_id', myUserId).maybeSingle(),
  ]);
  const ownChannelSet = new Set((ownBets || []).map(b => b.channel || 'default'));
  ownChannelSet.add('default');
  // Свой публичный канал должен быть в переключателе, даже если в нём ещё
  // НЕТ ни одной ставки — иначе только что настроенный публичный профиль
  // (или канал, в который просто ещё не успел ничего добавить) был бы
  // не виден и не выбираем в UI никак, кроме как руками вбить ?channel=
  // в адресную строку. Раньше (до динамического списка) оба канала были
  // жёстко зашиты по умолчанию — это восстанавливает то же ощущение.
  if (myProfile && myProfile.channel) ownChannelSet.add(myProfile.channel);
  const own = Array.from(ownChannelSet).map(ch => ({
    channel: ch,
    ownerUserId: myUserId,
    label: ch === 'default' ? 'Личный дневник' : (myProfile && myProfile.channel === ch ? (myProfile.display_name || myProfile.username || ch) : ch),
    role: 'owner',
  }));
  const shared = (memberRows || []).map(r => ({
    channel: r.channel, ownerUserId: r.owner_user_id, label: r.channel_label || r.channel, role: 'editor',
  }));
  return [...own, ...shared];
}

// Рендерит пилюли переключателя каналов. Ничего не рисует, если у
// пользователя ровно один канал (личный дневник) — переключать нечего.
export function renderChannelSwitch(channels, activeChannel, activeOwnerId, pageFile) {
  if (!channels || channels.length <= 1) return '';
  const pills = channels.map(c => {
    const isActive = c.channel === activeChannel && c.ownerUserId === activeOwnerId;
    const params = new URLSearchParams();
    if (c.channel !== 'default') params.set('channel', c.channel);
    if (c.role === 'editor') params.set('owner', c.ownerUserId);
    const qs = params.toString();
    const href = `${pageFile}${qs ? '?' + qs : ''}`;
    const roleTag = c.role === 'editor' ? ' <span style="opacity:.6;font-weight:400;">· редактор</span>' : '';
    return `<a class="channel-pill${isActive ? ' active' : ''}" href="${href}">${escapeHtml(c.label)}${roleTag}</a>`;
  }).join('');
  return `<div class="channel-switch">${pills}</div>`;
}

// Дописывает ?channel=&owner= ко всем ссылкам топбара/нав-бара на текущей
// странице, чтобы контекст канала не терялся при переходе на другую
// вкладку (Дашборд → Букмекеры и т.д. остаются в том же канале).
export function preserveChannelInNav(channel, ownerUserId, myUserId) {
  const isDefaultOwn = channel === 'default' && (!ownerUserId || ownerUserId === myUserId);
  if (isDefaultOwn) return;
  const params = new URLSearchParams();
  if (channel !== 'default') params.set('channel', channel);
  if (ownerUserId && ownerUserId !== myUserId) params.set('owner', ownerUserId);
  const suffix = '?' + params.toString();
  if (suffix === '?') return;
  // #statsDropdownPanel — явно по id, а не через .app-nav a.nav-pill: с
  // Milestone 25 разбивки (По дисциплинам и т.д.) переехали из плоских
  // .nav-pill внутри .app-nav в .nav-dropdown-item внутри этой панели,
  // которая к тому же может быть уже перенесена в <body> (initNavDropdown,
  // "портал" от обрезки overflow) — id её не меняется, поэтому селектор по
  // id работает независимо от того, успел ли этот перенос уже произойти.
  // #settingsDropdownPanel (Публичный профиль / Доступ к каналу) сюда
  // сознательно НЕ входит — это не канало-зависимые страницы-разбивки, а
  // страницы аккаунта/настроек, они и раньше (topbar-link) не получали
  // channel/owner в ссылке.
  document.querySelectorAll('.app-nav a.nav-pill[href], #statsDropdownPanel a.nav-dropdown-item[href], a.brand[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.includes('?')) return;
    a.setAttribute('href', href + suffix);
  });
}

// Строит "pageFile" со ?channel=&owner= для страниц-разбивок (bookmakers.html,
// disciplines.html и т.д.) — передаётся в renderGroupCards/renderBreakdownDetail
// вместо голого имени файла, чтобы клик по карточке ("→ детали") и кнопка
// "← Назад к списку" не теряли текущий канал/владельца, как это уже сделано
// для нав-бара в preserveChannelInNav().
export function channelHref(pageFile, channel, ownerUserId, myUserId) {
  const params = new URLSearchParams();
  if (channel !== 'default') params.set('channel', channel);
  if (ownerUserId && ownerUserId !== myUserId) params.set('owner', ownerUserId);
  const qs = params.toString();
  return qs ? `${pageFile}?${qs}` : pageFile;
}

// ---- Скрываемая почта в шапке — клик по почте прячет её за точками
// (например, перед демонстрацией экрана), повторный клик показывает снова.
// Состояние в localStorage (не sessionStorage!) — сознательно: это чистая
// UI-привычка человека, а не секрет и не серверные данные, поэтому логично,
// чтобы выбор "прячу почту" сохранялся и переживал закрытие вкладки, как и
// любая другая настройка интерфейса.
const EMAIL_HIDE_KEY = 'edge_hide_email';
export function initEmailPrivacyToggle(email) {
  const el = document.getElementById('userEmail');
  if (!el || !email) return;
  el.classList.add('email-toggle');
  el.title = 'Нажми, чтобы скрыть/показать почту';
  function isHidden() {
    try { return localStorage.getItem(EMAIL_HIDE_KEY) === '1'; } catch { return false; }
  }
  function render() {
    el.textContent = isHidden() ? '••••••••' : email;
  }
  el.addEventListener('click', () => {
    try { localStorage.setItem(EMAIL_HIDE_KEY, isHidden() ? '0' : '1'); } catch { /* приватный режим — просто не сохранится между сессиями */ }
    render();
  });
  render();
}

// ---- Приватный нав-бар: выпадающие пункты-группы ("Детальная статистика"
// сворачивает 5 вкладок-разбивок; "Настройки" — "Публичный профиль" +
// "Доступ к каналу", раньше отдельными ссылками висели в topbar, а не в
// основном нав-баре). Общая функция вместо копии на каждый дропдаун и на
// каждую из 13 приватных страниц — принимает id обёртки (`#<id>`), кнопки
// (`#<id>Btn`) и панели (`#<id>Panel`), больше ничего знать о конкретном
// дропдауне не должна. Логика открытия/закрытия — тот же паттерн, что уже
// используется для дропдауна ролей в profile-settings.html (клик по кнопке
// / клик снаружи / Escape).
// Реестр функций close() всех инициализированных на странице дропдаунов —
// нужен, чтобы открытие одного (например «Настройки») закрывало другой уже
// открытый (например «Детальная статистика»), а не оставляло оба висеть
// одновременно поверх страницы. Раньше на странице был максимум один такой
// дропдаун, коллизия появилась только с Milestone 26 (второй дропдаун).
const _navDropdownCloseFns = [];

// "Личные настройки" (personal-settings.html, schema_milestone26.sql) — три
// галочки на аккаунте (profiles.nav_diary/nav_channel/nav_reader), которыми
// человек прячет неиспользуемые разделы нав-бара. НЕ модель доступа — это
// чистая косметика видимости меню, ничего не блокирует и не редиректит:
// прямая ссылка на "скрытый" раздел продолжает открываться как раньше.
// Классы на <body> + !important-правила в styles-edge3.css (а не прямой
// style.display здесь) — см. комментарий там про гонку с isClvEnabled().
export async function applyNavModes(supabase, userId) {
  if (!userId) return;
  let profile = null;
  try {
    const { data } = await supabase.from('profiles').select('nav_diary, nav_channel, nav_reader').eq('user_id', userId).maybeSingle();
    profile = data || null;
  } catch { /* таблица/колонки недоступны (миграция ещё не прогнана) — ничего не прячем */ }
  // Явно === false, не просто falsy — undefined (нет строки/колонки ещё)
  // должно значить "показывать", тот же дефолт, что и в схеме (default true).
  document.body.classList.toggle('hide-diary-nav', !!(profile && profile.nav_diary === false));
  document.body.classList.toggle('hide-channel-nav', !!(profile && profile.nav_channel === false));
  document.body.classList.toggle('hide-reader-nav', !!(profile && profile.nav_reader === false));
}

export function initNavDropdown(id) {
  const wrap = document.getElementById(id);
  const btn = document.getElementById(`${id}Btn`);
  const panel = document.getElementById(`${id}Panel`);
  if (!wrap || !btn || !panel) return;

  // Панель переносится прямо в <body> (а не остаётся ребёнком .app-nav .wrap)
  // и позиционируется через position:fixed по координатам кнопки — иначе
  // её обрезает overflow горизонтального скролла нав-бара (детали и разбор
  // — в комментарии у .nav-dropdown-panel, styles-edge3.css). Раз уж панель
  // больше не в поддереве .wrap, closeOnOutsideClick должен явно учитывать
  // и её саму, не только обёртку .nav-dropdown.
  document.body.appendChild(panel);

  function place() {
    const r = btn.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 172;
    const left = Math.min(r.left, window.innerWidth - panelWidth - 8);
    panel.style.top = `${r.bottom + 8}px`;
    panel.style.left = `${Math.max(8, left)}px`;
  }
  function close() {
    panel.hidden = true;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  _navDropdownCloseFns.push(close);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    if (willOpen) {
      // закрыть все остальные открытые дропдауны нав-бара перед открытием этого
      for (const otherClose of _navDropdownCloseFns) {
        if (otherClose !== close) otherClose();
      }
      place();
    }
    panel.hidden = !willOpen;
    wrap.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus(); } });
  // Нав-бар не sticky — при скролле кнопка уходит из-под уже
  // спозиционированной панели. Проще закрыть, чем гонять place() на каждый
  // scroll/resize ради панели с 5 пунктами.
  window.addEventListener('scroll', () => { if (!panel.hidden) close(); }, { passive: true });
  window.addEventListener('resize', () => { if (!panel.hidden) close(); });
}

// ---- Мини-диаграммы при наведении на карточки дашборда (Milestone 14) ----

function chronoSettled(bets) {
  return (bets || [])
    .filter(b => b.result !== 'Pending')
    .slice()
    .sort((a, b) => (a.bet_date || '').localeCompare(b.bet_date || '') || (a.id - b.id));
}

// Числовой ряд для линии-спарклайна одной карточки дашборда — считается на
// том же (уже отфильтрованном по турниру/месяцу) списке ставок, что и сама
// карточка, чтобы поповер не расходился с цифрой под курсором.
export function computeCardTrend(key, bets, withdrawals, startingBankroll) {
  if (key === 'total') {
    // Кумулятивное число ставок по мере их появления — по ВСЕМ ставкам
    // (включая Pending), не только решённым.
    const sorted = (bets || []).slice().sort((a, b) => (a.bet_date || '').localeCompare(b.bet_date || '') || (a.id - b.id));
    return sorted.map((_, i) => i + 1);
  }
  const settled = chronoSettled(bets);
  if (key === 'profit') {
    let acc = 0;
    return settled.map(b => (acc += computeProfit(b) || 0));
  }
  if (key === 'roi') {
    let accProfit = 0, accStake = 0;
    return settled.map(b => {
      accProfit += computeProfit(b) || 0;
      if (b.result !== 'Push') accStake += Number(b.stake) || 0;
      return accStake ? (accProfit / accStake) * 100 : 0;
    });
  }
  if (key === 'winrate') {
    let w = 0, decided = 0;
    return settled.filter(b => b.result === 'Win' || b.result === 'Loss').map(b => {
      decided++;
      if (b.result === 'Win') w++;
      return (w / decided) * 100;
    });
  }
  if (key === 'flatRoi') {
    let accProfit = 0, accFlats = 0;
    return settled.filter(b => b.flat_mult).map(b => {
      accProfit += computeProfitInFlats(b) || 0;
      if (b.result !== 'Push') accFlats += Number(b.flat_mult) || 0;
      return accFlats ? (accProfit / accFlats) * 100 : 0;
    });
  }
  // Кумулятивный профит в флетах (не в %, не в $) — тот же принцип, что и
  // 'profit' выше, только в единицах "флет" вместо доллара. Используется
  // карточкой "Профит по флетам" на дашборде, которая показывает сырое
  // количество флетов, а не доходность в процентах.
  if (key === 'flatsProfit') {
    let acc = 0;
    return settled.filter(b => b.flat_mult).map(b => (acc += computeProfitInFlats(b) || 0));
  }
  if (key === 'bank' || key === 'growth') {
    const points = computeBankPoints(bets, withdrawals, startingBankroll);
    if (!points) return [];
    const start = Number(startingBankroll || 0);
    return points.map(p => key === 'bank' ? p.bank : (start ? ((p.bank - start) / start) * 100 : 0));
  }
  return [];
}

// Топ-N ставок по профиту — для карточки "Средний кэф", вместо линии тренда
// (там уместнее показать "вот твои лучшие заходы", а не динамику кэфа).
export function computeTopBets(bets, n) {
  return (bets || [])
    .map(b => ({ b, profit: computeProfit(b) }))
    .filter(x => x.profit != null)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, n || 3);
}

// Маленькая линия-спарклайн без осей/подписей — только форма тренда. Цвет
// определяется через CSS-класс (pos/neg/neu) и currentColor, а не жёстко
// заданным stroke — так же, как и в остальном приложении (см. bd-card-bar).
export function renderSparkline(points) {
  if (!points || points.length < 2) {
    return '<div class="spark-empty">Пока мало данных</div>';
  }
  const W = 180, H = 48, pad = 3;
  const min = Math.min(...points), max = Math.max(...points);
  const range = (max - min) || 1;
  const stepX = (W - pad * 2) / (points.length - 1);
  const xy = points.map((v, i) => [pad + i * stepX, H - pad - ((v - min) / range) * (H - pad * 2)]);
  const linePath = xy.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${xy[xy.length - 1][0].toFixed(1)},${(H - pad).toFixed(1)} L ${xy[0][0].toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const trendCls = points[points.length - 1] > points[0] ? 'pos' : points[points.length - 1] < points[0] ? 'neg' : 'neu';
  return `
    <svg class="stat-spark ${trendCls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path class="stat-spark-area" d="${areaPath}"></path>
      <path class="stat-spark-line" d="${linePath}"></path>
    </svg>`;
}

// Мини-диаграмма W/L/P — состав, а не временной ряд, поэтому три полоски-
// пропорции вместо линии.
export function renderWlpBars(wins, losses, pushes) {
  const total = Math.max(1, wins + losses + pushes);
  const seg = (n, cls, label) => n
    ? `<div class="spark-wlp-row"><span class="spark-wlp-label">${label}</span><div class="spark-wlp-track"><div class="spark-wlp-fill ${cls}" style="width:${(n / total * 100).toFixed(1)}%;"></div></div><span class="spark-wlp-num">${n}</span></div>`
    : '';
  const html = seg(wins, 'w', 'W') + seg(losses, 'l', 'L') + seg(pushes, 'p', 'P');
  return html ? `<div class="spark-wlp">${html}</div>` : '<div class="spark-empty">Пока мало данных</div>';
}

// Короткий список лучших по профиту ставок — попап для карточки "Средний кэф".
export function renderTopBetsPop(bets, n, currency, rate) {
  const top = computeTopBets(bets, n || 3);
  if (!top.length) return '<div class="spark-empty">Пока нет сыгранных ставок</div>';
  return `<div class="spark-topbets">${top.map(({ b, profit }) => `
    <div class="spark-topbet-row">
      <span class="spark-topbet-name">${escapeHtml(b.match || b.pick || '—')}</span>
      <span class="spark-topbet-val">${fmtMoney(profit, currency, rate)}</span>
    </div>`).join('')}</div>`;
}

// Единый плавающий поповер на все карточки .stat-card[data-has-pop] внутри
// container — через делегирование на самом container (переживает любые
// последующие innerHTML-перерисовки сетки, не нужно перевешивать слушатели
// после каждого рендера). position:fixed — сознательно, а не absolute:
// .stat-grid стоит с overflow:hidden (ради скруглённых углов), и поповер на
// absolute обрезался бы этим же контейнером у крайних карточек.
let sparkPopEl = null;
export function initStatCardPopovers(container) {
  if (!container) return;
  if (!sparkPopEl) {
    sparkPopEl = document.createElement('div');
    sparkPopEl.className = 'stat-spark-pop';
    document.body.appendChild(sparkPopEl);
  }
  const show = card => {
    const content = card.querySelector('.stat-card-pop-content');
    if (!content) return;
    sparkPopEl.innerHTML = content.innerHTML;
    const r = card.getBoundingClientRect();
    const approxWidth = 210;
    let left = r.left + r.width / 2;
    left = Math.max(approxWidth / 2 + 8, Math.min(window.innerWidth - approxWidth / 2 - 8, left));
    sparkPopEl.style.left = `${Math.round(left)}px`;
    sparkPopEl.style.top = `${Math.round(r.top - 10)}px`;
    sparkPopEl.classList.add('visible');
  };
  const hide = () => sparkPopEl.classList.remove('visible');
  // На устройствах с настоящим наведением мышью (hover:hover + pointer:fine)
  // тот же .stat-card-pop-content теперь раскрывается прямо внутри самой
  // укрупняющейся карточки через CSS (см. #statGrid в styles-edge3.css) —
  // плавающий поповер там же дублировал бы то же самое, поэтому по mouseover
  // его не показываем. На тач/грубом указателе такого CSS-эффекта нет —
  // там поповер остаётся единственным способом увидеть детали, mouseover
  // всё равно почти не срабатывает на тач-устройствах без реальной мыши.
  const finePointerHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  container.addEventListener('mouseover', e => {
    if (finePointerHover) return;
    const card = e.target.closest('.stat-card[data-has-pop]');
    if (!card || !container.contains(card)) return;
    show(card);
  });
  container.addEventListener('mouseout', e => {
    if (finePointerHover) return;
    const card = e.target.closest('.stat-card[data-has-pop]');
    if (!card) return;
    if (card.contains(e.relatedTarget)) return;
    hide();
  });
  container.addEventListener('focusin', e => {
    const card = e.target.closest('.stat-card[data-has-pop]');
    if (card) show(card);
  });
  container.addEventListener('focusout', e => {
    const card = e.target.closest('.stat-card[data-has-pop]');
    if (card && !card.contains(e.relatedTarget)) hide();
  });
}

// ===========================================================================
// Milestone 22 — профиль v2 + лента ставок. См. CHANGELOG.md.
// ===========================================================================

// Грейд рейтинга каппера. V1: считается ТОЛЬКО по объёму отслеженной
// истории (количество решённых/закрытых ставок — Pending не считается).
// Это сознательно временно и явно проговорено пользователю: рейтинг задуман
// как составной (в будущем — стабильность серии, точность CLV, активность
// в канале, реакция подписчиков), но пока эти факторы не реализованы, а
// показывать несуществующую составную формулу как готовую было бы враньём.
// Кривая — насыщающаяся экспонента (не линейная): у капперов с небольшой
// историей рейтинг растёт быстро, дальше эффект от каждой новой ставки
// уменьшается — 150 ставок ощутимо двигают шкалу, 1500-я ставка почти нет.
const RATING_TIERS = ['Новичок', 'Активный', 'Проверенный', 'Опытный', 'Элита'];
export function computeRatingTier(bets) {
  const closedCount = (bets || []).filter(b => b.result !== 'Pending').length;
  const score = Math.min(100, Math.round(100 * (1 - Math.exp(-closedCount / 150))));
  const idx = Math.min(RATING_TIERS.length - 1, Math.floor(score / (100 / RATING_TIERS.length)));
  return { score, closedCount, tierName: RATING_TIERS[idx], tiers: RATING_TIERS };
}

// Топ дисциплин капера по доле от общего числа ставок — карточки
// "специализации" на профиле (например "CS2 61%"). n — сколько показать
// (по умолчанию 3), остальное не влезает в одну строку без переноса.
export function computeSpecialization(bets, n = 3) {
  const counts = {};
  (bets || []).forEach(b => {
    if (!b.discipline) return;
    counts[b.discipline] = (counts[b.discipline] || 0) + 1;
  });
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (!total) return [];
  return Object.entries(counts)
    .map(([discipline, count]) => ({ discipline, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// Относительное время ("2 часа назад", "3 дня назад") для карточек в ленте
// ставок — там абсолютная дата+время из fmtDateTime были бы слишком
// многословны на каждой карточке (в ленте таймстамп есть в hover, не нужно
// дублировать крупно). Грубая шкала — минуты/часы/дни/недели, дальше просто
// дата, поминутная точность после недели уже не имеет смысла для ленты.
export function fmtRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${min === 1 ? 'минуту' : min < 5 ? 'минуты' : 'минут'} назад`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'час' : hrs < 5 ? 'часа' : 'часов'} назад`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'} назад`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? 'неделю' : weeks < 5 ? 'недели' : 'недель'} назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Баннер шапки профиля — НЕ декоративная случайная картинка, а настоящий
// кумулятивный профит канала (та же серия точек, что и в спарклайне на
// карточке "Профит" дашборда, computeCardTrend('profit', bets)), только
// растянутый на всю ширину баннера. Две линии — общий профит (акцент) и
// тот же тренд со сдвигом/сглаживанием как декоративный второй слой (var
// --teal), просто чтобы баннер не выглядел как один сухой график, а как
// текстура — но обе линии из реальных данных, не выдуманные. Меньше 2 точек
// (например у совсем нового канала без решённых ставок) — рисуем плоскую
// линию по центру, без графика делать нечего, но и баннер пустым не будет.
export function renderProfileBanner(profitPoints) {
  const W = 720, H = 170;
  const toPath = (points, padTop, padBottom) => {
    if (!points || points.length < 2) {
      return `M 0,${H / 2} L ${W},${H / 2}`;
    }
    const min = Math.min(...points), max = Math.max(...points);
    const range = (max - min) || 1;
    const stepX = W / (points.length - 1);
    return points.map((v, i) => {
      const x = i * stepX;
      const y = padTop + (H - padTop - padBottom) - ((v - min) / range) * (H - padTop - padBottom);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  // Раньше здесь рисовался ещё и второй слой — та же серия, сглаженная
  // скользящим средним и сдвинутая ниже, чтобы "не сливаться" с основной
  // линией. Убрано (см. CHANGELOG.md, задача про профиль v2): без подписи
  // две линии одного графика выглядели как декоративный шаблон/заглушка,
  // а не как настоящие данные — притом что вторая линия НЕ несла отдельного
  // смысла (та же серия, просто по-другому прочитанная). Одна линия — тот
  // же реальный кумулятивный профит канала, что и карточка "Профит" ниже.
  const mainPath = toPath(profitPoints, 20, 24);
  const mainFillPath = `${mainPath} L ${W},${H} L 0,${H} Z`;
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path class="pf-banner-fill" d="${mainFillPath}"></path>
      <path class="pf-banner-line" d="${mainPath}"></path>
    </svg>`;
}
