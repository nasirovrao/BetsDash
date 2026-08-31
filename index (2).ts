// Supabase Edge Function: telegram-webhook
// -------------------------------------------------------------------------
// Принимает Update от Telegram Bot API (webhook), для канала, к которому
// бот добавлен админом. Два сценария:
//   1) Пост в ЕЩЁ НЕ привязанном канале, текст которого совпадает с кодом
//      привязки (см. telegram-link/index.ts) — подтверждает привязку.
//   2) Пост в УЖЕ привязанном канале — пробует распознать в тексте данные
//      ставки (тот же принцип tool_use/record_bet_data, что и у
//      parse-bet-screenshot, но по тексту, не по картинке) и, если похоже
//      на ставку, кладёт в очередь telegram_pending_bets — ничего не
//      сохраняет в дневник само, человек подтверждает через app.html
//      (?tg=<id>), тот же принцип верифицируемости, что у скриншотов.
//
// ВАЖНОЕ ОТЛИЧИЕ от parse-bet-screenshot: эту функцию дёргает Telegram, а
// не залогиненный пользователь EDGE — у запроса нет и не может быть
// Supabase JWT. Поэтому у ЭТОЙ функции в Supabase Dashboard нужно ВЫКЛЮЧИТЬ
// "Verify JWT with legacy secret" (единственная функция в проекте, где это
// нужно) — иначе Supabase будет отклонять все запросы от Telegram ещё до
// того, как код функции вообще начнёт выполняться. Подлинность запроса
// вместо JWT проверяется секретным заголовком, который сам Telegram
// присылает в каждом вызове (см. verifyTelegramSecret ниже) — это НЕ
// опционально, без него кто угодно, узнав URL функции, сможет прислать
// поддельные "посты" и подсунуть в твою очередь мусорные ставки.
//
// Всегда отвечает 200 (jsonResponse({ok:true})), даже при внутренних
// ошибках — так и должно быть с Telegram webhook: не-200/таймаут заставляет
// Telegram повторять доставку того же update раз за разом. Ошибки — только
// в console.error (Supabase Logs), не в ответе.
//
// ------------------------- ДЕПЛОЙ (пошагово) -----------------------
// 1. Создать бота: написать @BotFather в Telegram, /newbot, получить токен
//    вида 123456:AA玄...
// 2. supabase secrets set TELEGRAM_BOT_TOKEN=<токен>
// 3. supabase secrets set TELEGRAM_WEBHOOK_SECRET=<случайная строка, придумай сам>
// 4. Задеплоить функцию БЕЗ проверки JWT:
//      supabase functions deploy telegram-webhook --no-verify-jwt
//    (или через Dashboard: Deploy a new function → после деплоя зайти в
//    Settings этой функции и ВЫКЛЮЧИТЬ "Verify JWT with legacy secret")
// 5. Зарегистрировать webhook у Telegram (одноразово, из терминала, не из
//    функции — просто вызов их API с токеном бота):
//      curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
//        -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook" \
//        -d "secret_token=<та же случайная строка, что в шаге 3>" \
//        -d "allowed_updates=[\"channel_post\"]"
// 6. Добавить бота АДМИНОМ в свой Telegram-канал (без этого бот физически
//    не видит посты канала) — права достаточно минимальные, "видеть посты"
//    хватает, публиковать от имени бота не нужно.
// 7. На telegram-import.html — "Показать код привязки", опубликовать код
//    ОДНИМ постом в канале (после подтверждения сообщение можно удалить).
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

// Текстовый вызов на порядок дешевле вызова с картинкой (см.
// parse-bet-screenshot) — лимит поэтому заметно выше, но не бесконечный:
// активный канал с частыми постами не должен генерировать неограниченный
// счёт на ключе Anthropic. Считается каждый ПОСТ, который дошёл до вызова
// модели (то есть уже привязанный канал, не сам код привязки).
const MONTHLY_TELEGRAM_LIMIT = 1000;

const BET_TOOL = {
  name: 'record_bet_data',
  description: 'Записать распознанные из текста поста данные об одной ставке на спорт, если пост похож на объявление ставки.',
  input_schema: {
    type: 'object',
    properties: {
      detected: {
        type: 'boolean',
        description: 'true, если текст похож хотя бы на одну ставку. false для любого другого поста (анонс, аналитика без конкретной ставки, реклама, обсуждение, поздравление и т.п.) — тогда bets можно оставить пустым массивом. Не пытайся притянуть за уши: лучше false, чем ложное срабатывание на посте без реальной ставки.',
      },
      bets: {
        type: 'array',
        description: 'Обычно один элемент — один пост Telegram-канала почти всегда содержит одну ставку. Несколько элементов — только если в ОДНОМ посте явно перечислено несколько отдельных ставок (не путать с экспрессом — это одна ставка с несколькими ногами, is_express=true).',
        items: {
          type: 'object',
          properties: {
            confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Уверенность в распознавании именно этой ставки.' },
            bet_date: { type: ['string', 'null'], description: 'Дата ставки YYYY-MM-DD, если явно указана в тексте. null, если не указана — НЕ подставляй дату публикации поста сама по себе, если текст явно не привязывает ставку к дате.' },
            discipline: { type: ['string', 'null'], description: 'Вид спорта/киберспорта, например "Dota2", "CS2", "Football", "Tennis". null, если не ясно.' },
            bookmaker: { type: ['string', 'null'], description: 'Название букмекера, ТОЛЬКО если явно упомянуто текстом поста — в отличие от скриншотов, здесь неоткуда угадывать по визуальному стилю. null, если не упомянут.' },
            tournament: { type: ['string', 'null'], description: 'Название турнира/лиги, если указано.' },
            is_express: { type: 'boolean', description: 'true, если это экспресс (несколько событий одной ставкой), false для одиночной ставки.' },
            match: { type: ['string', 'null'], description: 'Название матча/события для одиночной ставки. null для экспресса.' },
            pick: { type: ['string', 'null'], description: 'Конкретный исход/пик для одиночной ставки. null для экспресса.' },
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
            odds: { type: ['number', 'null'], description: 'Итоговый кэф ставки. null, если не указан текстом.' },
            stake: { type: ['number', 'null'], description: 'Сумма ставки, если явно указана числом. null, если не указана (многие посты вообще не пишут сумму).' },
            result: {
              type: ['string', 'null'],
              enum: ['Pending', 'Win', 'Loss', 'Push', null],
              description: 'Результат, ЕСЛИ явно указан текстом (например "🟢 зашло", "❌ не зашло"). Если пост — анонс до начала события, "Pending". Если не ясно — null.',
            },
            uncertain_fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Названия полей (на русском, как в форме — "Кэф", "Сумма", "Дата", "Букмекер"), в которых модель не уверена и стоит перепроверить человеку.',
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
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Telegram сам присылает этот заголовок в каждом webhook-запросе, если он
// был задан параметром secret_token при регистрации (см. деплой-инструкцию
// выше, шаг 5) — сравнение строкой, без него любой человек, узнавший URL
// функции, мог бы слать сюда поддельные "посты".
function verifyTelegramSecret(req: Request): boolean {
  const expected = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!expected) return false; // секрет не задан — ничего не подтверждаем, отказываем всем
  return req.headers.get('x-telegram-bot-api-secret-token') === expected;
}

async function supaFetch(path: string, init: RequestInit, supabaseUrl: string, serviceKey: string) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

// Тот же принцип, что checkAndIncrementUsage в parse-bet-screenshot/index.ts
// (известное упрощение: read-then-write не в одной транзакции), отдельная
// таблица telegram_parse_usage — см. schema_milestone27.sql.
async function checkAndIncrementTelegramUsage(userId: string, supabaseUrl: string, serviceKey: string): Promise<boolean> {
  const month = new Date().toISOString().slice(0, 7);
  const selectRes = await supaFetch(
    `telegram_parse_usage?user_id=eq.${encodeURIComponent(userId)}&month=eq.${month}&select=count`,
    { headers: { Accept: 'application/vnd.pgrst.object+json' } },
    supabaseUrl, serviceKey,
  );
  let currentCount = 0;
  if (selectRes.ok) {
    const row = await selectRes.json().catch(() => null);
    if (row && typeof row.count === 'number') currentCount = row.count;
  } else if (selectRes.status !== 406) {
    console.error('checkAndIncrementTelegramUsage: select failed', selectRes.status);
    return true; // не смогли посчитать — не блокируем из-за временного сбоя
  }
  if (currentCount >= MONTHLY_TELEGRAM_LIMIT) return false;
  const upsertRes = await supaFetch('telegram_parse_usage', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ user_id: userId, month, count: currentCount + 1, updated_at: new Date().toISOString() }]),
  }, supabaseUrl, serviceKey);
  if (!upsertRes.ok) console.error('checkAndIncrementTelegramUsage: upsert failed', upsertRes.status);
  return true;
}

async function replyToChat(chatId: number, text: string, botToken: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error('replyToChat failed', (e as Error).message);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ ok: true });
  if (!verifyTelegramSecret(req)) {
    console.error('telegram-webhook: неверный или отсутствующий секретный заголовок');
    return jsonResponse({ ok: true }); // не подтверждаем факт отказа деталями — просто тихо игнорируем
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!supabaseUrl || !serviceKey || !botToken) {
    console.error('telegram-webhook: не заданы SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/TELEGRAM_BOT_TOKEN');
    return jsonResponse({ ok: true });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return jsonResponse({ ok: true });
  }

  // Публичные каналы шлют channel_post (не message — у постов канала нет
  // отправителя-человека, автор скрыт по дизайну Telegram). Личные чаты с
  // ботом (например, будущая привязка через ЛС) сюда сознательно не
  // добавлены в этой версии — см. CHANGELOG, раздел "Сознательно не сделано".
  const post = update?.channel_post;
  if (!post || !post.chat || typeof post.chat.id !== 'number') {
    return jsonResponse({ ok: true });
  }
  const chatId: number = post.chat.id;
  const chatTitle: string = post.chat.title || '';
  const text: string = (post.text || post.caption || '').trim();
  if (!text) return jsonResponse({ ok: true });

  // ---- Сценарий 1: канал ещё не привязан -- проверяем, не код ли это ----
  const linkedRes = await supaFetch(
    `telegram_links?telegram_chat_id=eq.${chatId}&select=user_id`,
    { headers: { Accept: 'application/vnd.pgrst.object+json' } },
    supabaseUrl, serviceKey,
  );
  const alreadyLinked = linkedRes.ok ? await linkedRes.json().catch(() => null) : null;

  if (!alreadyLinked) {
    const codeRes = await supaFetch(
      `telegram_links?link_code=eq.${encodeURIComponent(text)}&telegram_chat_id=is.null&select=user_id`,
      { headers: { Accept: 'application/vnd.pgrst.object+json' } },
      supabaseUrl, serviceKey,
    );
    if (codeRes.ok) {
      const match = await codeRes.json().catch(() => null);
      if (match && match.user_id) {
        const confirmRes = await supaFetch(`telegram_links?user_id=eq.${match.user_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ telegram_chat_id: chatId, telegram_chat_title: chatTitle, linked_at: new Date().toISOString() }),
        }, supabaseUrl, serviceKey);
        if (confirmRes.ok) {
          await replyToChat(chatId, '✅ Канал привязан к EDGE — новые посты со ставками теперь будут появляться в очереди на подтверждение.', botToken);
        } else {
          console.error('telegram-webhook: confirm link failed', confirmRes.status);
        }
        return jsonResponse({ ok: true });
      }
    }
    // Не код и канал не привязан — просто игнорируем пост молча (НЕ пытаемся
    // распознавать ставки в непривязанном канале, иначе кто угодно, кто
    // узнает URL функции... хотя нет, это невозможно без секрета, но
    // логически "чужой" канал нам всё равно не принадлежит и не должен
    // засорять чью-то очередь).
    return jsonResponse({ ok: true });
  }

  // ---- Сценарий 2: канал уже привязан -- пробуем распознать ставку ----
  const userId: string = alreadyLinked.user_id;

  const linkRowRes = await supaFetch(
    `telegram_links?user_id=eq.${userId}&select=channel`,
    { headers: { Accept: 'application/vnd.pgrst.object+json' } },
    supabaseUrl, serviceKey,
  );
  const linkRow = linkRowRes.ok ? await linkRowRes.json().catch(() => null) : null;
  const targetChannel = linkRow?.channel || 'default';

  const withinLimit = await checkAndIncrementTelegramUsage(userId, supabaseUrl, serviceKey);
  if (!withinLimit) {
    console.error(`telegram-webhook: лимит ${MONTHLY_TELEGRAM_LIMIT}/мес исчерпан для user_id=${userId}, пост пропущен без распознавания`);
    return jsonResponse({ ok: true });
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('telegram-webhook: ANTHROPIC_API_KEY не задан');
    return jsonResponse({ ok: true });
  }
  const model = Deno.env.get('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: 1536,
        tools: [BET_TOOL],
        tool_choice: { type: 'tool', name: 'record_bet_data' },
        messages: [{
          role: 'user',
          content: `Пост из Telegram-канала со ставками. Определи, похож ли он на объявление ставки, и если да — вызови record_bet_data строго по описанной схеме. Если это НЕ объявление ставки (анонс без конкретики, реклама, обсуждение, разбор без факта ставки и т.п.) — detected: false, bets: [].\n\n---\n${text}\n---`,
        }],
      }),
    });
  } catch (e) {
    console.error('telegram-webhook: Anthropic fetch failed', (e as Error).message);
    return jsonResponse({ ok: true });
  }
  if (!anthropicRes.ok) {
    console.error('telegram-webhook: Anthropic вернул ошибку', anthropicRes.status, (await anthropicRes.text().catch(() => '')).slice(0, 500));
    return jsonResponse({ ok: true });
  }

  const data = await anthropicRes.json();
  const toolUse = (data.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'record_bet_data');
  if (!toolUse || !toolUse.input?.detected || !Array.isArray(toolUse.input.bets) || !toolUse.input.bets.length) {
    // Не похоже на ставку (или модель не вернула структурированный ответ) —
    // тихо пропускаем, НЕ отвечаем в канал: подавляющее большинство постов в
    // любом канале не ставки (анонсы, разборы, общение), реагировать на
    // каждый был бы спамом.
    return jsonResponse({ ok: true });
  }

  const rows = toolUse.input.bets.map((b: any) => ({
    user_id: userId,
    channel: targetChannel,
    telegram_message_id: post.message_id ?? null,
    raw_text: text,
    parsed: b,
  }));
  const insertRes = await supaFetch('telegram_pending_bets', {
    method: 'POST',
    body: JSON.stringify(rows),
  }, supabaseUrl, serviceKey);
  if (!insertRes.ok) {
    console.error('telegram-webhook: insert telegram_pending_bets failed', insertRes.status, await insertRes.text().catch(() => ''));
    return jsonResponse({ ok: true });
  }

  console.log(`telegram-webhook: user_id=${userId} chat_id=${chatId} bets=${rows.length} -> telegram_pending_bets`);
  return jsonResponse({ ok: true });
});
