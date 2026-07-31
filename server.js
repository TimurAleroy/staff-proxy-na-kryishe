const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_GUESTS_DB_ID = '35173a7166368022bf60d76141cca681'; // Карточка Гостя
const NOTION_VISITS_DB_ID = 'f384e676a0d7477bb45a34707bcb0dff'; // Визиты
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STAFF_PIN = process.env.STAFF_PIN || '159500';
const WEBAPP_URL = 'https://timuraleroy.github.io/na-kryishe-staff';
const PORT = process.env.PORT || 3000;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

function checkPin(req, res) {
  const pin = req.query.pin || req.body?.pin;
  if (pin !== STAFF_PIN) {
    res.status(401).json({ error: 'Неверный PIN-код' });
    return false;
  }
  return true;
}

async function tgApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API ${method} failed:`, err);
    return null;
  }
}

// ─── ПРОВЕРКА PIN ──────────────────────────────────

app.post('/api/staff/login', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json({ ok: true });
});

// ─── ПОИСК ГОСТЯ ───────────────────────────────────

app.get('/api/staff/search', async (req, res) => {
  if (!checkPin(req, res)) return;
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Имя Гостя', title: { contains: name } } })
    });
    const data = await r.json();
    const results = (data.results || []).map(g => ({
      id: g.id,
      name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || ''
    }));
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── КАРТОЧКА ГОСТЯ + ВИЗИТЫ ───────────────────────

app.get('/api/staff/guest/:id', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const guestRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const guest = await guestRes.json();
    const props = guest.properties;

    const visitsRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_VISITS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Гость', relation: { contains: req.params.id } },
        sorts: [{ property: 'Дата', direction: 'descending' }],
        page_size: 3
      })
    });
    const visitsData = await visitsRes.json();
    const visits = (visitsData.results || []).map(v => {
      const vp = v.properties;
      return {
        date: vp['Дата']?.date?.start || '',
        hookah: vp['Кальян']?.rich_text?.[0]?.plain_text || '',
        notes: vp['Заметки']?.rich_text?.[0]?.plain_text || ''
      };
    });

    res.json({
      id: guest.id,
      name: props['Имя Гостя']?.title?.[0]?.plain_text || '',
      status: props['Частота визитов']?.select?.name || '',
      birthday: props['Дата рождения']?.date?.start || null,
      phone: props['Телефон']?.phone_number || '',
      important: props['Что важно для гостя']?.rich_text?.[0]?.plain_text || '',
      visits
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch guest' });
  }
});

// ─── РЕДАКТИРОВАНИЕ КАРТОЧКИ ───────────────────────

app.patch('/api/staff/guest/:id', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { field, value } = req.body;

  const properties = {};
  if (field === 'status') properties['Частота визитов'] = { select: { name: value } };
  else if (field === 'birthday') properties['Дата рождения'] = { date: { start: value } };
  else if (field === 'phone') properties['Телефон'] = { phone_number: value };
  else if (field === 'important') properties['Что важно для гостя'] = { rich_text: [{ text: { content: value } }] };
  else return res.status(400).json({ error: 'unknown field' });

  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── НОВЫЙ ГОСТЬ ────────────────────────────────────

app.post('/api/staff/guest', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { name, status, birthday, phone, important } = req.body;
  if (!name || !status) return res.status(400).json({ error: 'name and status required' });

  const properties = {
    'Имя Гостя': { title: [{ text: { content: name } }] },
    'Частота визитов': { select: { name: status } },
    'Что важно для гостя': { rich_text: [{ text: { content: important || '' } }] }
  };
  if (birthday) properties['Дата рождения'] = { date: { start: birthday } };
  if (phone) properties['Телефон'] = { phone_number: phone };

  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: NOTION_GUESTS_DB_ID }, properties })
    });
    const created = await r.json();
    res.json({ ok: true, id: created.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create guest' });
  }
});

// ─── ДОБАВИТЬ / ДОПОЛНИТЬ ВИЗИТ ─────────────────────

async function cleanupOldVisits(guestId, keep = 3) {
  const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_VISITS_DB_ID}/query`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: { property: 'Гость', relation: { contains: guestId } },
      sorts: [{ property: 'Дата', direction: 'descending' }],
      page_size: 100
    })
  });
  const data = await r.json();
  const visits = data.results || [];
  if (visits.length > keep) {
    for (const old of visits.slice(keep)) {
      await fetch(`https://api.notion.com/v1/pages/${old.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ archived: true })
      });
    }
  }
}

app.post('/api/staff/visit', async (req, res) => {
  if (!checkPin(req, res)) return;
  const { guestId, guestName, hookah, notes } = req.body;
  if (!guestId || !hookah) return res.status(400).json({ error: 'guestId and hookah required' });

  const today = new Date().toISOString().split('T')[0];

  try {
    const existingRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_VISITS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Гость', relation: { contains: guestId } },
            { property: 'Дата', date: { equals: today } }
          ]
        }
      })
    });
    const existingData = await existingRes.json();
    const existing = existingData.results?.[0];

    if (existing) {
      const existingNotes = existing.properties['Заметки']?.rich_text?.[0]?.plain_text || '';
      const combinedNotes = notes ? (existingNotes ? `${existingNotes} / ${notes}` : notes) : existingNotes;
      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          properties: {
            'Кальян': { rich_text: [{ text: { content: hookah } }] },
            'Заметки': { rich_text: [{ text: { content: combinedNotes } }] }
          }
        })
      });
    } else {
      await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          parent: { database_id: NOTION_VISITS_DB_ID },
          properties: {
            'Визит': { title: [{ text: { content: `${guestName || 'Гость'} — ${today}` } }] },
            'Гость': { relation: [{ id: guestId }] },
            'Дата': { date: { start: today } },
            'Кальян': { rich_text: [{ text: { content: hookah } }] },
            'Заметки': { rich_text: [{ text: { content: notes || '' } }] }
          }
        })
      });
      await cleanupOldVisits(guestId, 3);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save visit' });
  }
});

// ─── TELEGRAM WEBHOOK (бот для сотрудников) ────────

const WELCOME_TEXT =
  'Карточки гостей и визиты На Крыше.\n' +
  'Нажимай кнопку «Открыть», чтобы найти гостя, посмотреть карточку или добавить визит.';

app.post('/telegram-webhook', async (req, res) => {
  const update = req.body;
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: WELCOME_TEXT,
        reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: WEBAPP_URL } }]] }
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Staff Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
