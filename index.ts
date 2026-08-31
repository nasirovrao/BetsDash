// Supabase Edge Function: telegram-link
// -------------------------------------------------------------------------
// Обычная (Verify JWT ВКЛЮЧЁН, как у parse-bet-screenshot) функция для
// UI-действий на telegram-import.html: сгенерировать код привязки, выбрать
// целевой канал EDGE, отвязать канал. Дёргается фронтендом через
// supabase.functions.invoke('telegram-link', {...}) от своего собственного
// JWT — платформа Supabase уже проверила подпись токена до запуска кода
// (тот же принцип, что у parse-bet-screenshot, см. userIdFromAuthHeader).
//
// Пишет в public.telegram_links сервис-ролью (SUPABASE_SERVICE_ROLE_KEY,
// доступен автоматически, secrets set не нужен) — у таблицы нет
// insert/update-политик для обычного пользователя специально, чтобы
// telegram_chat_id нельзя было подделать прямым запросом в обход этой
// функции (см. schema_milestone27.sql).
//
// Реальное ПОДТВЕРЖДЕНИЕ привязки (простановка telegram_chat_id) происходит
// НЕ здесь, а в telegram-webhook/index.ts, когда код публикуется постом в
// самом канале — эта функция только заводит/обновляет код и настройки.
//
// ------------------------- ДЕПЛОЙ -----------------------
// Как и parse-bet-screenshot — через Supabase Dashboard (Functions →
// Deploy a new function → Via Editor) или CLI (`supabase functions deploy
// telegram-link`). Verify JWT должен остаться ВКЛЮЧЁН (по умолчанию) — это
// обычная функция для залогиненных пользователей, в отличие от
// telegram-webhook.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Идентичен userIdFromAuthHeader в parse-bet-screenshot/index.ts — подпись
// JWT не перепроверяем здесь повторно, платформа уже сделала это.
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

// Код без похожих друг на друга символов (без 0/O/1/I/L) — публикуется
// постом в Telegram-канале, человек его один раз копирует вручную.
function randomLinkCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = 'EDGE-';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Метод не поддерживается, нужен POST.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY недоступны в env функции.' }, 500);
  }

  const userId = userIdFromAuthHeader(req);
  if (!userId) {
    return jsonResponse({ error: 'Не удалось определить пользователя по токену авторизации.' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Некорректное тело запроса — ожидается JSON.' }, 400);
  }
  const action = body?.action;
  if (!['generate_code', 'set_channel', 'unlink'].includes(action)) {
    return jsonResponse({ error: 'Неизвестное действие (ожидается generate_code / set_channel / unlink).' }, 400);
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const selectRes = await fetch(
    `${supabaseUrl}/rest/v1/telegram_links?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { headers: { ...headers, Accept: 'application/vnd.pgrst.object+json' } },
  );
  let existing: any = null;
  if (selectRes.ok) {
    existing = await selectRes.json().catch(() => null);
  } else if (selectRes.status !== 406) {
    return jsonResponse({ error: 'Не удалось прочитать текущую привязку: ' + (await selectRes.text().catch(() => selectRes.status)) }, 502);
  }

  if (action === 'generate_code') {
    // Новый код — НЕ трогает уже подтверждённую привязку (telegram_chat_id/
    // linked_at сохраняются как были), пока новый код реально не будет
    // опубликован постом в канале и подхвачен telegram-webhook — так
    // человек может сгенерировать код заново (например, если старый
    // потерялся), не рискуя случайно "отвязать" уже работающий канал
    // просто открыв страницу.
    const payload = {
      user_id: userId,
      channel: existing?.channel || 'default',
      link_code: randomLinkCode(),
      telegram_chat_id: existing?.telegram_chat_id ?? null,
      telegram_chat_title: existing?.telegram_chat_title ?? null,
      linked_at: existing?.linked_at ?? null,
    };
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/telegram_links`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([payload]),
    });
    if (!upsertRes.ok) {
      return jsonResponse({ error: 'Не удалось сохранить код: ' + (await upsertRes.text().catch(() => upsertRes.status)) }, 502);
    }
    const rows = await upsertRes.json().catch(() => []);
    return jsonResponse({ link: rows[0] || payload });
  }

  if (!existing) {
    return jsonResponse({ error: 'Сначала сгенерируй код привязки.' }, 400);
  }

  if (action === 'set_channel') {
    const channel = body?.channel === 'cybervalue' ? 'cybervalue' : 'default';
    const updRes = await fetch(`${supabaseUrl}/rest/v1/telegram_links?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ channel }),
    });
    if (!updRes.ok) {
      return jsonResponse({ error: 'Не удалось сохранить канал: ' + (await updRes.text().catch(() => updRes.status)) }, 502);
    }
    const rows = await updRes.json().catch(() => []);
    return jsonResponse({ link: rows[0] || { ...existing, channel } });
  }

  // action === 'unlink' — сбрасывает привязку к конкретному Telegram-каналу
  // (chat_id/title/linked_at), но оставляет саму строку и код: так следующий
  // "показать код" не создаёт новую строку с нуля, а просто позволяет
  // привязать другой канал заново.
  const updRes = await fetch(`${supabaseUrl}/rest/v1/telegram_links?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ telegram_chat_id: null, telegram_chat_title: null, linked_at: null }),
  });
  if (!updRes.ok) {
    return jsonResponse({ error: 'Не удалось отвязать канал: ' + (await updRes.text().catch(() => updRes.status)) }, 502);
  }
  const rows = await updRes.json().catch(() => []);
  return jsonResponse({ link: rows[0] || { ...existing, telegram_chat_id: null, telegram_chat_title: null, linked_at: null } });
});
