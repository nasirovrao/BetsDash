// Supabase Edge Function: parse-bet-screenshot
// -------------------------------------------------------------------------
// Принимает картинку (скриншот бетслипа/купона у букмекера), просит Claude
// (Anthropic API) распознать данные ставки и возвращает структурированный
// JSON, которым app.html заполняет форму "Добавить ставку". Человек ВСЕГДА
// проверяет и сам жмёт "Добавить ставку" — эта функция ничего не пишет в
// базу сама, только распознаёт.
//
// Ключ модели живёт здесь, на сервере (Supabase secret), а не во фронтенде —
// см. CHANGELOG.md → "Парсинг ставок со скриншота" для контекста решения.
//
// ------------------------- ДЕПЛОЙ (сделать самому) -----------------------
// 1. Установить Supabase CLI и залогиниться (supabase login), привязать
//    проект: supabase link --project-ref <твой-project-ref>
// 2. Положить ключ модели секретом (НЕ в .env фронтенда, НЕ в git):
//      supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//    Ключ берётся в консоли Anthropic (console.anthropic.com) → API Keys.
// 3. Задеплоить саму функцию:
//      supabase functions deploy parse-bet-screenshot
//    По умолчанию Supabase проверяет JWT входящего запроса — это то, что
//    нужно (только залогиненные пользователи твоего проекта могут дёргать
//    функцию), НЕ добавляй флаг --no-verify-jwt.
// 4. Проверить модель ставок (см. константу MODEL ниже) актуальна на момент
//    деплоя — свериться с docs.claude.com/en/docs/about-claude/models
//    (модели с поддержкой vision меняются со временем, дата в этом файле
//    может отстать). Можно переопределить без переdeploy кода секретом
//    ANTHROPIC_MODEL, если понадобится сменить модель.
// ---------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any

const DEFAULT_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB — практический лимит Anthropic API на одну картинку в base64

// 31.08.2026: лимит на пользователя, добавлен по прямому запросу — каждый
// вызов с картинкой стоит реальных денег на ключе Anthropic (см. README),
// без потолка один аккаунт может случайно (или намеренно) нагенерировать
// произвольный счёт. Считается сам ФАКТ вызова функции с картинкой, не
// количество распознанных ставок внутри одного скриншота — см.
// schema_milestone25.sql для схемы таблицы и обоснования выбора UTC-месяца.
const MONTHLY_SCREENSHOT_LIMIT = 100;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Единственный "инструмент" — заставляем модель вернуть строго такой JSON,
// а не текст произвольного формата, который потом нужно было бы регэкспить.
//
// 30.08.2026, вторая итерация: раньше схема описывала РОВНО ОДНУ ставку.
// Расширено под два запроса:
// 1) распознавание букмекера по фирменному визуальному стилю интерфейса,
//    если явного текста/логотипа с названием нет (см. описание bookmaker);
// 2) один скриншот может содержать НЕСКОЛЬКО отдельных ставок (например,
//    экран истории ставок с несколькими карточками) — теперь модель
//    возвращает массив `bets`, а не одну ставку в корне объекта. Фронтенд
//    (app.html) обрабатывает это как очередь: заполняет форму первой
//    ставкой, после сохранения — следующей, и так по очереди.
const BET_TOOL = {
  name: 'record_bet_data',
  description: 'Записать распознанные с изображения данные об одной или нескольких ставках на спорт (купон/бетслип букмекера, экран истории ставок).',
  input_schema: {
    type: 'object',
    properties: {
      detected: {
        type: 'boolean',
        description: 'true, если на изображении вообще похоже хотя бы на одну ставку. false, если это не похоже на ставку (случайный скриншот, другое приложение и т.п.) — тогда bets можно оставить пустым массивом.',
      },
      bets: {
        type: 'array',
        description: 'Список распознанных ставок, по одному элементу на каждую отдельную ставку на изображении, В ТОМ ПОРЯДКЕ, В КОТОРОМ они идут на скриншоте (обычно сверху вниз). Если на изображении одна ставка/один купон — массив из ОДНОГО элемента, не разбивай одну ставку на несколько. Если несколько отдельных карточек ставок (например, лента истории) — верни каждую отдельным элементом. Пусто, если detected=false.',
        items: {
          type: 'object',
          properties: {
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Уверенность в распознавании именно ЭТОЙ ставки. low — если её часть обрезана/размыта/данные неоднозначны.',
            },
            bet_date: { type: ['string', 'null'], description: 'Дата ставки в формате YYYY-MM-DD, если видна. null, если не видна — НЕ подставлять сегодняшнюю дату самостоятельно.' },
            discipline: { type: ['string', 'null'], description: 'Вид спорта/киберспорта, например "Dota2", "CS2", "Football", "Tennis". null, если не ясно.' },
            bookmaker: {
              type: ['string', 'null'],
              description:
                'Название букмекера. Если явного текста или логотипа с названием НЕТ на изображении — попробуй определить по узнаваемому фирменному визуальному стилю интерфейса: цветовая схема, форма и стиль иконок (например, значок геймпада для киберспорта), шрифт, вёрстка карточек истории ставок, характерные UI-элементы. Многие крупные букмекерские приложения/сайты (Fonbet, 1xBet, Winline, Marathon, Betcity, Пари, Лига Ставок, Pinnacle, Пинко/Pinco и т.п.) имеют узнаваемый стиль. Если удалось определить ТОЛЬКО по визуальному стилю (без явного текста/логотипа) — обязательно добавь "Букмекер" в uncertain_fields этой ставки, это предположение, а не факт, его нужно перепроверить человеку. Если ни текста, ни узнаваемого стиля нет — null. ВАЖНО: если букмекера не удалось определить НИКАК (ни текстом, ни стилем) — это НЕ повод считать всю ставку нераспознанной (detected: false). bookmaker в этом случае просто null, а все остальные поля (кэф, сумма, исход, результат) распознаются как обычно.',
            },
            tournament: { type: ['string', 'null'], description: 'Название турнира/лиги, если указано.' },
            is_express: { type: 'boolean', description: 'true, если это экспресс (несколько событий одной ставкой), false для одиночной ставки.' },
            match: { type: ['string', 'null'], description: 'Название матча/события для ОДИНОЧНОЙ ставки (is_express=false), например "Spirit vs MOUZ". null для экспресса.' },
            pick: { type: ['string', 'null'], description: 'Конкретный исход/пик для ОДИНОЧНОЙ ставки, например "Spirit 1x2 — Map 1". null для экспресса.' },
            legs: {
              type: 'array',
              description: 'Только для is_express=true: список ног экспресса. Пусто для одиночной ставки.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Описание одной ноги экспресса.' },
                  odds: { type: ['number', 'null'], description: 'Кэф этой ноги.' },
                },
                required: ['text'],
              },
            },
            odds: { type: ['number', 'null'], description: 'Итоговый кэф ставки (для экспресса — итоговый кэф всей связки, если он явно виден).' },
            stake: { type: ['number', 'null'], description: 'Сумма ставки — просто число, без символа валюты, В ТОЙ ВАЛЮТЕ, В КОТОРОЙ ОНА ВИДНА на купоне (не конвертируй сам). null, если не видна.' },
            stake_currency: {
              type: ['string', 'null'],
              enum: ['USD', 'RUB', 'EUR', 'KZT', null],
              description: 'Валюта суммы ставки — определи по символу/коду рядом с числом (₽/руб/RUB → RUB, $/USD → USD, €/EUR → EUR, ₸/KZT → KZT). Если не удалось определить — null, тогда фронтенд считает валюту уже долларами и не конвертирует.',
            },
            result: {
              type: ['string', 'null'],
              enum: ['Pending', 'Win', 'Loss', 'Push', null],
              description: 'Результат, ЕСЛИ он явно виден (например, купон уже расчитан и подсвечен зелёным/красным, есть слово "Выигрыш"/"Проигрыш"). Если ставка открыта/на рассмотрении — "Pending". Если результат совсем не ясен — null, и фронтенд оставит поле как есть.',
            },
            uncertain_fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Список названий полей ЭТОЙ ставки (на русском, как в форме — например "Кэф", "Сумма", "Дата", "Букмекер"), в которых модель не уверена и которые стоит особо перепроверить человеку, даже если значение подставлено.',
            },
          },
          required: ['confidence', 'is_express', 'legs', 'uncertain_fields'],
        },
      },
    },
    required: ['detected', 'bets'],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// 02.09.2026: приложение хранит "Сумма ($)" как просто число в предположении
// доллара — если купон в рублях/другой валюте, раньше это число просто
// подставлялось как есть (10 000 ₽ становилось "10000" долларов). Конвертим
// в USD по актуальному курсу (open.er-api.com — бесплатный, без ключа, ЦБ/
// агрегированные источники). Курс на МОМЕНТ РАСПОЗНАВАНИЯ, а не на момент
// самой ставки (которая могла быть неделю назад) — поэтому дальше сумма
// всегда помечается uncertain_fields, а не подставляется молча как факт.
const RATE_CACHE = new Map<string, number>(); // на время жизни одного холодного старта функции
async function usdRateFor(currency: string): Promise<number | null> {
  if (currency === 'USD') return 1;
  if (RATE_CACHE.has(currency)) return RATE_CACHE.get(currency)!;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${currency}`);
    if (!res.ok) return null;
    const data = await res.json();
    const rate = data?.rates?.USD;
    if (typeof rate !== 'number') return null;
    RATE_CACHE.set(currency, rate);
    return rate;
  } catch (e) {
    console.error('usdRateFor: не удалось получить курс для', currency, (e as Error).message);
    return null;
  }
}

// Мутирует bets на месте: конвертирует stake в USD, если stake_currency
// указана и отличается от USD, отмечает "Сумма" как uncertain (курс
// приблизительный/текущий, не на момент ставки).
async function convertStakesToUsd(bets: any[]): Promise<void> {
  for (const b of bets) {
    if (b == null || typeof b !== 'object') continue;
    const currency = typeof b.stake_currency === 'string' ? b.stake_currency.toUpperCase() : null;
    if (!currency || currency === 'USD' || b.stake == null || typeof b.stake !== 'number') continue;
    const rate = await usdRateFor(currency);
    if (rate == null) continue; // не смогли получить курс — оставляем как есть, не портим данные
    b.stake = Math.round(b.stake * rate * 100) / 100;
    if (!Array.isArray(b.uncertain_fields)) b.uncertain_fields = [];
    if (!b.uncertain_fields.includes('Сумма')) b.uncertain_fields.push('Сумма');
  }
}

// Достаём user_id из JWT в заголовке Authorization — саму подпись токена
// НЕ проверяем здесь: платформа Supabase уже это сделала на уровне
// Edge Functions ДО того, как код функции вообще начал выполняться (см.
// переключатель "Verify JWT with legacy secret" в Settings функции — он
// включён, это то самое, что нужно). Здесь просто читаем payload уже
// проверенного токена, чтобы узнать, чей это запрос.
function userIdFromAuthHeader(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[1].length + (4 - (parts[1].length % 4)) % 4, '=');
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

// Проверяет и, если лимит не исчерпан, сразу инкрементирует счётчик
// (резервируем ДО вызова Anthropic, а не после — иначе можно уйти в минус,
// если несколько запросов улетят почти одновременно). SUPABASE_URL и
// SUPABASE_SERVICE_ROLE_KEY — не наши секреты, их не нужно задавать через
// `supabase secrets set`: Supabase сам инжектит их в env каждой Edge
// Function проекта. Сервис-роль обходит RLS — то, что и нужно, чтобы писать
// в таблицу, куда обычным пользователям (даже себе самим) запись закрыта.
//
// Простой read-then-write, не одна атомарная транзакция — известное
// упрощение, см. комментарий в schema_milestone25.sql.
async function checkAndIncrementUsage(userId: string): Promise<{ ok: boolean; count: number }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    // Не должно происходить в реальном Supabase-проекте (оба всегда
    // доступны), но если вдруг — не блокируем фичу целиком из-за этого,
    // просто не считаем лимит в этом запросе.
    console.error('checkAndIncrementUsage: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY недоступны в env');
    return { ok: true, count: -1 };
  }
  const month = new Date().toISOString().slice(0, 7); // UTC 'YYYY-MM'
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const selectRes = await fetch(
    `${supabaseUrl}/rest/v1/screenshot_parse_usage?user_id=eq.${encodeURIComponent(userId)}&month=eq.${month}&select=count`,
    { headers: { ...headers, Accept: 'application/vnd.pgrst.object+json' } },
  );
  // 406 = PostgREST "не нашлось ровно одной строки" (Accept просит singular
  // object) — это нормальный случай "ещё не было ни одного запроса в этом
  // месяце", не ошибка.
  let currentCount = 0;
  if (selectRes.ok) {
    const row = await selectRes.json().catch(() => null);
    if (row && typeof row.count === 'number') currentCount = row.count;
  } else if (selectRes.status !== 406) {
    console.error('checkAndIncrementUsage: select failed', selectRes.status, await selectRes.text().catch(() => ''));
    return { ok: true, count: -1 };
  }

  if (currentCount >= MONTHLY_SCREENSHOT_LIMIT) {
    return { ok: false, count: currentCount };
  }

  const newCount = currentCount + 1;
  const upsertRes = await fetch(`${supabaseUrl}/rest/v1/screenshot_parse_usage`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ user_id: userId, month, count: newCount, updated_at: new Date().toISOString() }]),
  });
  if (!upsertRes.ok) {
    console.error('checkAndIncrementUsage: upsert failed', upsertRes.status, await upsertRes.text().catch(() => ''));
    // Не смогли записать инкремент — лучше пропустить запрос, чем ошибочно
    // заблокировать пользователя из-за временного сбоя записи в базу.
    return { ok: true, count: currentCount };
  }
  return { ok: true, count: newCount };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Метод не поддерживается, нужен POST.' }, 405);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY не задан как секрет функции (supabase secrets set ANTHROPIC_API_KEY=...).' }, 500);
  }
  const model = Deno.env.get('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Некорректное тело запроса — ожидается JSON.' }, 400);
  }

  const { image, mimeType, bookmakerNotes } = body || {};
  if (!image || typeof image !== 'string') {
    return jsonResponse({ error: 'Не передана картинка (поле "image", base64 без префикса data:).' }, 400);
  }
  if (!mimeType || !/^image\/(png|jpe?g|webp|gif)$/i.test(mimeType)) {
    return jsonResponse({ error: 'Неподдерживаемый или отсутствующий mimeType. Разрешены: png, jpeg, webp, gif.' }, 400);
  }
  // Грубая оценка размера декодированных данных по длине base64-строки —
  // достаточно точно (base64 раздувает исходный размер примерно в 4/3
  // раза), чтобы отсечь совсем большие файлы до похода к модели.
  const approxBytes = Math.floor((image.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: 'Картинка слишком большая (>5MB после декодирования) — сожми или обрежь скриншот.' }, 413);
  }

  // Лимит проверяем и резервируем ДО похода к Anthropic — так деньги не
  // тратятся на запрос, который всё равно будет отклонён.
  const userId = userIdFromAuthHeader(req);
  if (!userId) {
    return jsonResponse({ error: 'Не удалось определить пользователя по токену авторизации.' }, 401);
  }
  const usage = await checkAndIncrementUsage(userId);
  if (!usage.ok) {
    return jsonResponse({
      error: `Лимит распознавания скриншотов на этот месяц исчерпан (${usage.count}/${MONTHLY_SCREENSHOT_LIMIT}). Лимит сбрасывается в начале следующего месяца — а пока можно заполнить форму вручную.`,
      usage: { count: usage.count, limit: MONTHLY_SCREENSHOT_LIMIT, remaining: 0 },
    }, 429);
  }

  // 02.09.2026: референс-скриншоты букмекеров, добавленные пользователем
  // через "+" у поля "Букмекер" на app.html (bookmakerNotes в
  // settings.bookmaker_notes, schema_milestone29.sql). Изначально было
  // текстовое описание стиля — заменено на реальные картинки по прямому
  // запросу ("может фоткой интерфейс показывать уж лучше?"): few-shot
  // изображением модель узнаёт визуальный стиль ощутимо надёжнее, чем по
  // словесному описанию. У модели нет состояния между вызовами — каждый
  // раз подкладываем референсы заново прямо в этот запрос. Повод исходной
  // фичи: репорт "плохо распознаёт скрины с конторы Пинко" — Пинко не было
  // в захардкоженном списке "узнаваемых" букмекеров внутри промпта.
  //
  // MAX_BOOKMAKER_REFS — потолок на число референсов В ОДНОМ запросе:
  // каждый референс — это ещё одна картинка в теле запроса к Anthropic
  // (токены/деньги), без потолка список рос бы бесконечно с каждым новым
  // добавленным букмекером.
  const MAX_BOOKMAKER_REFS = 6;
  const referenceContent: any[] = [];
  const legacyTextNotes: string[] = []; // на случай старых текстовых заметок (до этой правки)
  if (bookmakerNotes && typeof bookmakerNotes === 'object') {
    let refCount = 0;
    for (const [name, note] of Object.entries(bookmakerNotes)) {
      if (typeof name !== 'string' || !note) continue;
      if (typeof note === 'string') {
        if (note.trim()) legacyTextNotes.push(`- ${name}: ${note.trim()}`);
        continue;
      }
      const ref = note as { image?: string; mimeType?: string };
      if (refCount >= MAX_BOOKMAKER_REFS || !ref.image || !ref.mimeType) continue;
      referenceContent.push({ type: 'text', text: `Пример интерфейса букмекера "${name}":` });
      referenceContent.push({ type: 'image', source: { type: 'base64', media_type: ref.mimeType, data: ref.image } });
      refCount++;
    }
  }
  let bookmakerNotesBlock = '';
  if (referenceContent.length) {
    bookmakerNotesBlock =
      '\n\nВыше приложены примеры интерфейсов известных пользователю букмекеров (каждый подписан именем) — сравни ' +
      'визуальный стиль РЕАЛЬНОГО изображения ниже с этими примерами в первую очередь при определении bookmaker.';
  }
  if (legacyTextNotes.length) {
    bookmakerNotesBlock +=
      '\n\nТакже пользователь заранее описал словами, как выглядят интерфейсы некоторых букмекеров:\n' + legacyTextNotes.join('\n');
  }

  const anthropicReq = {
    model,
    // Увеличено с 1024: теперь ответ может содержать несколько ставок в
    // массиве bets (см. комментарий у BET_TOOL), одной ставки может не
    // хватить бюджета на скриншотах с длинной историей ставок.
    max_tokens: 4096,
    tools: [BET_TOOL],
    tool_choice: { type: 'tool', name: 'record_bet_data' },
    messages: [
      {
        role: 'user',
        // Референсы (если есть) идут ПЕРЕД реальным изображением — модель
        // читает контент по порядку, к моменту реального скриншота уже
        // "видела" примеры стилей.
        content: [
          ...referenceContent,
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: image },
          },
          {
            type: 'text',
            text:
              'На изображении ВЫШЕ (последнем, после примеров интерфейсов, если они были приложены) — скриншот ставки ' +
              '(или нескольких ставок) на спорт: купон букмекера, экран истории ставок в приложении и т.п. Распознай ВСЕ ' +
              'отдельные ставки, которые видишь на этом изображении (это может быть одна, а может быть несколько ' +
              'отдельных карточек в списке истории), и вызови record_bet_data строго по описанной схеме — каждая ставка ' +
              'отдельным элементом массива bets, по порядку сверху вниз. Если букмекер не назван явно текстом или ' +
              'логотипом — попробуй определить его по узнаваемому фирменному визуальному стилю интерфейса (см. описание ' +
              'поля bookmaker) и обязательно отметь это в uncertain_fields той ставки. ' +
              'ВАЖНО: интерфейс конкретного букмекера тебе может быть незнаком — это НЕ повод считать ставку ' +
              'нераспознанной. Если на экране видны признаки ставки (исход/пик, кэф, сумма, результат — в любом ' +
              'сочетании, не обязательно все сразу) — это detected: true, даже если название букмекера определить не ' +
              'получилось вообще (тогда просто bookmaker: null, без попытки угадать). Если ' +
              'каких-то данных на изображении нет или они нечитаемы — верни null для этого поля, НЕ придумывай ' +
              'правдоподобные значения. detected: false — только если изображение ДЕЙСТВИТЕЛЬНО не похоже ни на одну ' +
              'ставку (случайный скриншот, другое приложение, текст без чисел/исходов и т.п.), а не когда просто ' +
              'незнаком конкретный визуальный стиль.' + bookmakerNotesBlock,
          },
        ],
      },
    ],
  };

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicReq),
    });
  } catch (e) {
    return jsonResponse({ error: 'Не удалось обратиться к Anthropic API: ' + (e as Error).message }, 502);
  }

  if (!anthropicRes.ok) {
    const text = await anthropicRes.text().catch(() => '');
    return jsonResponse({ error: `Anthropic API вернул ошибку (${anthropicRes.status}): ${text.slice(0, 500)}` }, 502);
  }

  const data = await anthropicRes.json();
  const toolUse = (data.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'record_bet_data');
  if (!toolUse) {
    // stop_reason='max_tokens' здесь — самый вероятный практический случай:
    // модель не уложилась в бюджет (например, скриншот с длинной историей
    // ставок) и не успела закрыть tool_use блок валидным JSON. Отдаём это
    // явно, а не generic-сообщением, чтобы было понятно, что дело не в
    // "непохоже на ставку", а в лимите.
    const reason = data.stop_reason ? ` (stop_reason: ${data.stop_reason})` : '';
    console.error('parse-bet-screenshot: no tool_use in response' + reason, JSON.stringify(data).slice(0, 2000));
    return jsonResponse({ error: `Модель не вернула структурированный ответ${reason} — попробуй другой/более чёткий скриншот.` }, 502);
  }

  // 02.09.2026: тот же баг, что уже чинился в telegram-webhook (см. его
  // index.ts, комментарий 02.09.2026) — модель иногда возвращает не
  // {detected, bets} на верхнем уровне, а {bets: "<весь правильный JSON,
  // включая detected и bets, ещё раз запакованный строкой>"}. Разворачиваем
  // тот же один уровень "двойной упаковки", если verdict.detected не
  // нашёлся напрямую.
  let verdict: any = toolUse.input;
  if (verdict && verdict.detected === undefined && typeof verdict.bets === 'string') {
    try {
      const unwrapped = JSON.parse(verdict.bets);
      if (unwrapped && typeof unwrapped === 'object') verdict = unwrapped;
    } catch (e) {
      console.error('parse-bet-screenshot: не удалось разобрать вложенный JSON в bets', (e as Error).message);
    }
  }
  // Дополнительная страховка: если bets — настоящий непустой массив, а
  // detected просто не пришло полем (не строка-обёртка, а буквально
  // отсутствует), считаем это подтверждением, а не отказом — модель явно
  // распознала ставки (иначе зачем бы возвращала их), забытое поле
  // detected не повод показывать "не похоже на купон" при реальных данных
  // в руках. Блокирует только ЯВНОЕ detected: false.
  const detected = verdict?.detected !== false && Array.isArray(verdict?.bets) && verdict.bets.length > 0;
  const normalized = { detected, bets: Array.isArray(verdict?.bets) ? verdict.bets : [] };
  await convertStakesToUsd(normalized.bets);

  // Лог сырого распознанного результата — если фронтенд после этого всё
  // равно покажет "не похоже на купон" или что-то не так с массивом bets,
  // тут в Supabase Logs (вкладка Logs у функции) будет видно, что именно
  // вернула модель, без необходимости гадать вслепую.
  console.log('parse-bet-screenshot: detected=' + normalized.detected + ', bets=' + normalized.bets.length + ', rawDetected=' + toolUse.input?.detected);

  return jsonResponse({
    result: normalized,
    // usage.count === -1 значит "не смогли посчитать лимит в этом запросе"
    // (см. checkAndIncrementUsage) — фронтенд в этом случае просто не
    // показывает счётчик, а не рисует "-1 из 100".
    usage: usage.count >= 0 ? { count: usage.count, limit: MONTHLY_SCREENSHOT_LIMIT, remaining: MONTHLY_SCREENSHOT_LIMIT - usage.count } : null,
  });
});
