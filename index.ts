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
                'Название букмекера. Если явного текста или логотипа с названием НЕТ на изображении — попробуй определить по узнаваемому фирменному визуальному стилю интерфейса: цветовая схема, форма и стиль иконок (например, значок геймпада для киберспорта), шрифт, вёрстка карточек истории ставок, характерные UI-элементы. Многие крупные букмекерские приложения/сайты (Fonbet, 1xBet, Winline, Marathon, Betcity, Пари, Лига Ставок, Pinnacle и т.п.) имеют узнаваемый стиль. Если удалось определить ТОЛЬКО по визуальному стилю (без явного текста/логотипа) — обязательно добавь "Букмекер" в uncertain_fields этой ставки, это предположение, а не факт, его нужно перепроверить человеку. Если ни текста, ни узнаваемого стиля нет — null.',
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
            stake: { type: ['number', 'null'], description: 'Сумма ставки в валюте купона (просто число, без символа валюты). null, если не видна.' },
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

  const { image, mimeType } = body || {};
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
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: image },
          },
          {
            type: 'text',
            text:
              'На изображении — скриншот ставки (или нескольких ставок) на спорт: купон букмекера, экран истории ставок ' +
              'в приложении и т.п. Распознай ВСЕ отдельные ставки, которые видишь на изображении (это может быть одна, ' +
              'а может быть несколько отдельных карточек в списке истории), и вызови record_bet_data строго по описанной ' +
              'схеме — каждая ставка отдельным элементом массива bets, по порядку сверху вниз. Если букмекер не назван ' +
              'явно текстом или логотипом — попробуй определить его по узнаваемому фирменному визуальному стилю ' +
              'интерфейса (см. описание поля bookmaker) и обязательно отметь это в uncertain_fields той ставки. Если ' +
              'каких-то данных на изображении нет или они нечитаемы — верни null для этого поля, НЕ придумывай ' +
              'правдоподобные значения. Если изображение вообще не похоже ни на одну ставку — detected: false, bets: [].',
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

  // Лог сырого распознанного результата — если фронтенд после этого всё
  // равно покажет "не похоже на купон" или что-то не так с массивом bets,
  // тут в Supabase Logs (вкладка Logs у функции) будет видно, что именно
  // вернула модель, без необходимости гадать вслепую.
  console.log('parse-bet-screenshot: detected=' + toolUse.input?.detected + ', bets=' + (Array.isArray(toolUse.input?.bets) ? toolUse.input.bets.length : 'n/a'));

  return jsonResponse({ result: toolUse.input });
});
