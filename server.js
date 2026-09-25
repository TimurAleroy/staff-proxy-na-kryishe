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
const NOTION_REVIEWS_DB_ID = '994a20a76308436683487de6593747fb'; // Отзывы CSI (заполняется гостевым приложением)
const NOTION_ENPS_DB_ID = 'bb06232232d44950842790033109f8ba'; // Отзывы eNPS — полностью анонимно, без привязки к сотруднику
const NOTION_EVENTS_DB_ID = '35173a71663680999ebcf882ecea022d'; // Журнал Мероприятий
const NOTION_GENERAL_GUESTS_DB_ID = 'f25cd3eb7e8441f2ada6bdd20700c4d6'; // Общая база гостей (из гостевого мини-аппа)
const NOTION_EMPLOYEES_DB_ID = '56fb72e9a9244998828c1d8d3cb9b381'; // Сотрудники — именные PIN-коды
const NOTION_SCHEDULE_DB_ID = '34d1765f8cd64ed0abc3838096a22066'; // График смен — замена Supershift
const NOTION_MENU_DB_ID = '4640c3e50a71422e8d61830c060f52c8'; // Меню — тот же источник, что и в гостевом приложении
const NOTION_TASKS_DB_ID = '2d474599285842179e7bd99d9b8e3207'; // Задачи — отдельный простой задачник от основателя
const NOTION_NOTES_DB_ID = 'd83da7a092194dcb80c3f1732acc902e'; // Заметки — быстрые записи админа/основателя вместо бумажек

// "Основатель" — роль-надстройка над "Администратор": видит и может всё то же самое
// в десктопном интерфейсе, плюс дополнительно может ставить задачи (см. /api/founder/*
// ниже). Везде, где раньше проверялась именно роль "Администратор" для прав, теперь
// проверяем через isAdminRole(), чтобы основатель automatически получал тот же доступ.
const ADMIN_ROLES = ['Администратор', 'Основатель'];
function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

// Кто может снимать/возвращать позицию своей категории с "В наличии".
// Администратор (и Основатель) — всегда, независимо от категории.
const MENU_CATEGORY_EDIT_ROLE = {
  'Напитки': 'Бармен',
  'Коктейли': 'Бармен',
  'Алкоголь': 'Бармен',
  'Еда': 'Повар',
  'Кальян': 'КМ'
};
function canEditMenuCategory(employeeRole, category) {
  return isAdminRole(employeeRole) || MENU_CATEGORY_EDIT_ROLE[category] === employeeRole;
}
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '188483198';
const WEBAPP_URL = 'https://timuraleroy.github.io/na-kryishe-staff';
const PORT = process.env.PORT || 3000;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

// Сервер (Railway) работает по UTC, а заведение — по владикавказскому времени (UTC+3, без перевода часов).
// Простое new Date().toISOString() примерно 3 часа в сутки (00:00–03:00 по-местному) даёт "вчера" вместо "сегодня".
// Эти хелперы всегда возвращают дату/время именно по Владикавказу.
const VENUE_TZ = 'Europe/Moscow'; // тот же часовой пояс, что и Владикавказ

function venueDateStr(date = new Date()) {
  // Возвращает "YYYY-MM-DD" по местному времени заведения
  return new Intl.DateTimeFormat('en-CA', { timeZone: VENUE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function venueMonthDay(date = new Date()) {
  // "MM-DD" — для сравнения дней рождения
  return venueDateStr(date).slice(5, 10);
}
function venueHour(date = new Date()) {
  // Час по местному времени заведения (0–23)
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: VENUE_TZ, hour: '2-digit', hour12: false }).format(date)) % 24;
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Часы, в которые можно писать гостям, из переменной вида "12-22" (с 12:00 до 22:00)
function hoursWindow(envValue, defFrom, defTo) {
  const m = String(envValue || '').match(/^(\d{1,2})-(\d{1,2})$/);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : { from: defFrom, to: defTo };
}
function inHoursWindow(win, date = new Date()) {
  const h = venueHour(date);
  return h >= win.from && h < win.to;
}
function venueTimeStr(date = new Date()) {
  // Человекочитаемое время для сообщений в Telegram
  return date.toLocaleString('ru-RU', { timeZone: VENUE_TZ, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' });
}

// Приводим номер к единому виду для сравнения — только цифры, с ведущим +7
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '');
  digits = digits.replace(/^8/, '+7');
  if (digits.startsWith('7') && !digits.startsWith('+7')) digits = '+' + digits;
  if (!digits.startsWith('+')) digits = '+7' + digits.replace(/^\+?7?/, '');
  return digits;
}

// ─── ЗАГРУЗКА ИЗ NOTION БЕЗ ЛИМИТА В 100 СТРОК ─────
// Notion отдаёт максимум 100 строк за один запрос. Раньше большинство запросов
// брали только первую сотню — пока данных мало, это незаметно, но после открытия
// визитов/гостей/отзывов быстро становится больше, и списки со статистикой начинали
// молча врать. Эта функция догружает все страницы по курсору.
// На 429 (Notion просит притормозить — не больше ~3 запросов в секунду) ждём и повторяем.
// maxRows — предохранитель на случай ошибки в фильтре, чтобы не выгрузить бесконечно много.
async function notionQueryAll(dbId, body = {}, maxRows = 50000) {
  let results = [];
  let cursor;
  do {
    const payload = { ...body, page_size: 100 };
    if (cursor) payload.start_cursor = cursor;

    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify(payload)
      });
      if (r.status !== 429) break;
      const waitSec = Number(r.headers.get('retry-after')) || 1;
      await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Notion query ${dbId} failed: ${r.status} ${text.slice(0, 200)}`);
    }

    const data = await r.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor && results.length < maxRows);
  return results;
}

// Короткий кэш в памяти для тяжёлых выборок (статистика, все гости).
// Одновременные запросы с одним ключом ждут одну и ту же загрузку, а не дёргают Notion дважды.
const memoCache = new Map();
async function memo(key, ttlMs, loader) {
  const entry = memoCache.get(key);
  if (entry && entry.pending) return entry.pending;
  if (entry && Date.now() - entry.at < ttlMs) return entry.value;
  const pending = loader()
    .then(value => { memoCache.set(key, { value, at: Date.now() }); return value; })
    .catch(err => { memoCache.delete(key); throw err; });
  memoCache.set(key, { ...(entry || {}), pending });
  return pending;
}
function forgetMemo(prefix) {
  for (const key of memoCache.keys()) if (key.startsWith(prefix)) memoCache.delete(key);
}

// ─── ВСЕ ВИЗИТЫ В ПАМЯТИ ────────────────────────────
// Нужны «Давно не было», таблице гостей и статистике: последний визит каждого гостя
// и визиты за период. Читать всю базу «Визиты» на каждый запрос — медленно (каждые
// 100 визитов = отдельный запрос в Notion), поэтому держим её копию в памяти:
// — один раз читаем целиком (при старте сервера и потом раз в 6 часов — чтобы
//   подхватить визиты, удалённые руками прямо в Notion);
// — между этим не чаще раза в минуту догружаем только изменённое/новое
//   (фильтр по last_edited_time — Notion округляет его до минуты, поэтому берём с запасом).
const visitsStore = { byId: new Map(), lastSyncISO: null, fullAt: 0, checkedAt: 0, pending: null };
// Отметка у визита: просили ли гостя оценить вечер через гостевого бота (см. processReviewRequests)
const REVIEW_REQUEST_PROP = 'Запрос отзыва';
const VISITS_REFRESH_MS = 60 * 1000;
const VISITS_FULL_RELOAD_MS = 6 * 60 * 60 * 1000;

function toVisitRecord(page) {
  const p = page.properties;
  return {
    id: page.id,
    guestId: p['Гость']?.relation?.[0]?.id || null,
    date: p['Дата']?.date?.start || null,
    hookah: p['Кальян']?.rich_text?.[0]?.plain_text || '',
    createdAt: page.created_time || null,
    reviewRequest: p[REVIEW_REQUEST_PROP]?.select?.name || ''
  };
}

async function syncVisits() {
  const now = Date.now();
  const full = !visitsStore.fullAt || now - visitsStore.fullAt > VISITS_FULL_RELOAD_MS;
  if (!full && now - visitsStore.checkedAt < VISITS_REFRESH_MS) return;
  if (visitsStore.pending) return visitsStore.pending;

  visitsStore.pending = (async () => {
    const syncStartISO = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    if (full) {
      const pages = await notionQueryAll(NOTION_VISITS_DB_ID, {});
      const byId = new Map();
      for (const page of pages) byId.set(page.id, toVisitRecord(page));
      visitsStore.byId = byId;
      visitsStore.fullAt = Date.now();
    } else {
      const pages = await notionQueryAll(NOTION_VISITS_DB_ID, {
        filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: visitsStore.lastSyncISO } }
      });
      for (const page of pages) visitsStore.byId.set(page.id, toVisitRecord(page));
    }
    visitsStore.lastSyncISO = syncStartISO;
    visitsStore.checkedAt = Date.now();
  })().finally(() => { visitsStore.pending = null; });

  return visitsStore.pending;
}

async function getAllVisits() {
  await syncVisits();
  return [...visitsStore.byId.values()];
}

// Последний визит каждого гостя: { guestId: 'YYYY-MM-DD' }
function lastVisitByGuestMap(visits) {
  const map = {};
  for (const v of visits) {
    if (!v.guestId || !v.date) continue;
    const day = v.date.slice(0, 10);
    if (!map[v.guestId] || day > map[v.guestId]) map[v.guestId] = day;
  }
  return map;
}

function daysSinceDate(dateStr) {
  if (!dateStr) return null;
  const today = new Date(venueDateStr() + 'T00:00:00Z');
  const then = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  return Math.round((today - then) / (1000 * 60 * 60 * 24));
}

// Автотег «ДР»: сегодня / скоро (в ближайшие 7 дней) / был недавно (последние 7 дней).
// Считается по местной дате заведения. Родившихся 29 февраля в невисокосный год
// поздравляем 1 марта.
const BIRTHDAY_WINDOW_DAYS = 7;
function birthdayInfo(birthdayStr, todayStr = venueDateStr()) {
  if (!birthdayStr) return null;
  const mmdd = birthdayStr.slice(5, 10);
  const today = new Date(todayStr + 'T00:00:00Z');
  const year = today.getUTCFullYear();
  const at = y => {
    const d = new Date(`${y}-${mmdd}T00:00:00Z`);
    return isNaN(d) ? new Date(`${y}-03-01T00:00:00Z`) : d;
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates = [at(year - 1), at(year), at(year + 1)];
  let best = null;
  for (const d of candidates) {
    const diff = Math.round((d - today) / dayMs); // >0 — впереди, <0 — прошёл
    if (best === null || Math.abs(diff) < Math.abs(best)) best = diff;
  }
  if (best === 0) return { when: 'today', days: 0 };
  if (best > 0 && best <= BIRTHDAY_WINDOW_DAYS) return { when: 'soon', days: best };
  if (best < 0 && -best <= BIRTHDAY_WINDOW_DAYS) return { when: 'recent', days: -best };
  return null;
}

// ─── ИМЕННЫЕ СОТРУДНИКИ (кэш в памяти, обновляется раз в 5 минут) ──
// Вместо общего PIN на всех — у каждого сотрудника свой код в базе "Сотрудники".
// Уволили/поменяли роль/PIN — просто правим строку в Notion, код обновится сам,
// максимум через EMPLOYEES_CACHE_TTL (короткий, чтобы правки применялись почти сразу,
// а не заставляли ждать по 5 минут после смены PIN).

let employeesCache = [];
let employeesCacheTime = 0;
const EMPLOYEES_CACHE_TTL = 15 * 1000; // 15 секунд

async function refreshEmployees() {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_EMPLOYEES_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Активен', checkbox: { equals: true } } })
    });
    const data = await r.json();
    employeesCache = (data.results || [])
      .map(e => ({
        id: e.id,
        name: e.properties['Имя']?.title?.[0]?.plain_text || '',
        pin: e.properties['PIN']?.rich_text?.[0]?.plain_text || '',
        role: e.properties['Роль']?.select?.name || '',
        telegramId: e.properties['Telegram ID']?.rich_text?.[0]?.plain_text || ''
      }))
      .filter(e => e.pin); // без PIN сотрудник не может войти
    employeesCacheTime = Date.now();
  } catch (err) {
    console.error('Не удалось обновить список сотрудников:', err);
  }
}

async function ensureEmployeesFresh() {
  if (Date.now() - employeesCacheTime > EMPLOYEES_CACHE_TTL) {
    await refreshEmployees();
  }
}

function findEmployeeByPin(pin) {
  return employeesCache.find(e => e.pin === pin);
}

// Любой активный сотрудник — базовый доступ
async function checkPin(req, res) {
  await ensureEmployeesFresh();
  const pin = req.query.pin || req.body?.pin;
  const employee = findEmployeeByPin(pin);
  if (!employee) {
    res.status(401).json({ error: 'Неверный PIN-код' });
    return false;
  }
  req.employee = employee;
  return true;
}

// Роль "Администратор" или "Основатель" — функции управляющего
async function checkAdminPin(req, res) {
  await ensureEmployeesFresh();
  const pin = req.query.pin || req.body?.pin;
  const employee = findEmployeeByPin(pin);
  if (!employee || !isAdminRole(employee.role)) {
    res.status(403).json({ error: 'Доступно только администратору' });
    return false;
  }
  req.employee = employee;
  return true;
}

refreshEmployees(); // загружаем список сразу при старте сервера
setInterval(refreshEmployees, EMPLOYEES_CACHE_TTL);

// ─── НАПОМИНАНИЯ О ПРОСРОЧЕННЫХ ПРОБЛЕМАХ ──────────
// Раз в несколько часов проверяем "В работе" с истёкшим сроком — шлём
// ответственному (по роли) и админу. Не чаще одного раза в день на проблему.

const remindedToday = new Set(); // "problemId_YYYY-MM-DD"

async function checkOverdueProblems() {
  try {
    await ensureEmployeesFresh();
    const today = venueDateStr();
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_PROBLEMS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Статус', select: { equals: 'В работе' } },
            { property: 'Срок исполнения', date: { before: today } }
          ]
        }
      })
    });
    const data = await r.json();

    for (const page of data.results || []) {
      const key = `${page.id}_${today}`;
      if (remindedToday.has(key)) continue;

      const props = page.properties;
      const title = props['Проблема']?.title?.[0]?.plain_text || 'Проблема';
      const responsibleRole = props['Ответственный']?.rich_text?.[0]?.plain_text || '';
      const deadline = props['Срок исполнения']?.date?.start || '';

      const text = `⏰ Просрочена проблема: «${title}»\nОтветственный: ${responsibleRole}\nСрок был: ${deadline}\n\nПожалуйста, закройте или обновите срок.`;

      // Шлём каждому активному сотруднику с нужной ролью, у кого есть Telegram ID
      const responsibleEmployees = employeesCache.filter(e => e.role === responsibleRole);
      for (const emp of responsibleEmployees) {
        if (emp.telegramId) await sendTelegramMessage(emp.telegramId, text);
      }
      await sendTelegramMessage(ADMIN_CHAT_ID, text);

      remindedToday.add(key);
    }
  } catch (err) {
    console.error('Overdue problems check failed:', err);
  }
}

setInterval(checkOverdueProblems, 6 * 60 * 60 * 1000); // каждые 6 часов
setTimeout(checkOverdueProblems, 30 * 1000); // и один раз вскоре после старта сервера

// То же самое, но для отдельного задачника основателя — просроченным считается
// незавершённая задача (Готово=false) со сроком раньше сегодняшнего дня.
// Срок необязателен, поэтому задачи без срока сюда никогда не попадают.
const remindedTasksToday = new Set(); // "taskId_YYYY-MM-DD"

async function checkOverdueFounderTasks() {
  try {
    const today = venueDateStr();
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_TASKS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Готово', checkbox: { equals: false } },
            { property: 'Срок', date: { before: today } }
          ]
        }
      })
    });
    const data = await r.json();

    for (const page of data.results || []) {
      const key = `${page.id}_${today}`;
      if (remindedTasksToday.has(key)) continue;

      const props = page.properties;
      const title = props['Задача']?.title?.[0]?.plain_text || 'Задача';
      const deadline = props['Срок']?.date?.start || '';

      await sendTelegramMessage(ADMIN_CHAT_ID, `⏰ Просрочена задача: «${title}»\nСрок был: ${deadline}\n\nОтметьте готовой или обновите срок в приложении.`);
      remindedTasksToday.add(key);
    }
  } catch (err) {
    console.error('Overdue founder tasks check failed:', err);
  }
}

setInterval(checkOverdueFounderTasks, 6 * 60 * 60 * 1000); // каждые 6 часов
setTimeout(checkOverdueFounderTasks, 30 * 1000); // и один раз вскоре после старта сервера

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

async function sendTelegramMessage(chatId, text) {
  return tgApi('sendMessage', { chat_id: chatId, text });
}

// ─── ПРОВЕРКА PIN ──────────────────────────────────

app.post('/api/staff/login', async (req, res) => {
  await ensureEmployeesFresh();
  const pin = req.body?.pin;
  const employee = findEmployeeByPin(pin);
  if (!employee) return res.status(401).json({ error: 'Неверный PIN-код' });

  const isAdmin = isAdminRole(employee.role);
  res.json({ ok: true, role: isAdmin ? 'admin' : 'staff', name: employee.name, jobRole: employee.role });
});

// ─── ИМЕНИННИКИ СЕГОДНЯ ─────────────────────────────

app.get('/api/staff/birthdays', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  try {
    // Все гости с датой рождения (не только первые 100). Список меняется редко — кэш на 10 минут.
    const guestsWithBirthday = await memo('guests-with-birthday', 10 * 60 * 1000, () =>
      notionQueryAll(NOTION_GUESTS_DB_ID, { filter: { property: 'Дата рождения', date: { is_not_empty: true } } })
    );
    const todayMonthDay = venueMonthDay(); // MM-DD, по местному времени

    const birthdays = guestsWithBirthday
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

// ─── ГОСТИ ПО СТАТУСУ (например все VIP) ────────────

app.get('/api/staff/guests-by-status', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const status = req.query.status;
  if (!status) return res.status(400).json({ error: 'status required' });

  try {
    const pages = await notionQueryAll(NOTION_GUESTS_DB_ID, {
      filter: { property: 'Частота визитов', select: { equals: status } },
      sorts: [{ property: 'Имя Гостя', direction: 'ascending' }]
    });
    const guests = pages.map(g => ({
      id: g.id,
      name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
      phone: g.properties['Телефон']?.phone_number || ''
    }));
    res.json(guests);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch guests by status' });
  }
});

// ─── ГОСТИ, КОТОРЫХ ДАВНО НЕ БЫЛО (30+ дней) ────────

app.get('/api/staff/inactive-guests', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const thresholdDays = 30;

  try {
    // Берём только VIP и Постоянных — для "Редких" отсутствие визитов не сигнал
    const guests = await notionQueryAll(NOTION_GUESTS_DB_ID, {
      filter: { or: [
        { property: 'Частота визитов', select: { equals: 'VIP' } },
        { property: 'Частота визитов', select: { equals: 'Постоянный' } }
      ]}
    });

    // Последний визит считаем по ВСЕМ визитам (копия базы в памяти), а не по последним 100:
    // иначе постоянный гость, чей визит не попал в последнюю сотню по всему бару,
    // выглядел бы как «ни разу не был» и ложно попадал в «Давно не было».
    const lastVisitByGuest = lastVisitByGuestMap(await getAllVisits());

    const inactive = [];
    for (const g of guests) {
      const lastVisit = lastVisitByGuest[g.id];
      const daysSince = daysSinceDate(lastVisit); // null — визитов вообще не было записано

      if (daysSince === null || daysSince >= thresholdDays) {
        inactive.push({
          id: g.id,
          name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
          phone: g.properties['Телефон']?.phone_number || '',
          status: g.properties['Частота визитов']?.select?.name || '',
          lastVisit: lastVisit || null,
          daysSince
        });
      }
    }

    inactive.sort((a, b) => (b.daysSince || 999) - (a.daysSince || 999));
    res.json(inactive);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch inactive guests' });
  }
});

// ─── БЫСТРАЯ ЗАМЕТКА О ПРОБЛЕМЕ (от любого сотрудника) ──

app.post('/api/staff/problem', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { category, comment, severity } = req.body;
  if (!category || !comment) return res.status(400).json({ error: 'category and comment required' });

  const responsibleRole = CATEGORY_ROLE_MAP[category] || 'Администратор';
  const finalSeverity = severity || 'Средняя';

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_PROBLEMS_DB_ID },
        properties: {
          'Проблема': { title: [{ text: { content: `${category} — сообщено сотрудником` } }] },
          'Категория': { select: { name: category } },
          'Комментарий гостя': { rich_text: [{ text: { content: comment } }] },
          'Дата отзыва': { date: { start: venueDateStr() } },
          'Статус': { select: { name: 'Задачи' } },
          'Критичность': { select: { name: finalSeverity } },
          'Ответственный': { rich_text: [{ text: { content: responsibleRole } }] },
          'Срок исполнения': { date: { start: defaultDeadline(finalSeverity) } }
        }
      })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create problem' });
  }
});

// ─── ЧЕК-ЛИСТ СМЕНЫ (админ) ─────────────────────────

app.post('/api/staff/checklist-complete', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { type, items } = req.body; // type: 'Открытие' | 'Закрытие'
  const employee = req.employee; // теперь известно кто именно заполнил, из PIN

  const time = venueTimeStr();
  const itemsList = (items || []).map(i => `✓ ${i}`).join('\n');

  await sendTelegramMessage(
    ADMIN_CHAT_ID,
    `📋 Чек-лист «${employee.role} · ${type}» выполнен — ${employee.name} — ${time}\n\n${itemsList}`
  );
  res.json({ ok: true });
});

// ─── ПОИСК ГОСТЯ ───────────────────────────────────

app.get('/api/staff/search', async (req, res) => {
  if (!(await checkPin(req, res))) return;
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
  if (!(await checkPin(req, res))) return;
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
  if (!(await checkPin(req, res))) return;
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
// Раньше здесь был предел в 500 гостей — после 500-го гостя поиск по 4 цифрам
// перестал бы находить новых. Теперь выгружаются все.
async function fetchAllWithPhone(dbId) {
  return notionQueryAll(dbId, {
    filter: { property: 'Телефон', phone_number: { is_not_empty: true } }
  });
}

// ─── ПОИСК ПО ПОСЛЕДНИМ 4 ЦИФРАМ (сразу по обеим базам) ──

app.get('/api/staff/search-last4', async (req, res) => {
  if (!(await checkPin(req, res))) return;
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
  if (!(await checkPin(req, res))) return;
  try {
    const guestRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const guest = await guestRes.json();
    const props = guest.properties;

    const phone = props['Телефон']?.phone_number || '';
    const status = props['Частота визитов']?.select?.name || '';

    // Вся история визитов гостя (визиты больше не удаляются) — нужна и для списка
    // "последние визиты", и для расчёта риска оттока, и для подсчёта частоты кальянов
    // (любимая позиция). Раньше бралось максимум 50.
    const visitPages = await notionQueryAll(NOTION_VISITS_DB_ID, {
      filter: { property: 'Гость', relation: { contains: req.params.id } },
      sorts: [{ property: 'Дата', direction: 'descending' }]
    });
    const allVisits = visitPages.map(v => {
      const vp = v.properties;
      return {
        date: vp['Дата']?.date?.start || '',
        hookah: vp['Кальян']?.rich_text?.[0]?.plain_text || '',
        notes: vp['Заметки']?.rich_text?.[0]?.plain_text || ''
      };
    });
    const visits = allVisits.slice(0, 5);

    // ── Автотег «Риск оттока» — та же формула, что в /api/admin/guests-table ──
    const lastVisitDate = allVisits[0]?.date || null;
    const daysSince = lastVisitDate
      ? Math.floor((new Date() - new Date(lastVisitDate)) / (1000 * 60 * 60 * 24))
      : null;
    const atRisk = (status === 'VIP' || status === 'Постоянный') && (daysSince === null || daysSince >= 30);

    // ── Автотег «Негативный отзыв» — связи Отзывы→Гость нет, ищем по телефону ──
    let negativeReview = null;
    if (phone) {
      try {
        const revRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_REVIEWS_DB_ID}/query`, {
          method: 'POST',
          headers: NOTION_HEADERS,
          body: JSON.stringify({
            filter: { property: 'Телефон', phone_number: { equals: phone } },
            sorts: [{ property: 'Дата', direction: 'descending' }],
            page_size: 10
          })
        });
        const revData = await revRes.json();
        const cats = ['Вечер', 'Кальян', 'Напитки', 'Еда', 'Команда'];
        for (const r of (revData.results || [])) {
          const rp = r.properties;
          let worst = null, worstCat = null;
          for (const c of cats) {
            const v = rp[c]?.number;
            if (typeof v === 'number' && v <= 3 && (worst === null || v < worst)) { worst = v; worstCat = c; }
          }
          if (worst !== null) {
            negativeReview = { date: rp['Дата']?.date?.start || '', category: worstCat, score: worst };
            break; // самый свежий негативный отзыв — этого достаточно для пометки
          }
        }
      } catch (e) { console.error('Negative review check failed:', e); }
    }

    // ── Любимая позиция — самый частый вкус кальяна среди всех визитов ──
    const hookahCounts = {};
    let visitsWithHookah = 0;
    for (const v of allVisits) {
      const flavor = (v.hookah || '').trim();
      if (!flavor) continue;
      visitsWithHookah++;
      const key = flavor.toLowerCase();
      if (!hookahCounts[key]) hookahCounts[key] = { name: flavor, count: 0 };
      hookahCounts[key].count++;
    }
    const topHookah = Object.values(hookahCounts).sort((a, b) => b.count - a.count)[0] || null;

    res.json({
      id: guest.id,
      name: props['Имя Гостя']?.title?.[0]?.plain_text || '',
      status,
      birthday: props['Дата рождения']?.date?.start || null,
      phone,
      important: props['Что важно для гостя']?.rich_text?.[0]?.plain_text || '',
      tagsSpecial: (props['Теги (особые)']?.multi_select || []).map(o => o.name),
      tagsAllergy: (props['Теги (аллергии)']?.multi_select || []).map(o => o.name),
      tastesLike: (props['Вкусы (любит)']?.multi_select || []).map(o => o.name),
      tastesDislike: (props['Вкусы (не любит)']?.multi_select || []).map(o => o.name),
      autoTags: { atRisk, daysSince, negativeReview, birthday: birthdayInfo(props['Дата рождения']?.date?.start) },
      favorites: { hookah: topHookah, visitsWithHookah, totalVisits: allVisits.length },
      history: readHistory(guest).slice(0, 30),
      visits
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch guest' });
  }
});

// ─── ФОТО ГОСТЯ ИЗ TELEGRAM ─────────────────────────
// В "Карточке Гостя" (CRM) Telegram ID не хранится — его пишет гостевой мини-апп
// в "Общую базу гостей" при бронировании/заполнении профиля. Поэтому сначала находим
// гостя там же по телефону, а дальше — обычный Bot API: getUserProfilePhotos → getFile.
// Ссылка от Telegram живёт около часа, поэтому недолго кэшируем её в памяти,
// чтобы не дёргать Bot API на каждое открытие одной и той же карточки подряд.

const guestPhotoCache = new Map(); // telegramId -> { url, expiresAt }
const GUEST_PHOTO_FOUND_TTL = 5 * 60 * 1000;  // 5 минут — чтобы смена аватарки в Telegram быстро подхватывалась
const GUEST_PHOTO_EMPTY_TTL = 30 * 60 * 1000; // 30 минут — если фото нет вообще, не дёргаем Bot API так часто

async function fetchTelegramPhotoUrl(telegramId, force) {
  if (!telegramId || !TELEGRAM_BOT_TOKEN) return null;

  const cached = guestPhotoCache.get(telegramId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.url;

  const photos = await tgApi('getUserProfilePhotos', { user_id: telegramId, limit: 1 });
  const firstSet = photos?.result?.photos?.[0];
  if (!firstSet || !firstSet.length) {
    guestPhotoCache.set(telegramId, { url: null, expiresAt: Date.now() + GUEST_PHOTO_EMPTY_TTL });
    return null;
  }

  const fileId = firstSet[firstSet.length - 1].file_id; // последний элемент — самый крупный размер
  const fileInfo = await tgApi('getFile', { file_id: fileId });
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) return null;

  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  guestPhotoCache.set(telegramId, { url, expiresAt: Date.now() + GUEST_PHOTO_FOUND_TTL });
  return url;
}

app.get('/api/staff/guest/:id/photo', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  try {
    const guestRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const guest = await guestRes.json();
    const phone = guest.properties?.['Телефон']?.phone_number || '';
    if (!phone) return res.json({ photoUrl: null });

    const genRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_GENERAL_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ filter: { property: 'Телефон', phone_number: { equals: normalizePhone(phone) } } })
    });
    const genData = await genRes.json();
    const telegramId = genData.results?.[0]?.properties?.['Telegram ID']?.rich_text?.[0]?.plain_text || null;
    if (!telegramId) return res.json({ photoUrl: null });

    const photoUrl = await fetchTelegramPhotoUrl(telegramId, req.query.force === '1');
    res.json({ photoUrl });
  } catch (error) {
    console.error('Guest photo fetch failed:', error);
    res.json({ photoUrl: null }); // не критично — карточка просто останется с инициалами
  }
});

// ─── РЕДАКТИРОВАНИЕ КАРТОЧКИ ───────────────────────

app.patch('/api/staff/guest/:id', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { field, value } = req.body;

  const FIELD_PROPERTY = {
    status: 'Частота визитов',
    birthday: 'Дата рождения',
    phone: 'Телефон',
    important: 'Что важно для гостя'
  };
  if (!FIELD_PROPERTY[field]) return res.status(400).json({ error: 'unknown field' });

  // Статус VIP ставит и снимает только Администратор/Основатель.
  // Между «Редкий» и «Постоянный» переключать может любой сотрудник.
  if (field === 'status' && value === 'VIP' && !isAdminRole(req.employee.role)) {
    return res.status(403).json({ error: 'Статус VIP может ставить только администратор' });
  }

  // Сначала читаем карточку — нужно старое значение (проверка VIP и запись в историю)
  let page;
  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    if (!pageRes.ok) throw new Error(`read guest ${pageRes.status}`);
    page = await pageRes.json();
  } catch (e) {
    console.error('Guest read failed:', e);
    return res.status(502).json({ error: 'Не удалось прочитать карточку гостя' });
  }
  const oldProps = page.properties || {};

  if (field === 'status' && !isAdminRole(req.employee.role) && oldProps['Частота визитов']?.select?.name === 'VIP') {
    return res.status(403).json({ error: 'Снять статус VIP может только администратор' });
  }

  const properties = {};
  let historyText = null;
  if (field === 'status') {
    const before = oldProps['Частота визитов']?.select?.name || '—';
    properties['Частота визитов'] = { select: { name: value } };
    if (before !== value) historyText = `статус: ${before} → ${value}`;
  } else if (field === 'birthday') {
    const before = oldProps['Дата рождения']?.date?.start || '—';
    properties['Дата рождения'] = value ? { date: { start: value } } : { date: null };
    if (before !== (value || '—')) historyText = `день рождения: ${before} → ${value || '—'}`;
  } else if (field === 'phone') {
    const before = oldProps['Телефон']?.phone_number || '';
    properties['Телефон'] = { phone_number: value || null };
    if (before !== (value || '')) historyText = before ? 'телефон изменён' : 'добавлен телефон';
  } else if (field === 'important') {
    const before = (oldProps['Что важно для гостя']?.rich_text || []).map(t => t.plain_text || '').join('');
    properties['Что важно для гостя'] = { rich_text: [{ text: { content: value || '' } }] };
    if (before !== (value || '')) historyText = '«Что важно для гостя» изменено';
  }

  if (historyText && await ensureHistoryColumn()) {
    properties[HISTORY_PROP] = withHistory(page, req.employee, [historyText]);
  }

  try {
    const upRes = await patchGuestPage(req.params.id, properties);
    if (!upRes.ok) {
      console.error('Guest update failed:', await upRes.text());
      return res.status(502).json({ error: 'Notion update failed' });
    }
    if (field === 'birthday') forgetMemo('guests-with-birthday'); // чтобы именинник сразу попал в список
    forgetMemo('cards-with-phone'); // и брони сразу показали новые данные гостя
    forgetMemo('marketing');
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── РУЧНЫЕ ТЕГИ — добавление и удаление по одному ──
// Группы: особые, аллергии и «Табак / вкусы» (что гость любит и что не любит —
// чтобы любой кальянный мастер, даже новый, сразу знал, что предлагать, а что нет).

const TAG_GROUP_PROPERTY = {
  special: 'Теги (особые)',
  allergy: 'Теги (аллергии)',
  tasteLike: 'Вкусы (любит)',
  tasteDislike: 'Вкусы (не любит)'
};

// ─── НЕДОСТАЮЩИЕ КОЛОНКИ В NOTION СЕРВЕР СОЗДАЁТ САМ ──
// Новые функции хранят данные в новых колонках (вкусы, история изменений,
// отметка «Запрос отзыва» у визита). Чтобы не нужно было ничего добавлять в Notion
// руками, сервер при старте проверяет базы и дописывает недостающие колонки.
// Если не вышло (например, у интеграции нет прав менять структуру базы) — функции,
// которым нужна колонка, честно отвечают ошибкой, остальное работает как раньше.
const ensuredColumns = new Set();
async function ensureColumns(dbId, columns) {
  const key = dbId + ':' + Object.keys(columns).join('|');
  if (ensuredColumns.has(key)) return true;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: NOTION_HEADERS });
    if (!r.ok) throw new Error(`read schema ${r.status}`);
    const dbInfo = await r.json();
    // колонка с таким именем есть, но другого типа — писать в неё нельзя
    const wrongType = Object.keys(columns).filter(name => {
      const existing = dbInfo.properties?.[name];
      return existing && existing.type && !(existing.type in columns[name]);
    });
    if (wrongType.length) throw new Error(`колонки другого типа: ${wrongType.join(', ')}`);
    const missing = Object.keys(columns).filter(name => !dbInfo.properties?.[name]);
    if (missing.length) {
      const properties = {};
      for (const name of missing) properties[name] = columns[name];
      const up = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ properties })
      });
      if (!up.ok) throw new Error(`create columns ${up.status}: ${(await up.text()).slice(0, 200)}`);
      console.log(`Созданы колонки в базе ${dbId}:`, missing.join(', '));
    }
    ensuredColumns.add(key);
    return true;
  } catch (e) {
    console.error(`Не удалось проверить/создать колонки (${Object.keys(columns).join(', ')}):`, e.message);
    return false;
  }
}
// Запись в колонку не прошла (колонку переименовали/удалили руками) — при следующем
// обращении проверяем структуру базы заново, а не верим запомненному «всё есть».
function forgetEnsuredColumns(dbId) {
  for (const key of ensuredColumns) if (key.startsWith(dbId + ':')) ensuredColumns.delete(key);
}

const HISTORY_PROP = 'История изменений';
// Вкусы и история проверяются отдельно: если с колонкой истории что-то не так,
// теги вкусов всё равно работают (и наоборот).
function ensureGuestTagColumns() {
  return ensureColumns(NOTION_GUESTS_DB_ID, {
    'Вкусы (любит)': { multi_select: { options: [] } },
    'Вкусы (не любит)': { multi_select: { options: [] } }
  });
}
function ensureHistoryColumn() {
  return ensureColumns(NOTION_GUESTS_DB_ID, { [HISTORY_PROP]: { rich_text: {} } });
}

// Изменение карточки + строка истории одним запросом. История — дополнительная:
// если Notion не принял её (колонку переименовали, другой тип и т.п.), само изменение
// всё равно сохраняем вторым запросом, без истории, — как было до её появления.
async function patchGuestPage(pageId, properties) {
  const send = props => fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: NOTION_HEADERS,
    body: JSON.stringify({ properties: props })
  });
  let r = await send(properties);
  if (!r.ok && r.status === 400 && properties[HISTORY_PROP]) {
    console.error('История изменений не записалась, сохраняю без неё:', (await r.text().catch(() => '')).slice(0, 200));
    forgetEnsuredColumns(NOTION_GUESTS_DB_ID);
    const { [HISTORY_PROP]: _skip, ...rest } = properties;
    r = await send(rest);
  }
  return r;
}

// ─── ИСТОРИЯ ИЗМЕНЕНИЙ КАРТОЧКИ ─────────────────────
// Кто и когда менял статус, теги, ДР, телефон, «Что важно». Хранится в самой
// карточке, в колонке «История изменений»: самые свежие строки сверху, до 100 строк.
// Notion отдаёт у текстовой колонки только первые 25 кусков текста, поэтому строки
// складываются в куски до 1900 символов — так влезает вся история.
const HISTORY_MAX_LINES = 100;
function readHistory(page) {
  const text = (page?.properties?.[HISTORY_PROP]?.rich_text || []).map(t => t.plain_text || t.text?.content || '').join('');
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}
function historyLine(employee, text) {
  const when = new Date().toLocaleString('ru-RU', { timeZone: VENUE_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  const who = employee ? `${employee.name || 'Сотрудник'}${employee.role ? ` (${employee.role})` : ''}` : 'Система';
  return `${when} · ${who}: ${text}`;
}
function historyProperty(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines.slice(0, HISTORY_MAX_LINES)) {
    const piece = line.slice(0, 1800);
    if (current && current.length + piece.length + 1 > 1900) { chunks.push(current); current = ''; }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  // перевод строки между кусками, чтобы при склейке строки не слипались
  return { rich_text: chunks.map((c, i) => ({ text: { content: i < chunks.length - 1 ? c + '\n' : c } })) };
}
function withHistory(page, employee, texts) {
  const lines = [...texts.map(t => historyLine(employee, t)), ...readHistory(page)];
  return historyProperty(lines);
}

// Теги, которые по сути — статус гостя. Как и статус VIP, их меняет только
// Администратор/Основатель. Сравнение без учёта регистра и пробелов по краям.
// Тот же список — в na-kryishe-staff (ADMIN_ONLY_TAGS), держать одинаковыми.
const ADMIN_ONLY_TAGS = ['VIP', 'Знаменитость', 'Нон-грата'];
function isAdminOnlyTag(name) {
  const n = String(name || '').trim().toLowerCase();
  return ADMIN_ONLY_TAGS.some(t => t.toLowerCase() === n);
}

app.post('/api/staff/guest/:id/tag', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { group, tag, action } = req.body;
  const propName = TAG_GROUP_PROPERTY[group];
  // Notion не разрешает запятые в названии тега
  const tagName = (tag || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  if (!propName || !tagName || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'bad request' });
  }

  // Теги-статусы (знаменитость, нон-грата и т.п.) ставит и снимает только администрация —
  // как VIP-статус. Остальные «особые» («Не любит шум», «Не беспокоить», «Постоянный столик»),
  // аллергии и вкусы — любой сотрудник: это сервисные заметки, их должен отметить тот, кто узнал.
  if (group === 'special' && isAdminOnlyTag(tagName) && !isAdminRole(req.employee.role)) {
    return res.status(403).json({ error: `Тег «${tagName}» может ставить и снимать только администратор` });
  }

  const isTaste = group === 'tasteLike' || group === 'tasteDislike';
  if (isTaste && !(await ensureGuestTagColumns())) {
    return res.status(502).json({ error: 'В базе «Карточка Гостя» нет колонок для вкусов, и создать их не получилось — проверь доступ интеграции к базе' });
  }

  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    if (!pageRes.ok) return res.status(502).json({ error: 'Failed to read guest' });
    const page = await pageRes.json();
    const current = (page.properties[propName]?.multi_select || []).map(o => o.name);

    const next = action === 'add'
      ? (current.includes(tagName) ? current : [...current, tagName])
      : current.filter(t => t !== tagName);

    const properties = { [propName]: { multi_select: next.map(name => ({ name })) } };
    const changed = action === 'add' ? !current.includes(tagName) : current.includes(tagName);
    let historyLines = null;
    if (changed && await ensureHistoryColumn()) {
      const groupLabel = { special: 'особые', allergy: 'аллергии', tasteLike: 'любит', tasteDislike: 'не любит' }[group];
      historyLines = [historyLine(req.employee, `${action === 'add' ? 'добавлен' : 'убран'} тег «${tagName}» (${groupLabel})`), ...readHistory(page)].slice(0, HISTORY_MAX_LINES);
      properties[HISTORY_PROP] = historyProperty(historyLines);
    }

    const upRes = await patchGuestPage(req.params.id, properties);
    if (!upRes.ok) {
      console.error('Tag update failed:', await upRes.text());
      return res.status(502).json({ error: 'Notion update failed' });
    }

    forgetMemo('cards-with-phone'); // брони сразу покажут новые теги
    forgetMemo('marketing');
    const saved = await upRes.json().catch(() => null);
    const historySaved = historyLines && saved?.properties?.[HISTORY_PROP];
    res.json({ ok: true, tags: next, ...(historySaved ? { history: historyLines.slice(0, 30) } : {}) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update tag' });
  }
});

// ─── НОВЫЙ ГОСТЬ ────────────────────────────────────

app.post('/api/staff/guest', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { name, status, birthday, phone, important } = req.body;
  if (!name || !status) return res.status(400).json({ error: 'name and status required' });

  const properties = {
    'Имя Гостя': { title: [{ text: { content: name } }] },
    'Частота визитов': { select: { name: status } },
    'Что важно для гостя': { rich_text: [{ text: { content: important || '' } }] }
  };
  if (birthday) properties['Дата рождения'] = { date: { start: birthday } };
  if (phone) properties['Телефон'] = { phone_number: phone };
  if (await ensureHistoryColumn()) {
    properties[HISTORY_PROP] = historyProperty([historyLine(req.employee, `карточка создана (статус: ${status})`)]);
  }

  try {
    const create = props => fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: NOTION_GUESTS_DB_ID }, properties: props })
    });
    let r = await create(properties);
    if (!r.ok && r.status === 400 && properties[HISTORY_PROP]) {
      console.error('История не записалась при создании карточки, создаю без неё:', (await r.text().catch(() => '')).slice(0, 200));
      forgetEnsuredColumns(NOTION_GUESTS_DB_ID);
      const { [HISTORY_PROP]: _skip, ...rest } = properties;
      r = await create(rest);
    }
    if (!r.ok) {
      console.error('Create guest failed:', (await r.text().catch(() => '')).slice(0, 300));
      return res.status(502).json({ error: 'Не удалось создать карточку в Notion' });
    }
    const created = await r.json();

    // Дублируем контакт в общую базу гостей — чтобы она была полным списком, а не только "кто бронировал через эп"
    if (phone) {
      const normPhone = normalizePhone(phone);
      try {
        const checkRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_GENERAL_GUESTS_DB_ID}/query`, {
          method: 'POST',
          headers: NOTION_HEADERS,
          body: JSON.stringify({ filter: { property: 'Телефон', phone_number: { equals: normPhone } } })
        });
        const checkData = await checkRes.json();

        if (!checkData.results?.length) {
          const genProps = {
            'Имя': { title: [{ text: { content: name } }] },
            'Телефон': { phone_number: normPhone },
            'Источник': { select: { name: 'Персонал' } },
            'Дата первого контакта': { date: { start: venueDateStr() } },
            'Количество броней': { number: 0 },
            'Перенесён в Карточку Гостя': { checkbox: true }
          };
          if (birthday) genProps['Дата рождения'] = { date: { start: birthday } };

          await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: NOTION_HEADERS,
            body: JSON.stringify({ parent: { database_id: NOTION_GENERAL_GUESTS_DB_ID }, properties: genProps })
          });
        } else {
          // Уже был в общей базе (например бронировал раньше) — просто отмечаем что теперь у него есть карточка
          await fetch(`https://api.notion.com/v1/pages/${checkData.results[0].id}`, {
            method: 'PATCH',
            headers: NOTION_HEADERS,
            body: JSON.stringify({ properties: { 'Перенесён в Карточку Гостя': { checkbox: true } } })
          });
        }
      } catch (syncError) {
        console.error('Sync to general DB failed (non-fatal):', syncError);
      }
    }

    if (birthday) forgetMemo('guests-with-birthday');
    forgetMemo('cards-with-phone');
    forgetMemo('marketing');
    res.json({ ok: true, id: created.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create guest' });
  }
});

// ─── ДОБАВИТЬ / ДОПОЛНИТЬ ВИЗИТ ─────────────────────
// Визиты хранятся все. Раньше при каждом новом визите у гостя удалялось всё, кроме
// 5 последних, — из-за этого пропадала история для аналитики и сравнения периодов.

app.post('/api/staff/visit', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { guestId, guestName, hookah, notes } = req.body;
  if (!guestId || !hookah) return res.status(400).json({ error: 'guestId and hookah required' });

  const today = venueDateStr();

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
    }

    // Новый/изменённый визит — копия визитов в памяти догрузит его при следующем обращении,
    // а кэш статистики сбрасываем, чтобы цифры обновились сразу.
    visitsStore.checkedAt = 0;
    forgetMemo('stats');

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

const ENPS_WELCOME_TEXT =
  'Оцени нас — анонимно, займёт минуту.\n' +
  'Нажимай кнопку «Открыть», чтобы пройти опрос.';

app.post('/telegram-webhook', async (req, res) => {
  const update = req.body;
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || '';

      // QR-код на служебном помещении ведёт на t.me/<bot>?start=enps — Telegram
      // присылает это как "/start enps". Открываем мини-апп сразу на опросе,
      // внутри Telegram (без видимого URL в браузере), а не как обычную ссылку.
      const isEnpsStart = /^\/start\s+enps\b/.test(text);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: isEnpsStart ? ENPS_WELCOME_TEXT : WELCOME_TEXT,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Открыть', web_app: { url: isEnpsStart ? `${WEBAPP_URL}?enps=1` : WEBAPP_URL } }
          ]]
        }
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
  res.sendStatus(200);
});

// ─── АДМИН: ОТКРЫТЫЕ ПРОБЛЕМЫ ───────────────────────

// Кто по умолчанию отвечает за проблему по категории
// Всё по умолчанию падает на администратора — он сам направляет конкретному
// ответственному через кнопку "Назначить" в приложении (endpoint /reassign ниже)
const CATEGORY_ROLE_MAP = {
  'Кальян': 'Администратор',
  'Напитки': 'Администратор',
  'Еда': 'Администратор',
  'Команда': 'Администратор',
  'Общее': 'Администратор'
};
const ASSIGNABLE_ROLES = ['КМ', 'Бармен', 'Повар', 'Официант', 'Администратор'];

function defaultDeadline(severity) {
  const days = severity === 'Высокая' ? 3 : 7;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return venueDateStr(d);
}

// Список проблем — теперь доступен всем сотрудникам (не только админу), чтобы
// ответственный по категории тоже видел и мог взять в работу свою проблему
app.get('/api/staff/problems', async (req, res) => {
  if (!(await checkPin(req, res))) return;
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
        status: props['Статус']?.select?.name || '',
        severity: props['Критичность']?.select?.name || '',
        rootCause: props['Корневая причина']?.rich_text?.[0]?.plain_text || ''
      };
    });
    res.json(problems);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
});

// Перевод "Задачи" → "В работе" — обязательно с коренной причиной.
// Разрешено только ответственному по категории (по его роли) или администратору.
app.post('/api/staff/problem/:id/take', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const rootCause = (req.body?.rootCause || '').trim();
  const deadline = (req.body?.deadline || '').trim();
  if (!rootCause) return res.status(400).json({ error: 'Нужно указать коренную причину, прежде чем взять в работу' });
  if (!deadline) return res.status(400).json({ error: 'Нужно указать срок исполнения, прежде чем взять в работу' });

  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const page = await pageRes.json();
    const responsible = page.properties['Ответственный']?.rich_text?.[0]?.plain_text || '';
    const employee = req.employee;

    if (!isAdminRole(employee.role) && employee.role !== responsible) {
      return res.status(403).json({ error: `Взять в работу может только «${responsible}» или администратор` });
    }

    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        properties: {
          'Статус': { select: { name: 'В работе' } },
          'Корневая причина': { rich_text: [{ text: { content: rootCause } }] },
          'Срок исполнения': { date: { start: deadline } }
        }
      })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update problem' });
  }
});

// Перевод "В работе" → "Решена" — та же проверка прав
app.post('/api/staff/problem/:id/resolve', async (req, res) => {
  if (!(await checkPin(req, res))) return;

  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const page = await pageRes.json();
    const responsible = page.properties['Ответственный']?.rich_text?.[0]?.plain_text || '';
    const employee = req.employee;

    if (!isAdminRole(employee.role) && employee.role !== responsible) {
      return res.status(403).json({ error: `Закрыть может только «${responsible}» или администратор` });
    }

    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties: { 'Статус': { select: { name: 'Решена' } } } })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to resolve problem' });
  }
});

// Назначить конкретного ответственного по роли — только администратор
app.post('/api/staff/problem/:id/reassign', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const role = (req.body?.role || '').trim();
  const deadline = (req.body?.deadline || '').trim();
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Неизвестная роль' });
  }

  const properties = { 'Ответственный': { rich_text: [{ text: { content: role } }] } };
  if (deadline) properties['Срок исполнения'] = { date: { start: deadline } };

  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to reassign problem' });
  }
});

// Отдаём список ролей клиенту, чтобы не дублировать его в двух местах
app.get('/api/staff/assignable-roles', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  res.json(ASSIGNABLE_ROLES);
});

// ─── ОСНОВАТЕЛЬ: ЗАДАЧИ АДМИНУ ───────────────────────
// Простой отдельный задачник — своя база "Задачи" в Notion (NOTION_TASKS_DB_ID),
// никак не связанная с "Проблемы". Никаких категорий/приоритетов/промежуточных
// статусов — только текст задачи, необязательный срок и галочка "Готово".
// В десктопном интерфейсе админа показывается отдельным блоком.

// Поставить задачу может только сама роль "Основатель" — это её единственная
// дополнительная возможность сверх обычного администратора.
app.post('/api/founder/task', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const employee = req.employee;
  if (employee.role !== 'Основатель') {
    return res.status(403).json({ error: 'Ставить задачи может только основатель' });
  }

  const text = (req.body?.text || '').trim();
  const deadline = (req.body?.deadline || '').trim();
  if (!text) return res.status(400).json({ error: 'Укажите текст задачи' });

  const properties = {
    'Задача': { title: [{ text: { content: text } }] },
    'Готово': { checkbox: false },
    'Создано': { date: { start: venueDateStr() } }
  };
  if (deadline) properties['Срок'] = { date: { start: deadline } };

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: NOTION_TASKS_DB_ID }, properties })
    });
    await sendTelegramMessage(ADMIN_CHAT_ID, `📌 Новая задача: «${text}»${deadline ? `\nСрок: ${deadline}` : ''}`);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create founder task' });
  }
});

// Список задач — по умолчанию незавершённые; ?done=1 отдаёт выполненные
// (для раздела "Показать выполненные" на экране — чтобы было видно, что
// задача не потерялась, а реально закрыта). Видно администратору и основателю.
app.get('/api/admin/founder-tasks', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const wantDone = req.query.done === '1' || req.query.done === 'true';
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_TASKS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Готово', checkbox: { equals: wantDone } },
        sorts: [{ property: 'Создано', direction: 'descending' }],
        page_size: wantDone ? 20 : undefined // выполненных не грузим все подряд — только последние
      })
    });
    const data = await r.json();
    const tasks = (data.results || []).map(p => {
      const props = p.properties;
      return {
        id: p.id,
        text: props['Задача']?.title?.[0]?.plain_text || '',
        done: props['Готово']?.checkbox || false,
        deadline: props['Срок']?.date?.start || ''
      };
    });
    res.json(tasks);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch founder tasks' });
  }
});

// Отметить готово / вернуть в работу — просто переключатель галочки "Готово".
// Доступно и администратору, и основателю.
app.post('/api/founder/task/:id/done', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const done = req.body?.done !== false; // по умолчанию true — отметить готовой
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties: { 'Готово': { checkbox: done } } })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update founder task' });
  }
});

// ─── ЗАМЕТКИ — быстрые записи админа/основателя вместо бумажек ─────
// Своя база "Заметки" в Notion (NOTION_NOTES_DB_ID), никак не связана с
// "Задачи"/"Проблемы". Только текст и автор — никаких статусов/сроков,
// это буквально стикер: записал — потом сам стёр, когда разобрался.
// Видно и доступно и администратору, и основателю (isAdminRole), в
// отличие от "Задачи" (там ставить может только основатель) — любой
// админ на смене может быстро что-то себе черкнуть.

app.post('/api/admin/note', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const employee = req.employee;
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Укажите текст заметки' });

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_NOTES_DB_ID },
        properties: {
          'Текст': { title: [{ text: { content: text } }] },
          'Автор': { rich_text: [{ text: { content: employee.name || '' } }] }
        }
      })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Последние заметки, самые новые — сверху. Сортируем по встроенному
// времени создания страницы в Notion — своего отдельного поля с датой
// заводить не нужно (в отличие от "Задачи", где важен был "Срок").
app.get('/api/admin/notes', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_NOTES_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 30
      })
    });
    const data = await r.json();
    const notes = (data.results || []).map(p => ({
      id: p.id,
      text: p.properties['Текст']?.title?.[0]?.plain_text || '',
      author: p.properties['Автор']?.rich_text?.[0]?.plain_text || ''
    }));
    res.json(notes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Удалить заметку (архивируем в Notion — их аналог удаления) — разобрались,
// записали куда нужно или сделали — стираем стикер.
app.delete('/api/admin/note/:id', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ archived: true })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// ─── eNPS ОТ СОТРУДНИКОВ — АНОНИМНО ─────────────────
// PIN проверяется только чтобы подтвердить что это реальный сотрудник —
// само имя/PIN/роль нигде не сохраняется вместе с ответом, только оценка и текст.

app.post('/api/staff/enps-review', async (req, res) => {
  if (!(await checkPin(req, res))) return; // подтверждаем сотрудника, но req.employee дальше не используем

  const score = Number(req.body?.score);
  const liked = (req.body?.liked || '').trim();
  const improve = (req.body?.improve || '').trim();

  if (!Number.isFinite(score) || score < 0 || score > 10) {
    return res.status(400).json({ error: 'Некорректная оценка' });
  }
  if (!liked) {
    return res.status(400).json({ error: 'Напиши что тебе нравится в работе здесь' });
  }
  if (!improve) {
    return res.status(400).json({ error: 'Напиши что можно улучшить' });
  }

  try {
    const today = venueDateStr();
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_ENPS_DB_ID },
        properties: {
          'Запись': { title: [{ text: { content: `eNPS — ${today}` } }] },
          'Дата': { date: { start: today } },
          'Оценка': { number: score },
          'Что нравится': { rich_text: [{ text: { content: liked } }] },
          'Что улучшить': { rich_text: [{ text: { content: improve } }] }
        }
      })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save eNPS review' });
  }
});


app.get('/api/admin/problems', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
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
  if (!(await checkAdminPin(req, res))) return;
  try {
    const today = venueDateStr();
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
      date: e.properties['Дата']?.date?.start || '',
      description: e.properties['Описание']?.rich_text?.[0]?.plain_text || ''
    }));
    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/admin/events', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { name, format, date, description } = req.body;
  if (!name || !format || !date) return res.status(400).json({ error: 'name, format and date required' });

  try {
    const properties = {
      'Название': { title: [{ text: { content: name } }] },
      'Формат': { select: { name: format } },
      'Дата': { date: { start: date } }
    };
    if (description) properties['Описание'] = { rich_text: [{ text: { content: description } }] };

    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: NOTION_EVENTS_DB_ID }, properties })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Редактировать мероприятие — чтобы никто не заходил в Notion, всё через приложение
app.patch('/api/admin/events/:id', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { name, format, date, description } = req.body;

  const properties = {};
  if (name !== undefined) properties['Название'] = { title: [{ text: { content: name } }] };
  if (format !== undefined) properties['Формат'] = { select: { name: format } };
  if (date !== undefined) properties['Дата'] = { date: { start: date } };
  if (description !== undefined) properties['Описание'] = { rich_text: [{ text: { content: description } }] };

  if (!Object.keys(properties).length) return res.status(400).json({ error: 'Нечего обновлять' });

  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Удалить мероприятие (архивируем в Notion — это их аналог удаления)
app.delete('/api/admin/events/:id', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ archived: true })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ─── БРОНИ (единый список — из бота и с сайта) ──────
// Отдельной базы броней нет: каждая бронь — запись в текстовом поле
// «История броней» гостя в общей базе контактов (та же, что использует бот
// бронирования и сайт). Формат записи:
// "ISO-дата|текст|тип|uid|гостей|комментарий" + суффикс " (подтверждено)" / " (отменено)".
//
// Подтверждение/отмена/перенос сами по себе пишутся не здесь, а в
// notion-proxy-na-kryishe (у него бот, которым можно написать гостю) — этот
// файл только читает общий источник и, когда админ жмёт кнопку в панели,
// просит notion-proxy выполнить действие через внутренний эндпоинт
// (см. callGuestProxy ниже). Так гость получает то же автосообщение,
// что и при подтверждении через кнопку в Telegram, откуда бы админ ни нажал.

function stripBookingSuffix(raw) {
  return raw.replace(' (подтверждено)', '').replace(' (отменено)', '');
}
function parseBookingEntry(raw) {
  const clean = stripBookingSuffix(raw);
  const parts = clean.split('|');
  if (parts.length === 1) {
    return { iso: null, display: parts[0], kind: 'table', uid: null, guests: null, comment: '', table: '' };
  }
  return {
    iso: parts[0] || null,
    display: parts[1] || '',
    kind: parts[2] || 'table',
    uid: parts[3] || null,
    guests: parts[4] ? (Number(parts[4]) || null) : null,
    comment: parts[5] || '',
    // Физический стол, назначенный брони персоналом — 7-е поле; у записей без
    // назначенного стола (или у старых, ещё до этой возможности) — просто ''.
    table: parts[6] || ''
  };
}
function isBookingExpired(iso) {
  if (!iso) return true; // старые записи без даты считаем прошедшими
  return iso.slice(0, 10) < venueDateStr();
}

// Видит только администратор.
app.get('/api/staff/bookings', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    let allResults = [];
    let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_GENERAL_GUESTS_DB_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify(body)
      });
      if (!r.ok) return res.status(502).json({ error: 'Notion query failed' });
      const data = await r.json();
      allResults = allResults.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const bookings = [];
    for (const page of allResults) {
      const props = page.properties;
      const name = props['Имя']?.title?.[0]?.plain_text || 'Гость';
      const phone = props['Телефон']?.phone_number || '';
      const history = props['История броней']?.rich_text?.[0]?.plain_text || '';
      if (!history) continue;

      const entries = history.split(',').map(s => s.trim()).filter(Boolean);
      for (const raw of entries) {
        if (raw.includes('(отменено)')) continue;
        const confirmed = raw.includes('(подтверждено)');
        const { iso, display, kind, guests, comment, table } = parseBookingEntry(raw);
        if (isBookingExpired(iso)) continue;

        let kindLabel = 'Стол';
        let eventName = null;
        if (kind === 'vip') kindLabel = 'VIP-комната';
        else if (kind && kind.startsWith('event:')) { kindLabel = 'Мероприятие'; eventName = kind.slice(6); }

        // entry — стрипнутая (без суффикса) исходная запись, ей же панель ссылается
        // на конкретную бронь при подтверждении/отмене/переносе — как опаковый токен.
        bookings.push({
          name, phone, iso, display, guests, comment, table,
          status: confirmed ? 'confirmed' : 'pending',
          kind: kindLabel, eventName,
          entry: stripBookingSuffix(raw)
        });
      }
    }

    // Теги гостя прямо в брони: хостес/админ ещё до прихода видит аллергии, VIP,
    // особые пометки, вкусы и скорый ДР. Бронь — из общей базы гостевого приложения,
    // теги — в «Карточке Гостя»; связываем по телефону.
    try {
      const cards = await memo('cards-with-phone', 2 * 60 * 1000, () => fetchAllWithPhone(NOTION_GUESTS_DB_ID));
      const byPhone = {};
      for (const c of cards) {
        const cp = c.properties;
        const key = normalizePhone(cp['Телефон']?.phone_number || '');
        if (!key || byPhone[key]) continue;
        byPhone[key] = {
          cardId: c.id,
          status: cp['Частота визитов']?.select?.name || '',
          tagsSpecial: (cp['Теги (особые)']?.multi_select || []).map(o => o.name),
          tagsAllergy: (cp['Теги (аллергии)']?.multi_select || []).map(o => o.name),
          tastesLike: (cp['Вкусы (любит)']?.multi_select || []).map(o => o.name),
          tastesDislike: (cp['Вкусы (не любит)']?.multi_select || []).map(o => o.name),
          important: cp['Что важно для гостя']?.rich_text?.[0]?.plain_text || '',
          birthdayRaw: cp['Дата рождения']?.date?.start || null
        };
      }
      for (const b of bookings) {
        const info = byPhone[normalizePhone(b.phone)];
        if (!info) continue;
        // ДР считаем относительно дня брони, а не сегодняшнего
        const { birthdayRaw, ...rest } = info;
        b.guestCard = { ...rest, birthday: birthdayInfo(birthdayRaw, (b.iso || '').slice(0, 10) || venueDateStr()) };
      }
    } catch (e) {
      console.error('Не удалось подтянуть теги гостей к броням:', e.message); // брони всё равно отдаём
    }

    bookings.sort((a, b) => (a.iso || '').localeCompare(b.iso || ''));
    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ─── ДЕЙСТВИЯ НАД БРОНЬЮ (подтвердить / отменить / перенести) ──
// Сам этот сервис в Notion для этих действий не пишет — просит сделать это
// notion-proxy-na-kryishe через внутренний эндпоинт (у него бот, которым можно
// написать гостю; у стаф-бота — другого — такой возможности нет).
// Несколько попыток на случай временной недоступности; если совсем не достучались —
// честно возвращаем ошибку, а не тихий "успех" без реального результата.

const GUEST_PROXY_BASE = process.env.GUEST_PROXY_BASE || 'https://notion-proxy-na-kryishe-production.up.railway.app';
const INTERNAL_ADMIN_KEY = process.env.INTERNAL_ADMIN_KEY;

// attempts = 1 — для рассылок и просьб об отзыве: повтор после обрыва связи
// мог бы прислать гостю одно и то же сообщение дважды.
async function callGuestProxy(path, payload, attempts = 3) {
  if (!INTERNAL_ADMIN_KEY) return { reached: false, reason: 'no_key' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${GUEST_PROXY_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_ADMIN_KEY },
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return { reached: true, ...data };
      if (r.status < 500) return { reached: true, httpError: r.status, ...data }; // не временная ошибка — ретраить бессмысленно
    } catch (e) {
      // сетевая проблема — пробуем ещё раз
    }
    if (i < attempts - 1) await new Promise(r2 => setTimeout(r2, 400 * (i + 1)));
  }
  return { reached: false, reason: 'unreachable' };
}

// Если entry, с которым панель ушла подтверждать/отменять/редактировать, уже
// не совпадает с тем, что реально лежит в Notion (например, кто-то параллельно
// назначил стол этой же брони — теперь это устранено блокировкой на стороне
// notion-proxy, но сеть есть сеть, и бронь могли успеть поменять между тем как
// список открыли и тем как нажали кнопку) — говорим об этом прямо, а не молчим
// "успехом", который на деле ничего не изменил.
function bookingActionErrorMessage(result) {
  if (result.error === 'booking not found') {
    return 'Эта бронь уже изменилась (например, кто-то назначил стол или сохранил другое время) — обновите список броней и попробуйте снова';
  }
  return 'Гость не найден';
}

app.post('/api/staff/bookings/confirm', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { phone, entry } = req.body;
  if (!phone || !entry) return res.status(400).json({ error: 'phone and entry required' });

  const result = await callGuestProxy('/api/internal/booking/confirm', { phone, entry });
  if (!result.reached) return res.status(502).json({ error: 'Не удалось выполнить действие, попробуйте ещё раз' });
  if (result.httpError === 404) return res.status(404).json({ error: bookingActionErrorMessage(result) });
  res.json({ ok: true, notified: !!result.notified });
});

app.post('/api/staff/bookings/cancel', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { phone, entry, message } = req.body;
  if (!phone || !entry) return res.status(400).json({ error: 'phone and entry required' });

  const result = await callGuestProxy('/api/internal/booking/cancel', { phone, entry, message });
  if (!result.reached) return res.status(502).json({ error: 'Не удалось выполнить действие, попробуйте ещё раз' });
  if (result.httpError === 404) return res.status(404).json({ error: bookingActionErrorMessage(result) });
  res.json({ ok: true, notified: !!result.notified });
});

app.post('/api/staff/bookings/edit', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { phone, entry, dateISO, time, guests, comment } = req.body;
  if (!phone || !entry || !dateISO || !time) {
    return res.status(400).json({ error: 'phone, entry, dateISO and time required' });
  }

  const result = await callGuestProxy('/api/internal/booking/edit', { phone, entry, dateISO, time, guests, comment });
  if (!result.reached) return res.status(502).json({ error: 'Не удалось выполнить действие, попробуйте ещё раз' });
  if (result.httpError === 404) return res.status(404).json({ error: bookingActionErrorMessage(result) });
  res.json({ ok: true, notified: !!result.notified, newEntry: result.newEntry, newDisplayText: result.newDisplayText });
});

// Внести бронь вручную (гость позвонил) — сразу подтверждённая, без похода
// гостя через мини-апп/бота. Источник в Notion помечается отдельно ("Телефон"),
// чтобы потом можно было посчитать долю броней по каналам.
app.post('/api/staff/bookings/add', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { name, phone, dateISO, time, guests, comment, table } = req.body;
  if (!name || !phone || !dateISO || !time) {
    return res.status(400).json({ error: 'Имя, телефон, дата и время обязательны' });
  }

  const result = await callGuestProxy('/api/internal/booking/create', { name, phone, dateISO, time, guests, comment, table });
  if (!result.reached) return res.status(502).json({ error: 'Не удалось выполнить действие, попробуйте ещё раз' });
  if (result.httpError) return res.status(result.httpError).json({ error: result.error || 'Не удалось создать бронь' });
  res.json({ ok: true, entry: result.entry, display: result.display });
});

// Назначить/сменить стол у брони — внутренняя пометка для персонала (не
// уведомляет гостя и не трогает статус подтверждения).
app.post('/api/staff/bookings/table', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { phone, entry, table } = req.body;
  if (!phone || !entry) return res.status(400).json({ error: 'phone and entry required' });

  const result = await callGuestProxy('/api/internal/booking/table', { phone, entry, table });
  if (!result.reached) return res.status(502).json({ error: 'Не удалось выполнить действие, попробуйте ещё раз' });
  if (result.httpError === 404) return res.status(404).json({ error: 'Бронь не найдена' });
  res.json({ ok: true, newEntry: result.newEntry });
});

// ─── ГРАФИК СМЕН (замена Supershift) ────────────────
// Видит весь график вся команда (кто с кем работает), а редактирует —
// только администратор. Одна запись = один сотрудник на одну дату.

// Список сотрудников — нужен всем, чтобы подписывать чужие смены в календаре,
// и админу отдельно — для выбора при назначении смены.
app.get('/api/staff/employees-list', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  await ensureEmployeesFresh();
  res.json(employeesCache.map(e => ({ id: e.id, name: e.name, role: e.role })));
});

// Смены за период (месяц для календаря) — вся команда видит всех.
app.get('/api/staff/schedule', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_SCHEDULE_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Дата', date: { on_or_after: from } },
            { property: 'Дата', date: { on_or_before: to } }
          ]
        },
        sorts: [{ property: 'Дата', direction: 'ascending' }]
      })
    });
    const data = await r.json();
    const shifts = (data.results || []).map(p => {
      const props = p.properties;
      return {
        id: p.id,
        employeeId: props['Сотрудник']?.relation?.[0]?.id || null,
        date: props['Дата']?.date?.start || '',
        status: props['Статус']?.select?.name || 'Работает',
        time: props['Время']?.rich_text?.[0]?.plain_text || '',
        note: props['Заметка']?.rich_text?.[0]?.plain_text || ''
      };
    });
    res.json(shifts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

// Создать/обновить смену — только администратор. Один сотрудник + одна дата = одна
// запись, при повторном сохранении просто обновляем её, а не плодим дубли.
app.post('/api/admin/schedule', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { employeeId, date, status, time, note } = req.body;
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date required' });

  await ensureEmployeesFresh();
  const employee = employeesCache.find(e => e.id === employeeId);
  const employeeName = employee?.name || 'Сотрудник';

  try {
    const properties = {
      'Запись': { title: [{ text: { content: `${employeeName} — ${date}` } }] },
      'Сотрудник': { relation: [{ id: employeeId }] },
      'Дата': { date: { start: date } },
      'Статус': { select: { name: status || 'Работает' } }
    };
    if (time !== undefined) properties['Время'] = { rich_text: time ? [{ text: { content: time } }] : [] };
    if (note !== undefined) properties['Заметка'] = { rich_text: note ? [{ text: { content: note } }] : [] };

    const existingRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_SCHEDULE_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Дата', date: { equals: date } },
            { property: 'Сотрудник', relation: { contains: employeeId } }
          ]
        }
      })
    });
    const existingData = await existingRes.json();
    if (!existingRes.ok) {
      console.error('Notion query failed (schedule):', existingData);
      return res.status(502).json({ error: existingData?.message || 'Notion отклонил запрос — проверь доступ интеграции к базе "График смен"' });
    }
    const existing = existingData.results?.[0];

    if (existing) {
      const patchRes = await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ properties })
      });
      const patchData = await patchRes.json();
      if (!patchRes.ok) {
        console.error('Notion update failed (schedule):', patchData);
        return res.status(502).json({ error: patchData?.message || 'Notion отклонил обновление смены' });
      }
      return res.json({ ok: true, id: existing.id });
    }

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ parent: { database_id: NOTION_SCHEDULE_DB_ID }, properties })
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      console.error('Notion create failed (schedule):', createData);
      return res.status(502).json({ error: createData?.message || 'Notion отклонил создание смены — проверь доступ интеграции к базе "График смен"' });
    }
    res.json({ ok: true, id: createData.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save shift' });
  }
});

// Удалить смену (сбросить день сотрудника обратно в пустое состояние) — только администратор
app.delete('/api/admin/schedule/:id', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    const patchRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ archived: true })
    });
    const patchData = await patchRes.json();
    if (!patchRes.ok) {
      console.error('Notion delete failed (schedule):', patchData);
      return res.status(502).json({ error: patchData?.message || 'Notion отклонил удаление смены' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

// ─── СТОП-ЛИСТ (снятие позиций меню "В наличии") ────
// Один и тот же источник, что у гостя в приложении — снял здесь, гость уже
// не видит позицию в меню. Смотреть могут все, менять — только тот, чья категория.

// Полный список меню (включая недоступное) — видят все залогиненные сотрудники
app.get('/api/staff/menu', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  try {
    // Всё меню целиком — если позиций больше 100, раньше хвост меню пропадал из стоп-листа
    let pages;
    try {
      pages = await notionQueryAll(NOTION_MENU_DB_ID, {
        sorts: [
          { property: 'Категория', direction: 'ascending' },
          { property: 'Подкатегория', direction: 'ascending' },
          { property: 'Порядок', direction: 'ascending' }
        ]
      });
    } catch (e) {
      console.error('Notion menu query failed:', e.message);
      return res.status(502).json({ error: 'Не удалось загрузить меню' });
    }
    const items = pages.map(p => {
      const props = p.properties;
      return {
        id: p.id,
        name: props['Название']?.title?.[0]?.plain_text || '',
        category: props['Категория']?.select?.name || '',
        subcategory: props['Подкатегория']?.select?.name || '',
        price: props['Цена']?.number ?? null,
        available: props['В наличии']?.checkbox === true
      };
    });
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// Переключить "В наличии" одной позиции — проверяем роль строго по категории
// ЭТОЙ позиции в Notion (не по тому, что прислал клиент), чтобы права нельзя
// было обойти подменой запроса.
app.patch('/api/staff/menu/:id', async (req, res) => {
  if (!(await checkPin(req, res))) return;
  const { available } = req.body;
  if (typeof available !== 'boolean') return res.status(400).json({ error: 'available (boolean) required' });

  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: NOTION_HEADERS });
    const page = await pageRes.json();
    if (!pageRes.ok) return res.status(404).json({ error: 'Позиция не найдена' });

    const category = page.properties?.['Категория']?.select?.name || '';
    if (!canEditMenuCategory(req.employee.role, category)) {
      return res.status(403).json({ error: `Эту категорию может менять только ${MENU_CATEGORY_EDIT_ROLE[category] || 'администратор'}` });
    }

    const patchRes = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties: { 'В наличии': { checkbox: available } } })
    });
    const patchData = await patchRes.json();
    if (!patchRes.ok) {
      console.error('Notion menu toggle failed:', patchData);
      return res.status(502).json({ error: 'Notion отклонил изменение' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

// ─── АДМИН: СТАТИСТИКА (CSI/NPS, eNPS, визиты) ─────
// CSI/NPS теперь читаются из Notion "Отзывы CSI" (см. NOTION_REVIEWS_DB_ID выше).
// eNPS пока остаётся в Google-таблице — её мы не трогали.

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
  if (!(await checkAdminPin(req, res))) return;

  const result = {
    month: new Date().toLocaleDateString('ru-RU', { timeZone: VENUE_TZ, month: 'long', year: 'numeric' }),
    csi: null,
    enps: null,
    visits: null
  };

  // Начало текущего месяца по местному времени заведения (сервер живёт по UTC).
  const monthStart = venueDateStr().slice(0, 8) + '01';

  // ── CSI + NPS гостей — из Notion "Отзывы CSI" ──
  // Все отзывы за месяц (раньше считались только первые 100).
  try {
    const reviews = await memo(`stats:reviews:${monthStart}`, 2 * 60 * 1000, () =>
      notionQueryAll(NOTION_REVIEWS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: monthStart } } })
    );

    if (reviews.length) {
      const col = (name) => reviews.map(p => p.properties[name]?.number).filter(n => typeof n === 'number');
      const nps = col('NPS');
      const promoters = nps.filter(n => n >= 9).length;
      const detractors = nps.filter(n => n <= 6).length;
      const npsScore = nps.length ? Math.round(((promoters - detractors) / nps.length) * 100) : null;

      result.csi = {
        count: reviews.length,
        vecher: avg(col('Вечер')),
        kalyan: avg(col('Кальян')),
        napitki: avg(col('Напитки')),
        eda: avg(col('Еда')),
        komanda: avg(col('Команда')),
        nps: npsScore
      };
    }
  } catch (e) { console.error('CSI fetch failed:', e); }

  // ── eNPS сотрудников — из Notion "Отзывы eNPS" (анонимно) ──
  try {
    const entries = await memo(`stats:enps:${monthStart}`, 2 * 60 * 1000, () =>
      notionQueryAll(NOTION_ENPS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: monthStart } } })
    );

    if (entries.length) {
      const scores = entries.map(p => p.properties['Оценка']?.number).filter(n => typeof n === 'number');
      const promoters = scores.filter(n => n >= 9).length;
      const detractors = scores.filter(n => n <= 6).length;
      const enpsScore = scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : null;

      result.enps = {
        count: entries.length,
        score: enpsScore,
        promoters,
        passives: scores.length - promoters - detractors,
        detractors
      };
    }
  } catch (e) { console.error('eNPS fetch failed:', e); }

  // ── Визиты за месяц — из копии базы «Визиты» в памяти (все, а не первые 100) ──
  try {
    const weekAgoStr = venueDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const visits = (await getAllVisits()).filter(v => v.date && v.date.slice(0, 10) >= monthStart);

    const guestCounts = {};
    const hookahCounts = {};
    const weekHookahCounts = {};

    for (const v of visits) {
      if (v.guestId) guestCounts[v.guestId] = (guestCounts[v.guestId] || 0) + 1;
      if (v.hookah) {
        hookahCounts[v.hookah] = (hookahCounts[v.hookah] || 0) + 1;
        if (v.date.slice(0, 10) >= weekAgoStr) {
          weekHookahCounts[v.hookah] = (weekHookahCounts[v.hookah] || 0) + 1;
        }
      }
    }

    const topHookah = Object.entries(hookahCounts).sort((a, b) => b[1] - a[1])[0];
    const weekTopHookahs = Object.entries(weekHookahCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([flavor, count]) => ({ flavor, count }));

    result.visits = {
      total: visits.length,
      uniqueGuests: Object.keys(guestCounts).length,
      topHookah: topHookah ? topHookah[0] : null,
      weekTopHookahs
    };
  } catch (e) { console.error('Visits stats failed:', e); }

  res.json(result);
});

// ─── ДЕСКТОП: НЕДЕЛЬНАЯ ДИНАМИКА (CSI/NPS/eNPS/визиты) ─
// Для графика и сравнения "эта неделя vs прошлая" на десктопной панели.
// Неделя считается с понедельника — так же, как в графике смен.
app.get('/api/admin/stats-weekly', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const WEEKS_BACK = 8;

  function weekMonday(dateStr) {
    const d = new Date(dateStr);
    const day = (d.getDay() + 6) % 7; // 0 = Пн
    d.setDate(d.getDate() - day);
    return d.toISOString().split('T')[0];
  }
  function npsFromVals(vals) {
    if (!vals.length) return null;
    const promoters = vals.filter(n => n >= 9).length;
    const detractors = vals.filter(n => n <= 6).length;
    return Math.round(((promoters - detractors) / vals.length) * 100);
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - WEEKS_BACK * 7);
    const sinceISO = since.toISOString().split('T')[0];

    // Все записи за 8 недель, а не первые 100 (раньше ранние недели графика выглядели пустыми).
    const [reviews, enpsEntries, allVisits] = await Promise.all([
      memo(`stats:weekly-reviews:${sinceISO}`, 2 * 60 * 1000, () =>
        notionQueryAll(NOTION_REVIEWS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: sinceISO } } })),
      memo(`stats:weekly-enps:${sinceISO}`, 2 * 60 * 1000, () =>
        notionQueryAll(NOTION_ENPS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: sinceISO } } })),
      getAllVisits()
    ]);
    const visits = allVisits.filter(v => v.date && v.date.slice(0, 10) >= sinceISO);

    const buckets = {};
    const ensure = (wk) => buckets[wk] || (buckets[wk] = { csiSum: 0, csiCount: 0, npsVals: [], enpsVals: [], visits: 0 });

    for (const p of reviews) {
      const date = p.properties['Дата']?.date?.start;
      if (!date) continue;
      const b = ensure(weekMonday(date));
      const cats = ['Вечер', 'Кальян', 'Напитки', 'Еда', 'Команда']
        .map(k => p.properties[k]?.number).filter(n => typeof n === 'number');
      if (cats.length) { b.csiSum += cats.reduce((a, c) => a + c, 0) / cats.length; b.csiCount++; }
      const nps = p.properties['NPS']?.number;
      if (typeof nps === 'number') b.npsVals.push(nps);
    }
    for (const p of enpsEntries) {
      const date = p.properties['Дата']?.date?.start;
      if (!date) continue;
      const score = p.properties['Оценка']?.number;
      if (typeof score === 'number') ensure(weekMonday(date)).enpsVals.push(score);
    }
    for (const v of visits) {
      ensure(weekMonday(v.date.slice(0, 10))).visits++;
    }

    const series = Object.keys(buckets).sort().map(wk => {
      const b = buckets[wk];
      return {
        week: wk,
        csi: b.csiCount ? Math.round((b.csiSum / b.csiCount) * 10) / 10 : null,
        nps: npsFromVals(b.npsVals),
        enps: npsFromVals(b.enpsVals),
        visits: b.visits
      };
    });

    res.json({ weeks: series });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch weekly stats' });
  }
});

// ─── ДЕСКТОП: ЕДИНАЯ ТАБЛИЦА ГОСТЕЙ (с RFM-меткой) ──────
// Объединяет то, что на мобильном разнесено по отдельным карточкам
// (Недавние/VIP/Давно не было), в одну таблицу с фильтрами на клиенте.
app.get('/api/admin/guests-table', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;

  try {
    // Все гости и все визиты (раньше — первые 100 гостей по алфавиту и последние 100 визитов бара,
    // из-за чего таблица была неполной, а «Риск оттока» ставился и тем, кто недавно был).
    const [guests, allVisits] = await Promise.all([
      notionQueryAll(NOTION_GUESTS_DB_ID, { sorts: [{ property: 'Имя Гостя', direction: 'ascending' }] }),
      getAllVisits()
    ]);
    const lastVisitByGuest = lastVisitByGuestMap(allVisits);

    const rows = guests.map(g => {
      const lastVisit = lastVisitByGuest[g.id] || null;
      const daysSince = daysSinceDate(lastVisit);
      const status = g.properties['Частота визитов']?.select?.name || '';
      // Риск оттока — только для тех, кого мы обычно ждём регулярно (VIP/Постоянный)
      const atRisk = (status === 'VIP' || status === 'Постоянный') && (daysSince === null || daysSince >= 30);
      return {
        id: g.id,
        name: g.properties['Имя Гостя']?.title?.[0]?.plain_text || '',
        phone: g.properties['Телефон']?.phone_number || '',
        status,
        lastVisit,
        daysSince,
        atRisk
      };
    });

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch guests table' });
  }
});

// ─── ОБЩЕЕ ДЛЯ ОТЗЫВОВ, РАССЫЛОК, АНАЛИТИКИ ─────────
// Карточка гостя в удобном виде + кому из гостей можно написать от гостевого бота.
function cardInfo(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: p['Имя Гостя']?.title?.[0]?.plain_text || '',
    phone: p['Телефон']?.phone_number || '',
    status: p['Частота визитов']?.select?.name || '',
    birthday: p['Дата рождения']?.date?.start || null,
    tagsSpecial: (p['Теги (особые)']?.multi_select || []).map(o => o.name),
    tagsAllergy: (p['Теги (аллергии)']?.multi_select || []).map(o => o.name),
    tastesLike: (p['Вкусы (любит)']?.multi_select || []).map(o => o.name),
    tastesDislike: (p['Вкусы (не любит)']?.multi_select || []).map(o => o.name)
  };
}
function getAllCards() {
  return memo('marketing:cards', 2 * 60 * 1000, async () => (await notionQueryAll(NOTION_GUESTS_DB_ID, {})).map(cardInfo));
}

// Telegram ID гостя пишет гостевое приложение в «Общую базу гостей», когда гость
// бронирует или заполняет профиль. «Без рассылок» — гость нажал «Не присылать рассылки»
// (колонку создаёт гостевой бэкенд, notion-proxy-na-kryishe).
const OPT_OUT_PROP = 'Без рассылок';
function getGuestContacts() {
  return memo('marketing:contacts', 2 * 60 * 1000, async () => {
    const pages = await fetchAllWithPhone(NOTION_GENERAL_GUESTS_DB_ID);
    const byPhone = new Map();
    for (const g of pages) {
      const phone = normalizePhone(g.properties['Телефон']?.phone_number || '');
      if (!phone) continue;
      const telegramId = g.properties['Telegram ID']?.rich_text?.[0]?.plain_text || '';
      const optOut = !!g.properties[OPT_OUT_PROP]?.checkbox;
      const prev = byPhone.get(phone);
      // несколько строк на один номер: берём ту, где есть Telegram ID; отписка в любой — значит отписан
      byPhone.set(phone, { telegramId: telegramId || prev?.telegramId || '', optOut: optOut || !!prev?.optOut });
    }
    return byPhone;
  });
}

function isNonGrata(card) {
  return card.tagsSpecial.some(t => t.trim().toLowerCase() === 'нон-грата');
}
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// ─── БОТ ПРОСИТ ГОСТЯ ОЦЕНИТЬ ВИЗИТ ─────────────────
// Раз в 10 минут смотрим свежие визиты: через 2 часа после того, как визит записали,
// гостевой бот пишет гостю «Спасибо, что были у нас» с кнопкой «Оценить вечер»
// (открывает тот же экран отзыва, что и QR на столе). Пишем только днём (12:00–22:00
// по местному времени) — визит, записанный поздно вечером, получит просьбу на следующий
// день после 12:00. Одного гостя спрашиваем не чаще раза в 14 дней, отписавшихся и тех,
// кто недавно сам оставил отзыв, — не спрашиваем. Результат пишем в визит в колонку
// «Запрос отзыва», чтобы никогда не спросить дважды за один визит.
// Выключить: переменная окружения REVIEW_REQUESTS=off.
const REVIEW_REQUEST = {
  enabled: process.env.REVIEW_REQUESTS !== 'off',
  delayMs: 2 * 60 * 60 * 1000,
  maxAgeMs: 36 * 60 * 60 * 1000,
  cooldownDays: 14,
  hours: hoursWindow(process.env.REVIEW_REQUEST_HOURS, 12, 22),
  perRun: 30
};
// «Отправляется» ставится ДО отправки: если потом что-то сломается, визит уже помечен
// и гостю не напишем второй раз (лучше не спросить, чем спросить дважды).
const REVIEW_REQUEST_STATUSES = ['Отправляется', 'Отправлен', 'Нет телефона', 'Нет Telegram', 'Отписан', 'Недавно оставил отзыв', 'Недавно спрашивали', 'Нон-грата', 'Не доставлен'];
const REVIEW_REASON_STATUS = {
  no_telegram: 'Нет Telegram',
  opted_out: 'Отписан',
  recent_review: 'Недавно оставил отзыв',
  blocked: 'Не доставлен',
  failed: 'Не доставлен'
};

function ensureVisitColumns() {
  return ensureColumns(NOTION_VISITS_DB_ID, {
    [REVIEW_REQUEST_PROP]: { select: { options: REVIEW_REQUEST_STATUSES.map(name => ({ name })) } }
  });
}

async function markVisitReviewRequest(visit, status) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(`https://api.notion.com/v1/pages/${visit.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties: { [REVIEW_REQUEST_PROP]: { select: status ? { name: status } : null } } })
    });
    if (r.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, (Number(r.headers.get('retry-after')) || 1) * 1000));
  }
  if (!r.ok) {
    forgetEnsuredColumns(NOTION_VISITS_DB_ID); // колонку могли переименовать — перепроверим в следующий раз
    throw new Error(`mark visit ${r.status}`);
  }
  visit.reviewRequest = status || '';
  const stored = visitsStore.byId.get(visit.id);
  if (stored) stored.reviewRequest = status || '';
}

// Кого уже просили (guestId → время) — в памяти, на случай если отметка в Notion не записалась
const reviewAskedAt = new Map();
let reviewRequestsRunning = false;
async function processReviewRequests({ force = false } = {}) {
  const summary = { checked: 0, sent: 0, marked: {}, skippedReason: null };
  if (!REVIEW_REQUEST.enabled) { summary.skippedReason = 'disabled'; return summary; }
  if (!NOTION_TOKEN) { summary.skippedReason = 'no_notion'; return summary; }
  if (!force && !inHoursWindow(REVIEW_REQUEST.hours)) { summary.skippedReason = 'night'; return summary; }
  if (reviewRequestsRunning) { summary.skippedReason = 'running'; return summary; }
  reviewRequestsRunning = true;
  try {
    if (!(await ensureVisitColumns())) { summary.skippedReason = 'no_column'; return summary; }
    const visits = await getAllVisits();
    const now = Date.now();
    const cooldownMs = REVIEW_REQUEST.cooldownDays * 24 * 60 * 60 * 1000;

    // когда каждого гостя последний раз просили оценить
    const lastAskedAt = {};
    for (const v of visits) {
      if ((v.reviewRequest !== 'Отправлен' && v.reviewRequest !== 'Отправляется') || !v.guestId) continue;
      const t = Date.parse(v.createdAt || v.date || '') || 0;
      if (!lastAskedAt[v.guestId] || t > lastAskedAt[v.guestId]) lastAskedAt[v.guestId] = t;
    }

    for (const [guestId, t] of reviewAskedAt) {
      if (now - t >= cooldownMs) reviewAskedAt.delete(guestId);
      else if (!lastAskedAt[guestId] || t > lastAskedAt[guestId]) lastAskedAt[guestId] = t;
    }

    const minDate = addDaysStr(venueDateStr(), -2); // и по дате визита свежий — не благодарим за старые визиты, внесённые задним числом
    const eligible = visits
      .filter(v => {
        if (v.reviewRequest || !v.guestId || !v.createdAt || !v.date || v.date.slice(0, 10) < minDate) return false;
        const age = now - Date.parse(v.createdAt);
        return age >= REVIEW_REQUEST.delayMs && age <= REVIEW_REQUEST.maxAgeMs;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (!eligible.length) return summary;

    // Нон-грата: и сама карточка, и любые другие карточки с тем же телефоном
    const bannedPhones = new Set((await getAllCards()).filter(isNonGrata).map(c => normalizePhone(c.phone)).filter(Boolean));

    const handledGuests = new Set();
    const mark = async (visit, status) => {
      await markVisitReviewRequest(visit, status);
      if (status) summary.marked[status] = (summary.marked[status] || 0) + 1;
    };

    for (const visit of eligible) {
      if (summary.checked >= REVIEW_REQUEST.perRun) break;
      summary.checked++;
      try {
        if (handledGuests.has(visit.guestId) || (lastAskedAt[visit.guestId] && now - lastAskedAt[visit.guestId] < cooldownMs)) {
          await mark(visit, 'Недавно спрашивали');
          continue;
        }
        handledGuests.add(visit.guestId);

        const pageRes = await fetch(`https://api.notion.com/v1/pages/${visit.guestId}`, { headers: NOTION_HEADERS });
        if (!pageRes.ok) continue; // карточку не прочитали — попробуем в следующий раз
        const card = cardInfo(await pageRes.json());
        if (isNonGrata(card) || bannedPhones.has(normalizePhone(card.phone))) { await mark(visit, 'Нон-грата'); continue; }
        if (!card.phone) { await mark(visit, 'Нет телефона'); continue; }

        // Сначала помечаем визит, потом пишем гостю. Не получилось пометить — не пишем.
        await mark(visit, 'Отправляется');
        reviewAskedAt.set(visit.guestId, now);
        const result = await callGuestProxy('/api/internal/review-request', { phone: card.phone, name: firstName(card.name) }, 1);
        if (!result.reached || result.httpError) {
          // гостевой бэкенд не ответил — снимаем отметку, повторим в следующий раз (визит ещё в окне 36 ч)
          reviewAskedAt.delete(visit.guestId);
          await mark(visit, null);
          continue;
        }
        if (result.sent) {
          await mark(visit, 'Отправлен');
          lastAskedAt[visit.guestId] = now;
          summary.sent++;
        } else {
          reviewAskedAt.delete(visit.guestId);
          await mark(visit, REVIEW_REASON_STATUS[result.reason] || 'Не доставлен');
        }
      } catch (e) {
        // отметка в Notion не записалась — останавливаем проход, чтобы не наделать дублей
        console.error('Review request for visit failed, stopping this run:', visit.id, e.message);
        summary.skippedReason = 'mark_failed';
        break;
      }
    }
    if (summary.sent) forgetMemo('feedback');
    return summary;
  } catch (e) {
    console.error('Review requests run failed:', e.message);
    summary.skippedReason = 'error';
    return summary;
  } finally {
    reviewRequestsRunning = false;
  }
}

setInterval(() => { processReviewRequests(); }, 10 * 60 * 1000);
setTimeout(() => { processReviewRequests(); }, 90 * 1000);

// Запустить проверку вручную (админ) — например, сразу после настройки
app.post('/api/admin/review-requests/run', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const summary = await processReviewRequests({ force: req.body?.force === true });
  res.json({ ok: true, ...summary });
});

// ─── МАРКЕТИНГ: СЕГМЕНТЫ И РАССЫЛКИ ЧЕРЕЗ ГОСТЕВОГО БОТА ──
// Готовые сегменты гостей из «Карточки Гостя» + визитов. Написать можно только тем,
// у кого есть Telegram (гость хоть раз открывал гостевое приложение) и кто не нажал
// «Не присылать рассылки». Гостей с тегом «Нон-грата» в рассылки не берём никогда.
// Отправляем только с 10:00 до 21:00, в сообщении можно писать {имя}.
const MARKETING_HOURS = hoursWindow(process.env.MARKETING_HOURS, 10, 21);
const MARKETING_TEXT_MAX = 3500;
const MARKETING_SEGMENTS = [
  { key: 'all', title: 'Все гости', description: 'Все карточки гостей' },
  { key: 'vip', title: 'VIP', description: 'Статус VIP' },
  { key: 'regular', title: 'Постоянные', description: 'Статус «Постоянный»' },
  { key: 'rare', title: 'Редкие', description: 'Статус «Редкий»' },
  { key: 'new', title: 'Новые', description: 'Первый визит за последние 30 дней' },
  { key: 'risk', title: 'Риск оттока', description: 'VIP и постоянные, которых не было 30+ дней' },
  { key: 'inactive60', title: 'Давно не были', description: 'Не были 60+ дней' },
  { key: 'birthday', title: 'Скоро день рождения', description: 'ДР сегодня или в ближайшие 7 дней' }
];

async function marketingContext() {
  const [cards, contacts, visits] = await Promise.all([getAllCards(), getGuestContacts(), getAllVisits()]);
  const lastVisit = lastVisitByGuestMap(visits);
  const firstVisit = {};
  for (const v of visits) {
    if (!v.guestId || !v.date) continue;
    const day = v.date.slice(0, 10);
    if (!firstVisit[v.guestId] || day < firstVisit[v.guestId]) firstVisit[v.guestId] = day;
  }
  return { cards, contacts, lastVisit, firstVisit };
}

// "like:Ягодные" → вкусы (любит), "special:Не любит шум" → особые
function parseTagKey(tagKey) {
  const m = String(tagKey || '').match(/^(like|special):(.+)$/);
  return m ? { group: m[1], name: m[2] } : null;
}

function segmentMatcher(key, tagKey, ctx) {
  const today = venueDateStr();
  switch (key) {
    case 'all': return () => true;
    case 'vip': return c => c.status === 'VIP';
    case 'regular': return c => c.status === 'Постоянный';
    case 'rare': return c => c.status === 'Редкий';
    case 'new': return c => !!ctx.firstVisit[c.id] && ctx.firstVisit[c.id] >= addDaysStr(today, -29);
    case 'risk': return c => {
      if (c.status !== 'VIP' && c.status !== 'Постоянный') return false;
      const d = daysSinceDate(ctx.lastVisit[c.id]);
      return d === null || d >= 30;
    };
    case 'inactive60': return c => {
      const d = daysSinceDate(ctx.lastVisit[c.id]);
      return d !== null && d >= 60;
    };
    case 'birthday': return c => {
      const b = birthdayInfo(c.birthday, today);
      return !!b && (b.when === 'today' || b.when === 'soon');
    };
    case 'tag': {
      const t = parseTagKey(tagKey);
      if (!t) return null;
      const n = t.name.trim().toLowerCase();
      const list = c => (t.group === 'like' ? c.tastesLike : c.tagsSpecial);
      return c => list(c).some(x => x.trim().toLowerCase() === n);
    }
    default: return null;
  }
}

function segmentTitle(key, tagKey) {
  if (key === 'tag') {
    const t = parseTagKey(tagKey);
    return t ? `${t.group === 'like' ? 'Любит' : 'Тег'}: ${t.name}` : 'Тег';
  }
  return MARKETING_SEGMENTS.find(s => s.key === key)?.title || key;
}

// Гости сегмента: у каждого — можно ли написать и почему нет
// Нон-грата исключаем не только по самой карточке: если у гостя есть вторая карточка
// с тем же телефоном или тем же Telegram — ей тоже не пишем.
function bannedContacts(ctx) {
  if (ctx.banned) return ctx.banned;
  const phones = new Set(), telegramIds = new Set();
  for (const c of ctx.cards) {
    if (!isNonGrata(c)) continue;
    const phone = normalizePhone(c.phone);
    if (!phone) continue;
    phones.add(phone);
    const tgId = ctx.contacts.get(phone)?.telegramId;
    if (tgId) telegramIds.add(tgId);
  }
  return (ctx.banned = { phones, telegramIds });
}

function buildSegment(key, tagKey, ctx) {
  const match = segmentMatcher(key, tagKey, ctx);
  if (!match) return null;
  const banned = bannedContacts(ctx);
  const seenTelegram = new Set();
  const guests = [];
  for (const c of ctx.cards) {
    if (isNonGrata(c) || !match(c)) continue;
    const phone = normalizePhone(c.phone);
    const contact = phone ? ctx.contacts.get(phone) : null;
    if ((phone && banned.phones.has(phone)) || (contact?.telegramId && banned.telegramIds.has(contact.telegramId))) continue;
    let reason = null;
    if (!phone) reason = 'no_phone';
    else if (!contact?.telegramId) reason = 'no_telegram';
    else if (contact.optOut) reason = 'opted_out';
    else if (seenTelegram.has(contact.telegramId)) reason = 'duplicate';
    if (!reason) seenTelegram.add(contact.telegramId);
    guests.push({
      id: c.id,
      name: c.name,
      status: c.status,
      lastVisit: ctx.lastVisit[c.id] || null,
      daysSince: daysSinceDate(ctx.lastVisit[c.id]),
      reachable: !reason,
      reason,
      telegramId: reason ? null : contact.telegramId
    });
  }
  return {
    key, tag: tagKey || null,
    title: segmentTitle(key, tagKey),
    total: guests.length,
    reachable: guests.filter(g => g.reachable).length,
    guests
  };
}

function personalize(text, name) {
  const first = firstName(name);
  if (first) return text.replace(/\{имя\}/gi, first);
  // имени нет — убираем обращение аккуратно: "Привет, {имя}!" → "Привет!"
  const cleaned = text.replace(/,?\s*\{имя\}/gi, '').replace(/^\s*[,!.]\s*/, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

app.get('/api/admin/marketing/segments', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    const ctx = await marketingContext();
    const segments = MARKETING_SEGMENTS.map(s => {
      const seg = buildSegment(s.key, null, ctx);
      return { ...s, total: seg.total, reachable: seg.reachable };
    });

    // Теги для сегмента «по тегу»: вкусы (любит) и особые, самые частые сверху
    const tagCounts = new Map();
    for (const c of ctx.cards) {
      if (isNonGrata(c)) continue;
      for (const t of c.tastesLike) tagCounts.set(`like:${t}`, (tagCounts.get(`like:${t}`) || 0) + 1);
      for (const t of c.tagsSpecial) tagCounts.set(`special:${t}`, (tagCounts.get(`special:${t}`) || 0) + 1);
    }
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([key, total]) => {
        const seg = buildSegment('tag', key, ctx);
        return { key, label: segmentTitle('tag', key), total, reachable: seg.reachable };
      });

    res.json({
      segments,
      tags,
      hours: MARKETING_HOURS,
      canSendNow: inHoursWindow(MARKETING_HOURS),
      running: broadcastJobs.find(j => j.status === 'Отправляется') ? publicJob(broadcastJobs.find(j => j.status === 'Отправляется')) : null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось посчитать сегменты' });
  }
});

app.get('/api/admin/marketing/segment', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    const seg = buildSegment(req.query.key, req.query.tag, await marketingContext());
    if (!seg) return res.status(400).json({ error: 'Неизвестный сегмент' });
    const guests = seg.guests
      .sort((a, b) => Number(b.reachable) - Number(a.reachable) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 300)
      .map(({ telegramId, ...g }) => g);
    res.json({ ...seg, guests });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить сегмент' });
  }
});

// ── Журнал рассылок: база «Рассылки» в Notion ──
// Сервер сам находит её (поиск по названию) или создаёт рядом с «Карточкой Гостя».
// Можно указать и явно: NOTION_BROADCASTS_DB_ID. Если Notion не дал ни найти, ни создать —
// журнал живёт в памяти сервера (до перезапуска), рассылки всё равно работают.
const BROADCASTS_DB_TITLE = 'Рассылки';
const BROADCASTS_SCHEMA = {
  'Название': { title: {} },
  'Дата': { date: {} },
  'Сегмент': { rich_text: {} },
  'Текст': { rich_text: {} },
  'Автор': { rich_text: {} },
  'Получателей': { number: {} },
  'Доставлено': { number: {} },
  'Не доставлено': { number: {} },
  'Заблокировали бота': { number: {} },
  'Статус': { select: { options: [{ name: 'Отправляется' }, { name: 'Отправлена' }, { name: 'Прервана' }] } }
};
let broadcastsDbId = process.env.NOTION_BROADCASTS_DB_ID || null;
let broadcastsDbPending = null;
let broadcastsDbFailedAt = 0;

async function getBroadcastsDb() {
  if (broadcastsDbId) return broadcastsDbId;
  if (broadcastsDbPending) return broadcastsDbPending;
  if (Date.now() - broadcastsDbFailedAt < 10 * 60 * 1000) return null; // не долбим Notion после неудачи
  broadcastsDbPending = (async () => {
    const s = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ query: BROADCASTS_DB_TITLE, filter: { property: 'object', value: 'database' } })
    });
    if (s.ok) {
      const data = await s.json();
      const found = (data.results || []).find(d => !d.archived && (d.title || []).map(t => t.plain_text).join('').trim() === BROADCASTS_DB_TITLE);
      if (found) return (broadcastsDbId = found.id);
    }
    const g = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}`, { headers: NOTION_HEADERS });
    const gInfo = g.ok ? await g.json() : {};
    const parentPage = gInfo.parent?.type === 'page_id' ? gInfo.parent.page_id : null;
    if (!parentPage) throw new Error('у базы «Карточка Гостя» нет родительской страницы');
    const c = await fetch('https://api.notion.com/v1/databases', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { type: 'page_id', page_id: parentPage },
        title: [{ type: 'text', text: { content: BROADCASTS_DB_TITLE } }],
        properties: BROADCASTS_SCHEMA
      })
    });
    if (!c.ok) throw new Error(`create db ${c.status}: ${(await c.text()).slice(0, 200)}`);
    const created = await c.json();
    console.log('Создана база «Рассылки»:', created.id);
    return (broadcastsDbId = created.id);
  })()
    .catch(e => {
      console.error('Журнал рассылок в Notion недоступен, веду в памяти:', e.message);
      broadcastsDbFailedAt = Date.now();
      return null;
    })
    .finally(() => { broadcastsDbPending = null; });
  return broadcastsDbPending;
}

const broadcastJobs = []; // свежие сверху, до 50
let broadcastSeq = 0;
let broadcastStarting = false;

function publicJob(j) {
  return {
    id: j.id, notionId: j.notionId || null, createdAt: j.createdAt, finishedAt: j.finishedAt || null,
    segment: j.segmentTitle, text: j.text, author: j.author,
    total: j.total, sent: j.sent, failed: j.failed, blocked: j.blocked, status: j.status
  };
}

function broadcastProps(j) {
  return {
    'Название': { title: [{ text: { content: j.text.replace(/\s+/g, ' ').slice(0, 60) } }] },
    'Дата': { date: { start: j.createdAt } },
    'Сегмент': { rich_text: [{ text: { content: j.segmentTitle } }] },
    'Текст': { rich_text: [{ text: { content: j.text.slice(0, 2000) } }] },
    'Автор': { rich_text: [{ text: { content: j.author } }] },
    'Получателей': { number: j.total },
    'Доставлено': { number: j.sent },
    'Не доставлено': { number: j.failed },
    'Заблокировали бота': { number: j.blocked },
    'Статус': { select: { name: j.status } }
  };
}

async function saveBroadcastLog(j) {
  try {
    const dbId = await getBroadcastsDb();
    if (!dbId) return;
    if (!j.notionId) {
      const r = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: dbId }, properties: broadcastProps(j) })
      });
      if (r.ok) j.notionId = (await r.json()).id;
    } else {
      await fetch(`https://api.notion.com/v1/pages/${j.notionId}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ properties: broadcastProps(j) })
      });
    }
  } catch (e) {
    console.error('Не удалось записать рассылку в журнал:', e.message);
  }
}

async function runBroadcast(job, recipients) {
  const BATCH = 25;
  let errors = 0;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH);
    const result = await callGuestProxy('/api/internal/broadcast', {
      messages: batch.map(r => ({ chatId: r.telegramId, text: personalize(job.text, r.name) }))
    }, 1);
    if (!result.reached || result.httpError) {
      job.failed += batch.length;
      errors++;
      if (errors >= 3) { job.status = 'Прервана'; job.failed += recipients.length - (i + batch.length); break; }
      continue;
    }
    job.sent += result.sent || 0;
    job.failed += result.failed || 0;
    job.blocked += result.blocked || 0;
  }
  if (job.status === 'Отправляется') job.status = 'Отправлена';
  job.finishedAt = new Date().toISOString();
  await saveBroadcastLog(job);

  const report =
    `📣 Рассылка «${job.segmentTitle}» ${job.status === 'Прервана' ? 'прервана — гостевой бот не отвечает' : 'отправлена'}\n` +
    `Доставлено: ${job.sent} из ${job.total}` +
    (job.failed ? `\nНе доставлено: ${job.failed}${job.blocked ? ` (заблокировали бота: ${job.blocked})` : ''}` : '') +
    `\nАвтор: ${job.author}`;
  await sendTelegramMessage(ADMIN_CHAT_ID, report);
  if (job.authorTelegramId && String(job.authorTelegramId) !== String(ADMIN_CHAT_ID)) {
    await sendTelegramMessage(job.authorTelegramId, report);
  }
}

app.post('/api/admin/marketing/send', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const { key, tag, test } = req.body || {};
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Напишите текст рассылки' });
  if (text.length > MARKETING_TEXT_MAX) return res.status(400).json({ error: `Слишком длинный текст — максимум ${MARKETING_TEXT_MAX} символов` });

  // Проверка «себе»: то же сообщение приходит только автору — от гостевого бота
  if (test) {
    if (!req.employee.telegramId) return res.status(400).json({ error: 'У вас в базе «Сотрудники» не указан Telegram ID — некуда отправить проверку' });
    const result = await callGuestProxy('/api/internal/broadcast', {
      messages: [{ chatId: req.employee.telegramId, text: personalize(text, req.employee.name) }]
    }, 1);
    if (!result.reached || result.httpError) return res.status(502).json({ error: 'Гостевой бот не отвечает, попробуйте ещё раз' });
    if (!result.sent) return res.status(400).json({ error: 'Гостевой бот не смог вам написать — откройте его в Telegram и нажмите «Старт», потом повторите' });
    return res.json({ ok: true, test: true });
  }

  if (!inHoursWindow(MARKETING_HOURS)) {
    return res.status(400).json({ error: `Рассылки отправляются с ${MARKETING_HOURS.from}:00 до ${MARKETING_HOURS.to}:00, чтобы не беспокоить гостей ночью` });
  }
  // Блокировка ставится сразу, до первого await: два почти одновременных нажатия
  // (двойной тап, два админа) не должны запустить одну и ту же рассылку дважды.
  if (broadcastStarting || broadcastJobs.some(j => j.status === 'Отправляется')) {
    return res.status(409).json({ error: 'Предыдущая рассылка ещё отправляется — дождитесь её окончания' });
  }
  broadcastStarting = true;

  try {
    const seg = buildSegment(key, tag, await marketingContext());
    if (!seg) return res.status(400).json({ error: 'Неизвестный сегмент' });
    const recipients = seg.guests.filter(g => g.reachable);
    if (!recipients.length) return res.status(400).json({ error: 'В этом сегменте некому написать: ни у кого нет Telegram или все отписались' });

    const job = {
      id: `b${Date.now()}${++broadcastSeq}`,
      createdAt: new Date().toISOString(),
      segmentTitle: seg.title,
      text,
      author: `${req.employee.name}${req.employee.role ? ` (${req.employee.role})` : ''}`,
      authorTelegramId: req.employee.telegramId || null,
      total: recipients.length, sent: 0, failed: 0, blocked: 0,
      status: 'Отправляется'
    };
    broadcastJobs.unshift(job);
    if (broadcastJobs.length > 50) broadcastJobs.length = 50;
    await saveBroadcastLog(job);

    // Отправка идёт в фоне — итог придёт админу в Telegram и появится в журнале
    runBroadcast(job, recipients).catch(e => {
      console.error('Broadcast failed:', e);
      job.status = 'Прервана';
      saveBroadcastLog(job);
    });

    res.json({ ok: true, job: publicJob(job) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось запустить рассылку' });
  } finally {
    broadcastStarting = false;
  }
});

app.get('/api/admin/marketing/log', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  try {
    const memoryJobs = broadcastJobs.map(publicJob);
    let rows = [];
    const dbId = await getBroadcastsDb();
    if (dbId) {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ sorts: [{ property: 'Дата', direction: 'descending' }], page_size: 30 })
      });
      if (r.ok) {
        const data = await r.json();
        rows = (data.results || []).map(p => {
          const pp = p.properties;
          const num = name => pp[name]?.number ?? 0;
          return {
            id: p.id, notionId: p.id,
            createdAt: pp['Дата']?.date?.start || null,
            segment: pp['Сегмент']?.rich_text?.[0]?.plain_text || '',
            text: (pp['Текст']?.rich_text || []).map(t => t.plain_text).join(''),
            author: pp['Автор']?.rich_text?.[0]?.plain_text || '',
            total: num('Получателей'), sent: num('Доставлено'), failed: num('Не доставлено'), blocked: num('Заблокировали бота'),
            status: pp['Статус']?.select?.name || ''
          };
        });
      }
    }
    // Свежие данные идущей рассылки — из памяти (в Notion пишем только начало и итог)
    const byNotionId = new Map(memoryJobs.filter(j => j.notionId).map(j => [j.notionId, j]));
    // «Отправляется» в Notion, но в памяти такой рассылки нет — сервер перезапустился посреди отправки
    const merged = rows.map(r => byNotionId.get(r.notionId) || (r.status === 'Отправляется' ? { ...r, status: 'Прервана' } : r));
    for (const j of memoryJobs) if (!j.notionId || !rows.some(r => r.notionId === j.notionId)) merged.push(j);
    merged.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ storedInNotion: !!dbId, broadcasts: merged.slice(0, 30) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить журнал рассылок' });
  }
});

// ─── АНАЛИТИКА: СРАВНЕНИЕ ПЕРИОДОВ ──────────────────
// Любой показатель за выбранный период по дням/неделям/месяцам рядом с тем же показателем
// за предыдущий такой же период или за те же даты год назад. Фильтры: день недели
// (например, только пятницы) и статус гостя (для показателей по визитам).
const ANALYTICS_METRICS = {
  visits: { title: 'Визиты', kind: 'count' },
  guests: { title: 'Гости (уникальные)', kind: 'unique' },
  newGuests: { title: 'Новые гости', kind: 'count' },
  returning: { title: 'Вернувшиеся гости', kind: 'unique' },
  bookings: { title: 'Брони', kind: 'count' },
  cancellations: { title: 'Отмены броней', kind: 'count' },
  csi: { title: 'CSI (средняя оценка)', kind: 'avg' },
  nps: { title: 'NPS гостей', kind: 'score' },
  enps: { title: 'eNPS команды', kind: 'score' }
};
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function isoWeekday(dateStr) { // 1 = пн … 7 = вс
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}
function bucketStartOf(dateStr, group) {
  if (group === 'month') return dateStr.slice(0, 8) + '01';
  if (group === 'week') return addDaysStr(dateStr, -(isoWeekday(dateStr) - 1));
  return dateStr;
}
function nextBucketStart(start, group) {
  if (group === 'month') {
    const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return addDaysStr(start, group === 'week' ? 7 : 1);
}
function shiftYears(dateStr, years) {
  const y = Number(dateStr.slice(0, 4)) + years;
  const md = dateStr.slice(5, 10) === '02-29' ? '02-28' : dateStr.slice(5, 10);
  return `${y}-${md}`;
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function bucketLabel(start, end, group) {
  const dm = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  if (group === 'month') return `${MONTHS_SHORT[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  if (group === 'week') return `${dm(start)}–${dm(end)}`;
  return dm(start);
}
function makeBuckets(from, to, group) {
  const out = [];
  let start = bucketStartOf(from, group);
  while (start <= to) {
    const next = nextBucketStart(start, group);
    const s = start < from ? from : start;
    const lastDay = addDaysStr(next, -1);
    const e = lastDay > to ? to : lastDay;
    out.push({ start: s, end: e, label: bucketLabel(s, e, group) });
    start = next;
    if (out.length > 400) break;
  }
  return out;
}
function npsOf(vals) {
  if (!vals.length) return null;
  const promoters = vals.filter(n => n >= 9).length;
  const detractors = vals.filter(n => n <= 6).length;
  return Math.round(((promoters - detractors) / vals.length) * 100);
}

// Все брони из «Истории броней» общей базы: { date, cancelled }
function getAllBookingsFlat() {
  return memo('analytics:bookings', 5 * 60 * 1000, async () => {
    const pages = await notionQueryAll(NOTION_GENERAL_GUESTS_DB_ID, {});
    const out = [];
    for (const page of pages) {
      const history = (page.properties['История броней']?.rich_text || []).map(t => t.plain_text || '').join('');
      if (!history) continue;
      for (const raw of history.split(',').map(x => x.trim()).filter(Boolean)) {
        const { iso } = parseBookingEntry(raw);
        if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) continue;
        out.push({ date: iso.slice(0, 10), cancelled: raw.includes('(отменено)') });
      }
    }
    return out;
  });
}

// Точки данных показателя: [{ date, value, guestId? }]
async function analyticsRows(metric, minDate, statusFilter) {
  if (['visits', 'guests', 'newGuests', 'returning'].includes(metric)) {
    const visits = (await getAllVisits()).filter(v => v.date);
    let statusOf = null;
    if (statusFilter) {
      const cards = await getAllCards();
      statusOf = new Map(cards.map(c => [c.id, c.status]));
    }
    const firstVisit = {};
    for (const v of visits) {
      if (!v.guestId) continue;
      const d = v.date.slice(0, 10);
      if (!firstVisit[v.guestId] || d < firstVisit[v.guestId]) firstVisit[v.guestId] = d;
    }
    return {
      firstVisit,
      rows: visits
        .filter(v => !statusOf || (v.guestId && statusOf.get(v.guestId) === statusFilter))
        .map(v => ({ date: v.date.slice(0, 10), guestId: v.guestId, value: 1 }))
    };
  }
  if (metric === 'bookings' || metric === 'cancellations') {
    const all = await getAllBookingsFlat();
    return { rows: all.filter(b => metric === 'bookings' ? !b.cancelled : b.cancelled).map(b => ({ date: b.date, value: 1 })) };
  }
  if (metric === 'csi' || metric === 'nps') {
    const reviews = await memo(`analytics:reviews:${minDate}`, 2 * 60 * 1000, () =>
      notionQueryAll(NOTION_REVIEWS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: minDate } } }));
    const rows = [];
    for (const p of reviews) {
      const date = p.properties['Дата']?.date?.start;
      if (!date) continue;
      if (metric === 'nps') {
        const n = p.properties['NPS']?.number;
        if (typeof n === 'number') rows.push({ date: date.slice(0, 10), value: n });
      } else {
        const cats = ['Вечер', 'Кальян', 'Напитки', 'Еда', 'Команда'].map(k => p.properties[k]?.number).filter(n => typeof n === 'number');
        if (cats.length) rows.push({ date: date.slice(0, 10), value: cats.reduce((a, c) => a + c, 0) / cats.length });
      }
    }
    return { rows };
  }
  if (metric === 'enps') {
    const entries = await memo(`analytics:enps:${minDate}`, 2 * 60 * 1000, () =>
      notionQueryAll(NOTION_ENPS_DB_ID, { filter: { property: 'Дата', date: { on_or_after: minDate } } }));
    return {
      rows: entries
        .map(p => ({ date: (p.properties['Дата']?.date?.start || '').slice(0, 10), value: p.properties['Оценка']?.number }))
        .filter(r => r.date && typeof r.value === 'number')
    };
  }
  return { rows: [] };
}

function aggregate(metric, rows, from, to, firstVisit) {
  const kind = ANALYTICS_METRICS[metric].kind;
  const inRange = rows.filter(r => r.date >= from && r.date <= to);
  if (metric === 'guests') return new Set(inRange.map(r => r.guestId).filter(Boolean)).size;
  if (metric === 'newGuests') return new Set(inRange.filter(r => r.guestId && firstVisit[r.guestId] === r.date).map(r => r.guestId)).size;
  if (metric === 'returning') return new Set(inRange.filter(r => r.guestId && firstVisit[r.guestId] < from).map(r => r.guestId)).size;
  if (kind === 'count') return inRange.length;
  if (!inRange.length) return null;
  if (kind === 'avg') return Math.round((inRange.reduce((a, r) => a + r.value, 0) / inRange.length) * 10) / 10;
  return npsOf(inRange.map(r => r.value));
}

app.get('/api/admin/analytics', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const metric = ANALYTICS_METRICS[req.query.metric] ? req.query.metric : 'visits';
  const group = ['day', 'week', 'month'].includes(req.query.group) ? req.query.group : 'day';
  const compare = ['prev', 'year', 'none'].includes(req.query.compare) ? req.query.compare : 'prev';
  const today = venueDateStr();
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const to = isDate(req.query.to) ? req.query.to : today;
  const from = isDate(req.query.from) ? req.query.from : addDaysStr(to, -29);
  const dow = Number(req.query.dow) >= 1 && Number(req.query.dow) <= 7 ? Number(req.query.dow) : null;
  const status = ['VIP', 'Постоянный', 'Редкий'].includes(req.query.status) ? req.query.status : null;

  if (from > to) return res.status(400).json({ error: 'Начало периода позже конца' });
  const lengthDays = daysBetween(from, to) + 1;
  if (lengthDays > 731) return res.status(400).json({ error: 'Период не больше двух лет' });
  const buckets = makeBuckets(from, to, group);
  if (buckets.length > 400) return res.status(400).json({ error: 'Слишком много точек — выберите группировку по неделям или месяцам' });

  let compareFrom = null, compareTo = null;
  if (compare === 'prev') { compareTo = addDaysStr(from, -1); compareFrom = addDaysStr(from, -lengthDays); }
  if (compare === 'year') { compareFrom = shiftYears(from, -1); compareTo = shiftYears(to, -1); }

  try {
    const minDate = compareFrom && compareFrom < from ? compareFrom : from;
    const { rows: allRows, firstVisit = {} } = await analyticsRows(metric, minDate, status);
    const rows = dow ? allRows.filter(r => isoWeekday(r.date) === dow) : allRows;

    // Строка сравнения i — тот же отрезок, сдвинутый на длину периода (или на год назад),
    // чтобы в строке рядом стояли отрезки одинаковой длины: неделя против недели и т.д.
    const shiftDate = d => compare === 'year' ? shiftYears(d, -1) : addDaysStr(d, -lengthDays);
    const compareBuckets = compareFrom
      ? buckets.map(b => {
          const start = shiftDate(b.start), end = shiftDate(b.end);
          return { start, end, label: bucketLabel(start, end, group === 'month' && compare === 'prev' ? 'week' : group) };
        })
      : [];
    const series = buckets.map((b, i) => {
      const cb = compareBuckets[i];
      return {
        label: b.label, start: b.start, end: b.end,
        value: aggregate(metric, rows, b.start, b.end, firstVisit),
        compareLabel: cb ? cb.label : null,
        compareStart: cb ? cb.start : null,
        compareEnd: cb ? cb.end : null,
        compareValue: cb ? aggregate(metric, rows, cb.start, cb.end, firstVisit) : null
      };
    });

    const total = aggregate(metric, rows, from, to, firstVisit);
    const compareTotal = compareFrom ? aggregate(metric, rows, compareFrom, compareTo, firstVisit) : null;
    const kind = ANALYTICS_METRICS[metric].kind;
    let delta = null, deltaPct = null;
    if (total !== null && compareTotal !== null) {
      delta = Math.round((total - compareTotal) * 10) / 10;
      if ((kind === 'count' || kind === 'unique') && compareTotal > 0) deltaPct = Math.round(((total - compareTotal) / compareTotal) * 100);
    }

    res.json({
      metric, title: ANALYTICS_METRICS[metric].title, kind, group, compare,
      from, to, compareFrom, compareTo, dow, status,
      buckets: series, total, compareTotal, delta, deltaPct
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось посчитать аналитику' });
  }
});

// ─── ОБРАТНАЯ СВЯЗЬ: ВСЕ ОТЗЫВЫ ГОСТЕЙ В ОДНОМ МЕСТЕ ──
// Свежие отзывы (с оценками по категориям, NPS и комментарием) с привязкой к карточке
// гостя по телефону, сводка за период, открытые проблемы и сколько гостей бот попросил
// оценить визит.
const REVIEW_CATEGORIES = ['Вечер', 'Кальян', 'Напитки', 'Еда', 'Команда'];

app.get('/api/admin/feedback', async (req, res) => {
  if (!(await checkAdminPin(req, res))) return;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const since = addDaysStr(venueDateStr(), -(days - 1));
  try {
    const [reviewPages, cardPages, problemPages, visits] = await Promise.all([
      memo(`feedback:reviews:${since}`, 60 * 1000, () =>
        notionQueryAll(NOTION_REVIEWS_DB_ID, {
          filter: { property: 'Дата', date: { on_or_after: since } },
          sorts: [{ property: 'Дата', direction: 'descending' }]
        })),
      memo('cards-with-phone', 2 * 60 * 1000, () => fetchAllWithPhone(NOTION_GUESTS_DB_ID)),
      memo('feedback:problems', 60 * 1000, () =>
        notionQueryAll(NOTION_PROBLEMS_DB_ID, { filter: { or: [
          { property: 'Статус', select: { equals: 'Задачи' } },
          { property: 'Статус', select: { equals: 'В работе' } }
        ] } })),
      getAllVisits()
    ]);

    const cardByPhone = new Map();
    for (const c of cardPages) {
      const info = cardInfo(c);
      const key = normalizePhone(info.phone);
      if (key && !cardByPhone.has(key)) cardByPhone.set(key, info);
    }

    const reviews = reviewPages.map(p => {
      const pp = p.properties;
      const scores = {};
      for (const c of REVIEW_CATEGORIES) scores[c] = typeof pp[c]?.number === 'number' ? pp[c].number : null;
      const vals = Object.values(scores).filter(v => v !== null);
      const phone = pp['Телефон']?.phone_number || '';
      const card = phone ? cardByPhone.get(normalizePhone(phone)) : null;
      const nps = typeof pp['NPS']?.number === 'number' ? pp['NPS'].number : null;
      const min = vals.length ? Math.min(...vals) : null;
      return {
        id: p.id,
        date: pp['Дата']?.date?.start || '',
        scores,
        avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
        nps,
        comment: (pp['Комментарий']?.rich_text || []).map(t => t.plain_text || '').join(''),
        phone,
        telegramUsername: pp['Telegram Username']?.rich_text?.[0]?.plain_text || '',
        guest: card ? { id: card.id, name: card.name, status: card.status } : null,
        negative: (min !== null && min <= 3) || (nps !== null && nps <= 6)
      };
    });

    const npsVals = reviews.map(r => r.nps).filter(n => n !== null);
    const promoters = npsVals.filter(n => n >= 9).length;
    const detractors = npsVals.filter(n => n <= 6).length;
    const categories = {};
    for (const c of REVIEW_CATEGORIES) {
      const vals = reviews.map(r => r.scores[c]).filter(v => v !== null);
      categories[c] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    }
    const avgs = reviews.map(r => r.avg).filter(v => v !== null);

    // Просьбы оценить визит за тот же период
    const requests = { sent: 0, noTelegram: 0, optedOut: 0, other: 0 };
    for (const v of visits) {
      if (!v.reviewRequest || !v.date || v.date.slice(0, 10) < since) continue;
      if (v.reviewRequest === 'Отправлен') requests.sent++;
      else if (v.reviewRequest === 'Нет Telegram' || v.reviewRequest === 'Нет телефона') requests.noTelegram++;
      else if (v.reviewRequest === 'Отписан') requests.optedOut++;
      else requests.other++;
    }

    const today = venueDateStr();
    const openProblems = {
      total: problemPages.length,
      overdue: problemPages.filter(p => {
        const d = p.properties['Срок исполнения']?.date?.start;
        return d && d.slice(0, 10) < today;
      }).length
    };

    res.json({
      days, since,
      summary: {
        count: reviews.length,
        csi: avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 10) / 10 : null,
        nps: npsOf(npsVals),
        promoters, passives: npsVals.length - promoters - detractors, detractors,
        categories,
        negative: reviews.filter(r => r.negative).length,
        withComment: reviews.filter(r => r.comment.trim()).length
      },
      requests,
      openProblems,
      reviews: reviews.slice(0, 200)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить обратную связь' });
  }
});

app.get('/', (req, res) => {
  res.send('Staff Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Сразу загружаем копию визитов в фоне, чтобы первый открывший «Давно не было»
  // или статистику не ждал полной выгрузки базы.
  if (NOTION_TOKEN) {
    ensureGuestTagColumns();
    ensureHistoryColumn();
    ensureVisitColumns();
    syncVisits()
      .then(() => console.log(`Visits loaded into memory: ${visitsStore.byId.size}`))
      .catch(e => console.error('Initial visits load failed:', e.message));
  }
});
