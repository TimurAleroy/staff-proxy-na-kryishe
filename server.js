const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_GUESTS_DB_ID = '35173a7166368022bf60d76141cca681'; // Карточка Гостя
const NOTION_VISITS_DB_ID = 'f384e676a0d7477bb45a34707bcb0dff'; // Визиты
const NOTION_PROBLEMS_DB_ID = '88be90a6768e4c9da2819565e1a69f62'; // Проблемы
const NOTION_EVENTS_DB_ID = '35173a71663680999ebcf882ecea022d'; // Журнал Мероприятий
const NOTION_GENERAL_GUESTS_DB_ID = 'f25cd3eb7e8441f2ada6bdd20700c4d6'; // Общая база гостей (из гостевого мини-аппа)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STAFF_PIN = process.env.STAFF_PIN || '159500';
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const WEBAPP_URL = 'https://timuraleroy.github.io/na-kryishe-staff';
const PORT = process.env.PORT || 3000;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

// Приводим номер к единому виду для сравнения — только цифры, с ведущим +7
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '');
  digits = digits.replace(/^8/, '+7');
  if (digits.startsWith('7') && !digits.startsWith('+7')) digits = '+' + digits;
  if (!digits.startsWith('+')) digits = '+7' + digits.replace(/^\+?7?/, '');
  return digits;
}

// Обычный сотрудник ИЛИ администратор — оба PIN дают базовый доступ
function checkPin(req, res) {
  const pin = req.query.pin || req.body?.pin;
  if (pin !== STAFF_PIN && pin !== ADMIN_PIN) {
    res.status(401).json({ error: 'Неверный PIN-код' });
    return false;
  }
  return true;
}

// Только PIN администратора — для функций управляющего
function checkAdminPin(req, res) {
  const pin = req.query.pin || req.body?.pin;
  if (!ADMIN_PIN || pin !== ADMIN_PIN) {
    res.status(403).json({ error: 'Доступно только администратору' });
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
  const pin = req.body?.pin;
  if (pin === ADMIN_PIN && ADMIN_PIN) return res.json({ ok: true, role: 'admin' });
  if (pin === STAFF_PIN) return res.json({ ok: true, role: 'staff' });
  res.status(401).json({ error: 'Неверный PIN-код' });
});

// ─── ИМЕНИННИКИ СЕГОДНЯ ─────────────────────────────

app.get('/api/staff/birthdays', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Дата рождения', date: { is_not_empty: true } } })
    });
    const data = await r.json();
    const todayMonthDay = new Date().toISOString().slice(5, 10); // MM-DD

    const birthdays = (data.results || [])
      .filter(g => {
        const bday = g.properties['Дата рождения']?.date?.start;
        return bday && bday.slice(5, 10) === todayMonthDay;
      })
      .map(g => ({
        id: g.id,
        name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
        phone: g.properties['Телефон']?.phone_number || '',
        status: g.properties['Частота визитов']?.select?.name || ''
      }));

    res.json(birthdays);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch birthdays' });
  }
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
      name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
      phone: g.properties['Телефон']?.phone_number || ''
    }));
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── ПРОВЕРКА ОБЩЕЙ БАЗЫ (гостевой мини-апп) ────────
// Используется когда в "Карточке Гостя" никого не нашли — вдруг человек уже бронировал через эп

app.get('/api/staff/check-general', async (req, res) => {
  if (!checkPin(req, res)) return;
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_GENERAL_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Имя', title: { contains: name } } })
    });
    const data = await r.json();
    const results = (data.results || []).map(g => ({
      name: g.properties['Имя']?.title?.[0]?.plain_text || '',
      phone: g.properties['Телефон']?.phone_number || '',
      bookingsCount: g.properties['Количество броней']?.number || 0,
      source: g.properties['Источник']?.select?.name || ''
    }));
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Check failed' });
  }
});

// ─── ПОИСК ПО ТЕЛЕФОНУ (сразу по обеим базам) ──────
// Надёжнее поиска по имени — имя гость мог указать неточно, а номер уникален

app.get('/api/staff/search-by-phone', async (req, res) => {
  if (!checkPin(req, res)) return;
  const rawPhone = req.query.phone;
  if (!rawPhone) return res.status(400).json({ error: 'phone required' });
  const phone = normalizePhone(rawPhone);

  try {
    // 1. Ищем в "Карточке Гостя" — если найден, это самое ценное совпадение
    const cardRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Телефон', phone_number: { equals: phone } } })
    });
    const cardData = await cardRes.json();
    const cardMatch = cardData.results?.[0];

    if (cardMatch) {
      return res.json({
        inCardDb: true,
        id: cardMatch.id,
        name: cardMatch.properties['Имя Гостя']?.title?.[0]?.plain_text || ''
      });
    }

    // 2. Не найден в карточках — проверяем общую базу (брони через мини-апп)
    const genRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_GENERAL_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Телефон', phone_number: { equals: phone } } })
    });
    const genData = await genRes.json();
    const genMatch = genData.results?.[0];

    if (genMatch) {
      return res.json({
        inCardDb: false,
        inGeneralDb: true,
        name: genMatch.properties['Имя']?.title?.[0]?.plain_text || '',
        phone: genMatch.properties['Телефон']?.phone_number || phone,
        bookingsCount: genMatch.properties['Количество броней']?.number || 0
      });
    }

    res.json({ inCardDb: false, inGeneralDb: false });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Search by phone failed' });
  }
});

// Notion не умеет фильтровать телефон "оканчивается на" — выгружаем всех с телефоном
// постранично и сравниваем последние цифры на сервере
async function fetchAllWithPhone(dbId) {
  let all = [];
  let cursor = undefined;
  do {
    const body = {
      filter: { property: 'Телефон', phone_number: { is_not_empty: true } },
      page_size: 100
    };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify(body)
    });
    const data = await r.json();
    all = all.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor && all.length < 500); // разумный предел на всякий случай
  return all;
}

// ─── ПОИСК ПО ПОСЛЕДНИМ 4 ЦИФРАМ (сразу по обеим базам) ──

app.get('/api/staff/search-last4', async (req, res) => {
  if (!checkPin(req, res)) return;
  const digits = (req.query.digits || '').replace(/\D/g, '');
  if (digits.length !== 4) return res.status(400).json({ error: 'нужно ровно 4 цифры' });

  try {
    const [cardGuests, generalGuests] = await Promise.all([
      fetchAllWithPhone(NOTION_GUESTS_DB_ID),
      fetchAllWithPhone(NOTION_GENERAL_GUESTS_DB_ID)
    ]);

    const matches = [];

    for (const g of cardGuests) {
      const phone = g.properties['Телефон']?.phone_number || '';
      if (phone.replace(/\D/g, '').endsWith(digits)) {
        matches.push({
          source: 'card',
          id: g.id,
          name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
          phone
        });
      }
    }

    for (const g of generalGuests) {
      const phone = g.properties['Телефон']?.phone_number || '';
      if (phone.replace(/\D/g, '').endsWith(digits)) {
        // Не дублируем если уже есть карточка с таким же номером
        const alreadyInCard = matches.some(m => m.source === 'card' && m.phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));
        if (!alreadyInCard) {
          matches.push({
            source: 'general',
            name: g.properties['Имя']?.title?.[0]?.plain_text || '',
            phone,
            bookingsCount: g.properties['Количество броней']?.number || 0
          });
        }
      }
    }

    res.json(matches);
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

// ─── АДМИН: ОТКРЫТЫЕ ПРОБЛЕМЫ ───────────────────────

app.get('/api/admin/problems', async (req, res) => {
  if (!checkAdminPin(req, res)) return;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_PROBLEMS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { or: [
          { property: 'Статус', select: { equals: 'Задачи' } },
          { property: 'Статус', select: { equals: 'В работе' } }
        ]},
        sorts: [{ property: 'Дата отзыва', direction: 'descending' }]
      })
    });
    const data = await r.json();
    const problems = (data.results || []).map(p => {
      const props = p.properties;
      return {
        id: p.id,
        category: props['Категория']?.select?.name || '',
        score: props['Оценка гостя']?.number ?? null,
        comment: props['Комментарий гостя']?.rich_text?.[0]?.plain_text || '',
        responsible: props['Ответственный']?.rich_text?.[0]?.plain_text || '',
        deadline: props['Срок исполнения']?.date?.start || '',
        status: props['Статус']?.select?.name || ''
      };
    });
    res.json(problems);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

// ─── АДМИН: МЕРОПРИЯТИЯ (просмотр + добавление) ────

app.get('/api/admin/events', async (req, res) => {
  if (!checkAdminPin(req, res)) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_EVENTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Дата', date: { on_or_after: today } },
        sorts: [{ property: 'Дата', direction: 'ascending' }]
      })
    });
    const data = await r.json();
    const events = (data.results || []).map(e => ({
      id: e.id,
      name: e.properties['Название']?.title?.[0]?.plain_text || '',
      format: e.properties['Формат']?.select?.name || '',
      date: e.properties['Дата']?.date?.start || ''
    }));
    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/admin/events', async (req, res) => {
  if (!checkAdminPin(req, res)) return;
  const { name, format, date } = req.body;
  if (!name || !format || !date) return res.status(400).json({ error: 'name, format and date required' });

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_EVENTS_DB_ID },
        properties: {
          'Название': { title: [{ text: { content: name } }] },
          'Формат': { select: { name: format } },
          'Дата': { date: { start: date } }
        }
      })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// ─── АДМИН: СТАТИСТИКА (CSI/NPS, eNPS, визиты) ─────

const CSI_SHEETS_ID = '1SOKanELXstuJ0W75fsWpbmYRibk-mWkHLF5XHz4KHYc';
const ENPS_SHEETS_ID = '1nKMCWGXsdQ-3KgMeFtPkIlmKlim4Ae6YFT-jEnZnLwY';

function parseCsv(text) {
  return text.trim().split('\n').map(line => {
    // простой CSV-парсер с поддержкой кавычек
    const cells = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  });
}

async function fetchSheetCsv(sheetId, sheetName) {
  const url = sheetName
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const text = await r.text();
  return parseCsv(text);
}

function isThisMonth(dateStr) {
  if (!dateStr) return false;
  // пробуем распознать DD.MM.YYYY или YYYY-MM-DD с временем
  let d = null;
  const dmy = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const ymd = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dmy) d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
  else if (ymd) d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  if (!d || isNaN(d)) return false;
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function avg(nums) {
  const valid = nums.filter(n => !isNaN(n));
  if (!valid.length) return null;
  return +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1);
}

app.get('/api/admin/stats', async (req, res) => {
  if (!checkAdminPin(req, res)) return;

  const result = {
    month: new Date().toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }),
    csi: null,
    enps: null,
    visits: null
  };

  // ── CSI + NPS гостей ──
  try {
    const rows = await fetchSheetCsv(CSI_SHEETS_ID);
    const dataRows = rows.slice(1).filter(r => isThisMonth(r[0]));
    if (dataRows.length) {
      const col = i => dataRows.map(r => parseFloat(r[i]));
      const nps = col(6).filter(n => !isNaN(n));
      const promoters = nps.filter(n => n >= 9).length;
      const detractors = nps.filter(n => n <= 6).length;
      const npsScore = nps.length ? Math.round(((promoters - detractors) / nps.length) * 100) : null;

      result.csi = {
        count: dataRows.length,
        vecher: avg(col(1)),
        kalyan: avg(col(2)),
        napitki: avg(col(3)),
        eda: avg(col(4)),
        komanda: avg(col(5)),
        nps: npsScore
      };
    }
  } catch (e) { console.error('CSI fetch failed:', e); }

  // ── eNPS сотрудников ──
  try {
    const rows = await fetchSheetCsv(ENPS_SHEETS_ID, 'enps');
    const dataRows = rows.slice(1).filter(r => isThisMonth(r[0]));
    if (dataRows.length) {
      const scores = dataRows.map(r => parseFloat(r[1])).filter(n => !isNaN(n));
      const promoters = scores.filter(n => n >= 9).length;
      const detractors = scores.filter(n => n <= 6).length;
      const enpsScore = scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : null;

      result.enps = {
        count: dataRows.length,
        score: enpsScore,
        promoters,
        passives: scores.length - promoters - detractors,
        detractors
      };
    }
  } catch (e) { console.error('eNPS fetch failed:', e); }

  // ── Визиты за месяц из Notion ──
  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_VISITS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Дата', date: { on_or_after: monthStart } },
        page_size: 100
      })
    });
    const data = await r.json();
    const visits = data.results || [];

    const guestCounts = {};
    const hookahCounts = {};
    for (const v of visits) {
      const guestRelId = v.properties['Гость']?.relation?.[0]?.id;
      if (guestRelId) guestCounts[guestRelId] = (guestCounts[guestRelId] || 0) + 1;
      const hookah = v.properties['Кальян']?.rich_text?.[0]?.plain_text;
      if (hookah) hookahCounts[hookah] = (hookahCounts[hookah] || 0) + 1;
    }

    const topHookah = Object.entries(hookahCounts).sort((a, b) => b[1] - a[1])[0];

    result.visits = {
      total: visits.length,
      uniqueGuests: Object.keys(guestCounts).length,
      topHookah: topHookah ? topHookah[0] : null
    };
  } catch (e) { console.error('Visits stats failed:', e); }

  res.json(result);
});

app.get('/', (req, res) => {
  res.send('Staff Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
