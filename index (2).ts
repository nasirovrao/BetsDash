// Supabase Edge Function: telegram-webhook
// -------------------------------------------------------------------------
// Принимает Update от Telegram Bot API (webhook), для канала, к которому
// бот добавлен админом. Два сценария:
//   1) Пост в ЕЩЁ НЕ привязанном канале, текст которого совпадает с кодом
//      привязки (см. telegram-link/index.ts) — подтверждает привязку.
//   2) Пост в УЖЕ привязанном канале — пробует распознать в тексте и/или
//      КАРТИНКЕ данные ставки (тот же принцип tool_use/record_bet_data, что
//      и у parse-bet-screenshot) и, если похоже на ставку, кладёт в очередь
//      telegram_pending_bets — ничего не сохраняет в дневник само, человек
//      подтверждает через app.html (?tg=<id>), тот же принцип
//      верифицируемости, что у скриншотов.
//
// 01.09.2026: добавлена поддержка постов с картинкой (скриншот купона),
// не только текста — раньше пост без текста (например, просто фото без
// подписи) молча игнорировался. Фото/документ-картинка скачивается через
// Telegram Bot API (getFile + скачивание файла) и передаётся модели тем же
// способом, что и в parse-bet-screenshot (image content block + vision).
// Подпись к посту (caption), если есть, идёт дополнительным текстом рядом
// с картинкой — не обязательна.
//
// 01.09.2026, следом: три доработки по прямому запросу ("В + лимит и
// реализуем ещё предыдущую штуку"), все три — про то, чтобы не жечь платные
// вызовы модели впустую и не плодить дубликаты в очереди:
//   1) Дешёвый локальный фильтр ДО вызова модели — см. looksLikeBet ниже.
//   2) MONTHLY_TELEGRAM_LIMIT снижен с 1000 до 40 — консервативный потолок,
//      раз канал не гарантированно "только ставки".
//   3) Обработка edited_channel_post — правка подписи/текста уже
//      опубликованного поста триггерит повторное распознавание, и результат
//      ЗАМЕЩАЕТ прежнюю запись в очереди по этому же message_id, а не
//      добавляет вторую (см. isEdit ниже). Требует ПЕРЕРЕГИСТРАЦИИ webhook
//      с allowed_updates=["channel_post","edited_channel_post"] — см. п.5
//      деплой-инструкции ниже, шаг нужно повторить с новым списком.
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
//    функции — просто вызов их API с токеном бота). allowed_updates ниже
//    ВКЛЮЧАЕТ edited_channel_post — если webhook уже был зарегистрирован
//    раньше только с channel_post, эту команду нужно выполнить ПОВТОРНО с
//    обновлённым списком, иначе правки постов Telegram присылать не будет:
//      curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
//        -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook" \
//        -d "secret_token=<та же случайная строка, что в шаге 3>" \
//        -d "allowed_updates=[\"channel_post\",\"edited_channel_post\"]"
// 6. Добавить бота АДМИНОМ в свой Telegram-канал (без этого бот физически
//    не видит посты канала) — права достаточно минимальные, "видеть посты"
//    хватает, публиковать от имени бота не нужно.
// 7. На telegram-import.html — "Показать код привязки", опубликовать код
//    ОДНИМ постом в канале (после подтверждения сообщение можно удалить).
// ---------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any

const DEFAULT_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // тот же практический лимит, что и у parse-bet-screenshot

// 01.09.2026: снижено с 1000 до 40 по прямому запросу — канал не
// гарантированно "только ставки" (общение/анонсы тоже считались бы),
// консервативный потолок надёжнее, чем полагаться только на локальный
// фильтр (looksLikeBet) отсеять весь шум идеально точно. Считается каждый
// РЕАЛЬНЫЙ вызов модели (текст или картинка, без разницы) — посты,
// отсеянные looksLikeBet ДО вызова модели, в счётчик не попадают вообще.
const MONTHLY_TELEGRAM_LIMIT = 40;

// Схема на два случая — текстовый пост и пост с картинкой (после 01.09.2026
// добавления поддержки фото). Описание bookmaker с подсказкой про
// визуальный стиль актуально в первую очередь для картинок (в тексте
// определить букмекер по "стилю" неоткуда), но модель сама разберётся,
// какая ветка описания к чему относится — держать один инструмент проще,
// чем плодить два почти одинаковых.
const BET_TOOL = {
  name: 'record_bet_data',
  description: 'Записать распознанные из текста и/или изображения поста данные об одной или нескольких ставках на спорт, если пост похож на объявление ставки.',
  input_schema: {
    type: 'object',
    properties: {
      detected: {
        type: 'boolean',
        description: 'true, если пост похож хотя бы на одну ставку. false для любого другого поста (анонс, аналитика без конкретной ставки, реклама, обсуждение, поздравление и т.п.) — тогда bets можно оставить пустым массивом. Не пытайся притянуть за уши: лучше false, чем ложное срабатывание на посте без реальной ставки.',
      },
      bets: {
        type: 'array',
        description: 'Обычно один элемент — один пост Telegram-канала почти всегда содержит одну ставку (или один купон на скриншоте). Несколько элементов — если в ОДНОМ посте явно перечислено/показано несколько отдельных ставок (не путать с экспрессом — это одна ставка с несколькими ногами, is_express=true).',
        items: {
          type: 'object',
          properties: {
            confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Уверенность в распознавании именно этой ставки.' },
            bet_date: { type: ['string', 'null'], description: 'Дата ставки YYYY-MM-DD, если явно видна/указана. null, если не видна — НЕ подставляй дату публикации поста сама по себе.' },
            discipline: { type: ['string', 'null'], description: 'Вид спорта/киберспорта, например "Dota2", "CS2", "Football", "Tennis". null, если не ясно.' },
            bookmaker: {
              type: ['string', 'null'],
              description:
                'Название букмекера. Если явного текста/логотипа с названием нет (актуально для скриншотов) — попробуй определить по узнаваемому фирменному визуальному стилю интерфейса (цветовая схема, иконки, шрифт, вёрстка — Fonbet/1xBet/Winline/Marathon/Betcity/Пари/Лига Ставок/Pinnacle и т.п.). Если определил ТОЛЬКО по стилю — обязательно добавь "Букмекер" в uncertain_fields. Для обычного текстового поста букмекер указывается, только если явно упомянут словами. Если ни того ни другого нет — null.',
            },
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
            odds: { type: ['number', 'null'], description: 'Итоговый кэф ставки. null, если не указан/не виден.' },
            stake: { type: ['number', 'null'], description: 'Сумма ставки, если явно указана числом. null, если не указана.' },
            result: {
              type: ['string', 'null'],
              enum: ['Pending', 'Win', 'Loss', 'Push', null],
              description: 'Результат, ЕСЛИ явно указан текстом или виден на скриншоте (например "🟢 зашло", купон подсвечен зелёным). Если пост — анонс до начала события, "Pending". Если не ясно — null.',
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

// Uint8Array -> base64 кусками (не String.fromCharCode(...bytes) на весь
// массив разом — на скриншотах в несколько сотен КБ+ это может упереться в
// лимит аргументов вызова функции в Deno/V8). Тот же приём, что обычно
// используют для конвертации больших ArrayBuffer в base64 без сторонних
// зависимостей.
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Скачивает файл (фото/документ-картинку) с серверов Telegram по file_id —
// два шага их Bot API: getFile (по file_id узнать file_path), затем скачать
// сами байты по этому пути. mimeType определяется по расширению файла —
// Telegram при сжатии фото (post.photo) всегда отдаёт JPEG, для документов
// расширение обычно совпадает с исходным типом.
async function downloadTelegramFile(fileId: string, botToken: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const getFileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!getFileRes.ok) {
      console.error('downloadTelegramFile: getFile failed', getFileRes.status);
      return null;
    }
    const getFileData = await getFileRes.json();
    const filePath: string | undefined = getFileData?.result?.file_path;
    if (!filePath) {
      console.error('downloadTelegramFile: no file_path in getFile response');
      return null;
    }
    const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!fileRes.ok) {
      console.error('downloadTelegramFile: file download failed', fileRes.status);
      return null;
    }
    const buf = await fileRes.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      console.error('downloadTelegramFile: file too large', buf.byteLength);
      return null;
    }
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return { base64: base64FromBytes(new Uint8Array(buf)), mimeType };
  } catch (e) {
    console.error('downloadTelegramFile failed', (e as Error).message);
    return null;
  }
}

// Убирает из очереди всё, что раньше было положено ПО ЭТОМУ ЖЕ посту
// (message_id) — вызывается перед тем, как класть туда что-то заново после
// правки поста (isEdit), чтобы повторное/изменённое распознавание ЗАМЕЩАЛО
// прежнюю карточку, а не плодило вторую рядом. Если пользователь уже успел
// подтвердить и сохранить ставку из этого поста ДО правки — её строки в
// telegram_pending_bets уже нет (удалена при сохранении, см. app.html), эта
// функция в таком случае просто ничего не найдёт и ничего не удалит —
// известное упрощение, повторная правка после подтверждения создаст новую
// отдельную карточку, а не "обновит" уже сохранённую в дневнике ставку.
async function clearPendingForMessage(userId: string, messageId: number, supabaseUrl: string, serviceKey: string) {
  const res = await supaFetch(
    `telegram_pending_bets?user_id=eq.${userId}&telegram_message_id=eq.${messageId}`,
    { method: 'DELETE' },
    supabaseUrl, serviceKey,
  );
  if (!res.ok) console.error('clearPendingForMessage: delete failed', res.status);
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

  // Публичные каналы шлют channel_post на новый пост и edited_channel_post
  // на правку уже существующего (правка подписи/текста — тоже это событие).
  // Личные чаты с ботом (например, будущая привязка через ЛС) сюда
  // сознательно не добавлены в этой версии — см. CHANGELOG, "Сознательно не
  // сделано". isEdit нужен ниже, чтобы решить, замещать ли старую карточку
  // в очереди по этому message_id, а не создавать вторую.
  const post = update?.channel_post || update?.edited_channel_post;
  const isEdit = !!update?.edited_channel_post;
  if (!post || !post.chat || typeof post.chat.id !== 'number') {
    return jsonResponse({ ok: true });
  }
  const chatId: number = post.chat.id;
  const chatTitle: string = post.chat.title || '';
  const textOrCaption: string = (post.text || post.caption || '').trim();

  // Картинка — либо сжатое фото (post.photo, массив размеров от мелкого к
  // крупному, берём самый крупный), либо документ-картинка (кто-то шлёт
  // несжатый PNG "файлом", чтобы не терять качество купона). photo и
  // document в одном посте не бывают одновременно — Telegram различает эти
  // два способа прикрепить изображение.
  const photoArr = Array.isArray(post.photo) ? post.photo : null;
  const doc = post.document;
  const isImageDocument = !!(doc && typeof doc.mime_type === 'string' && /^image\/(png|jpe?g|webp|gif)$/i.test(doc.mime_type));
  const imageFileId: string | null = photoArr && photoArr.length ? photoArr[photoArr.length - 1].file_id : (isImageDocument ? doc.file_id : null);

  if (!imageFileId && !textOrCaption) return jsonResponse({ ok: true });

  // ---- Сценарий 1: канал ещё не привязан -- проверяем, не код ли это ----
  // Код привязки всегда публикуется отдельным текстовым постом (не
  // картинкой), так что здесь по-прежнему смотрим только на textOrCaption.
  const linkedRes = await supaFetch(
    `telegram_links?telegram_chat_id=eq.${chatId}&select=user_id`,
    { headers: { Accept: 'application/vnd.pgrst.object+json' } },
    supabaseUrl, serviceKey,
  );
  const alreadyLinked = linkedRes.ok ? await linkedRes.json().catch(() => null) : null;

  if (!alreadyLinked) {
    if (textOrCaption) {
      const codeRes = await supaFetch(
        `telegram_links?link_code=eq.${encodeURIComponent(textOrCaption)}&telegram_chat_id=is.null&select=user_id`,
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
    }
    // Не код (или картинка без текста) и канал не привязан — просто
    // игнорируем пост молча: непривязанный канал нам не принадлежит, не
    // должен засорять чью-то очередь распознанными "ставками".
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

  // Картинку скачиваем ДО фильтра/лимита — если скачать не удалось (и
  // текста тоже нет), тратить платный вызов модели незачем.
  let image: { base64: string; mimeType: string } | null = null;
  if (imageFileId) {
    image = await downloadTelegramFile(imageFileId, botToken);
    if (!image && !textOrCaption) {
      console.error('telegram-webhook: не удалось скачать изображение и текста тоже нет, пропускаю пост');
      return jsonResponse({ ok: true });
    }
  }

  // 01.09.2026, дешёвый локальный фильтр ДО вызова модели (бесплатно, не
  // расходует MONTHLY_TELEGRAM_LIMIT): если картинки нет И в тексте нет ни
  // одной цифры — почти наверняка не ставка (нет намёка на кэф/сумму),
  // отсекаем без обращения к Anthropic вообще. Не идеально точный фильтр —
  // гипотетически ставка может быть описана совсем без цифр — но отсекает
  // подавляющее большинство нерелевантного шума канала (анонсы, общение,
  // реклама), которое иначе жгло бы вызовы модели впустую.
  const looksLikeBet = !!image || /\d/.test(textOrCaption);
  if (!looksLikeBet) {
    // Чистим по message_id безусловно, не только при isEdit — см. комментарий
    // ниже у второго вызова clearPendingForMessage(): та же защита от дублей
    // при повторной доставке актуальна и здесь (на обычном новом посте это
    // просто no-op, удалять нечего).
    await clearPendingForMessage(userId, post.message_id, supabaseUrl, serviceKey);
    return jsonResponse({ ok: true });
  }

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

  // Текст промпта разный для картинки (доп. контекст — есть ли подпись) и
  // для чистого текстового поста — но инструмент (BET_TOOL) один и тот же.
  const content: any[] = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } });
    content.push({
      type: 'text',
      text:
        `Изображение из поста Telegram-канала со ставками (скриншот купона/бетслипа или похожее)` +
        (textOrCaption ? `, к посту есть подпись: "${textOrCaption}".` : ', подписи к посту нет.') +
        ' Определи, похоже ли это (картинка и/или подпись вместе) на объявление ставки, и если да — вызови record_bet_data строго по описанной схеме. ' +
        'Если букмекер не назван явно текстом/логотипом на картинке — попробуй определить его по узнаваемому фирменному визуальному стилю интерфейса ' +
        'и обязательно отметь это в uncertain_fields той ставки. Если это не похоже на ставку — detected: false, bets: [].',
    });
  } else {
    content.push({
      type: 'text',
      text: `Пост из Telegram-канала со ставками. Определи, похож ли он на объявление ставки, и если да — вызови record_bet_data строго по описанной схеме. Если это НЕ объявление ставки (анонс без конкретики, реклама, обсуждение, разбор без факта ставки и т.п.) — detected: false, bets: [].\n\n---\n${textOrCaption}\n---`,
    });
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: image ? 4096 : 1536, // картинке нужен запас побольше, тот же принцип, что у parse-bet-screenshot
        tools: [BET_TOOL],
        tool_choice: { type: 'tool', name: 'record_bet_data' },
        messages: [{ role: 'user', content }],
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
  const detectedBets = toolUse?.input?.detected && Array.isArray(toolUse.input.bets) ? toolUse.input.bets : [];

  // Чистим то, что было по этому message_id раньше, БЕЗУСЛОВНО — не только
  // при isEdit. Две причины разом:
  //   1) Правка поста — новый результат (пустой или нет) заменяет старую
  //      карточку, а не добавляется второй (см. заголовок файла, п.3).
  //   2) Telegram может ПОВТОРНО доставить один и тот же channel_post (если
  //      функция не ответила достаточно быстро — например, вызов модели с
  //      картинкой занял пару секунд дольше обычного) — без этой чистки
  //      повторная доставка вставила бы дубликат ставки в очередь. На
  //      обычном новом посте, доставленном один раз, это безопасный no-op —
  //      удалять по этому message_id ещё нечего.
  await clearPendingForMessage(userId, post.message_id, supabaseUrl, serviceKey);

  if (!detectedBets.length) {
    // Не похоже на ставку (или модель не вернула структурированный ответ) —
    // тихо пропускаем, НЕ отвечаем в канал: подавляющее большинство постов в
    // любом канале не ставки (анонсы, разборы, общение), реагировать на
    // каждый был бы спамом.
    return jsonResponse({ ok: true });
  }

  // raw_text для очереди на telegram-import.html — при посте-картинке без
  // подписи там нечего показать как "исходный текст", подставляем короткую
  // пометку, чтобы карточка в очереди не выглядела пустой/сломанной.
  const rawTextForStorage = textOrCaption || (image ? '[скриншот]' : '');

  const rows = detectedBets.map((b: any) => ({
    user_id: userId,
    channel: targetChannel,
    telegram_message_id: post.message_id ?? null,
    raw_text: rawTextForStorage,
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

  console.log(`telegram-webhook: user_id=${userId} chat_id=${chatId} bets=${rows.length} image=${!!image} edit=${isEdit} -> telegram_pending_bets`);
  return jsonResponse({ ok: true });
});
