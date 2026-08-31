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

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB — практический лимит Anthropic API на одну картинку в base64

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Единственный "инструмент" — заставляем модель вернуть строго такой JSON,
// а не текст произвольного формата, который потом нужно было бы регэкспить.
const BET_TOOL = {
  name: 'record_bet_data',
  description: 'Записать распознанные с изображения данные о ставке на спорт (купон/бетслип букмекера).',
  input_schema: {
    type: 'object',
    properties: {
      detected: {
        type: 'boolean',
        description: 'true, если на изображении вообще похоже на купон/бетслип ставки. false, если это не похоже на ставку (случайный скриншот, другое приложение и т.п.) — тогда остальные поля можно не заполнять.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Общая уверенность в распознавании. low — если картинка размыта/обрезана/данные неоднозначны.',
      },
      bet_date: { type: ['string', 'null'], description: 'Дата ставки в формате YYYY-MM-DD, если видна на скриншоте. null, если не видна — НЕ подставлять сегодняшнюю дату самостоятельно.' },
      discipline: { type: ['string', 'null'], description: 'Вид спорта/киберспорта, например "Dota2", "CS2", "Football", "Tennis". null, если не ясно.' },
      bookmaker: { type: ['string', 'null'], description: 'Название букмекера, если видно на скриншоте (логотип, шапка приложения и т.п.). null, если не ясно.' },
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
      odds: { type: ['number', 'null'], description: 'Итоговый кэф ставки (для экспресса — итоговый кэф всей связки, если он явно виден на купоне).' },
      stake: { type: ['number', 'null'], description: 'Сумма ставки в валюте купона (просто число, без символа валюты). null, если не видна.' },
      result: {
        type: ['string', 'null'],
        enum: ['Pending', 'Win', 'Loss', 'Push', null],
        description: 'Результат, ЕСЛИ он явно виден на скриншоте (например, купон уже расчитан и подсвечен зелёным/красным). Если купон открытый/на рассмотрении — "Pending". Если результат совсем не ясен — null, и фронтенд оставит поле как есть.',
      },
      uncertain_fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Список названий полей (на русском, как в форме — например "Кэф", "Сумма", "Дата"), в которых модель не уверена и которые стоит особо перепроверить человеку, даже если значение подставлено.',
      },
    },
    required: ['detected', 'confidence', 'is_express', 'legs', 'uncertain_fields'],
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
    max_tokens: 1024,
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
              'На изображении — скриншот ставки на спорт (купон букмекера, история ставок в приложении и т.п.). ' +
              'Распознай данные ставки и вызови record_bet_data строго по описанной схеме. ' +
              'Если каких-то данных на изображении нет или они нечитаемы — верни null для этого поля, НЕ придумывай ' +
              'правдоподобные значения. Если изображение вообще не похоже на ставку — detected: false.',
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
    return jsonResponse({ error: 'Модель не вернула структурированный ответ — попробуй другой/более чёткий скриншот.' }, 502);
  }

  return jsonResponse({ result: toolUse.input });
});
