// Локальный запуск: подхватываем .env без внешних зависимостей.
// На Railway переменные берутся из окружения, файла .env там нет — это не мешает.
try {
  const fs = require('fs'); const path = require('path')
  const envPath = path.join(__dirname, '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
    console.log('[env] .env подхвачен')
  }
} catch {}

const express = require('express')
const cors = require('cors')
const { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, reconRest, getDocuments, getAccountNames, documentAction, signStart, signStatus, signSubmitKey, signSyncToken, signCancel, reconTransferForm, reconDocModel, transferOwnStructured, closeBrowser, getOperations, getMail, getMailItem, markMailRead, getMailCounters, payContragent, payBudget, getDocumentPrint, getPartners, getBics, callBankApi } = require('./browser')
const { audit, auditTail, maskAccount } = require('./audit')
const { getAcquiring } = require('./acquiring')
const webpay = require('./webpay') // reliable /api-ui/ REST payment sender (reversed 2026-07-03)

const app = express()
const PORT = process.env.PORT || 3001

// ─── Доступы ────────────────────────────────────────────────────────────────
// Пароль ДБО НЕ хранится на сервере постоянно. Он приходит от владельца при
// входе и живёт только в оперативной памяти активной сессии: на диск не
// пишется, в логи не попадает, после простоя стирается. Постоянное хранение
// пароля от банка на стороннем хостинге — главный риск такой архитектуры,
// и держать его там незачем.
//
// Переменные окружения остаются как ЗАПАСНОЙ режим (например, для проверок
// без участия человека). Если они не заданы — это норма, а не ошибка.
const ENV_LOGIN = process.env.DBO_LOGIN
const ENV_PASSWORD = process.env.DBO_PASSWORD

// Время бездействия, после которого пароль стирается из памяти
const CREDS_TTL_MS = 30 * 60 * 1000

let liveSession = null   // { login, password, lastUsedAt }

/** Учётные данные текущей сессии или null, если входа не было. */
function dbo() {
  if (liveSession) {
    if (Date.now() - liveSession.lastUsedAt < CREDS_TTL_MS) {
      liveSession.lastUsedAt = Date.now()
      return liveSession
    }
    liveSession = null
    console.log('[auth] сессия истекла — пароль стёрт из памяти')
    audit('auth.expired', 'info', { reason: 'бездействие' })
  }
  if (ENV_LOGIN && ENV_PASSWORD) return { login: ENV_LOGIN, password: ENV_PASSWORD }
  return null
}

/** Есть ли чем ходить в банк прямо сейчас. */
const hasCreds = () => !!dbo()

/**
 * Банк отверг именно логин с паролем — или просто не смог сейчас ответить?
 * Разница принципиальна: в первом случае пароль надо стереть, во втором —
 * сохранить, иначе человека выбрасывает на экран входа из-за причин, к
 * его паролю отношения не имеющих.
 */
function isWrongCredentials(message = '') {
  const m = String(message).toLowerCase()
  // Явный отказ по учётным данным. \w не покрывает кириллицу, поэтому
  // окончания слов задаём явным диапазоном [а-яё].
  if (/невер[а-яё]*\s+(логин|пароль|учет|учёт)|invalid\s+(login|password|credentials)|неправильн[а-яё]*\s+(логин|пароль)|заблокирован/.test(m)) {
    return true
  }
  // Всё остальное — про доступность банка, а не про пароль
  return false
}

if (!ENV_LOGIN || !ENV_PASSWORD) {
  console.log('[auth] пароль ДБО на сервере не хранится — ожидается вход владельца')
}

// Токен доступа к самому прокси: без него любой запрос отклоняется.
// Если не задан — сервис поднимется, но громко предупредит.
const ACCESS_TOKEN = process.env.PROXY_TOKEN || ''
if (!ACCESS_TOKEN) {
  console.warn('[warn] PROXY_TOKEN не задан — прокси открыт без авторизации. Задайте его и передавайте в PWA через VITE_PROXY_TOKEN.')
}

// CORS только для доверенных origin'ов вместо «разрешаем всем».
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(cors({
  origin(origin, cb) {
    // Запросы без Origin (curl, серверные) не блокируем — их отсекает токен.
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(new Error('Origin не разрешён: ' + origin))
  },
  credentials: true,
}))
app.use(express.json())

// ─── Журнал запросов ────────────────────────────────────────────────────────
// Без него не видно, КТО обращается к сервису: при разборе сбоев было неясно,
// почему сразу после успешного входа приходит выход и пароль стирается.
// Пишем строку на каждый запрос: путь, источник, устройство, код и время
// ответа. Пароли и токены в журнал не попадают.
const shortAgent = (ua = '') => {
  if (/iPhone|iPad/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android'
  if (/Chrome\//i.test(ua)) return 'Chrome'
  if (/Safari\//i.test(ua)) return 'Safari'
  if (/curl|PowerShell|node|python/i.test(ua)) return 'консоль'
  return ua ? ua.slice(0, 22) : '—'
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  const started = Date.now()
  const from = req.get('origin') || req.get('referer') || '—'
  const who = shortAgent(req.get('user-agent'))
  res.on('finish', () => {
    const ms = Date.now() - started
    // Выход стирает пароль из памяти, поэтому его источник фиксируем всегда
    const mark = req.path === '/api/logout' ? ' ВЫХОД' : ''
    console.log(
      `[req]${mark} ${req.method} ${req.path} <- ${who} ${from} :: ${res.statusCode} за ${ms} мс`
    )
  })
  next()
})

// Проверка токена. /health оставляем открытым — по нему хостинг следит за живостью.
app.use((req, res, next) => {
  if (!ACCESS_TOKEN) return next()
  if (req.path === '/health' || req.method === 'OPTIONS') return next()

  const header = req.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const token = bearer || req.get('x-proxy-token') || ''
  if (token !== ACCESS_TOKEN) {
    return res.status(401).json({ success: false, error: 'Недействительный токен доступа' })
  }
  next()
})

app.get('/health', (_, res) => {
  res.json({
    status: hasCreds() ? 'ok' : 'awaiting-login',
    // Пароль не хранится: сервис жив, но до входа владельца в банк не ходит
    dboReady: hasCreds(),
    time: new Date().toISOString(),
  })
})

// До входа владельца ходить в банк нечем — отвечаем понятно, а не падаем.
// /api/login исключён: это и есть вход.
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/login' || req.path === '/api/audit' || req.method === 'OPTIONS') return next()
  if (hasCreds()) return next()
  res.status(401).json({
    success: false,
    error: 'Требуется вход: пароль ДБО не хранится на сервере',
    needLogin: true,
  })
})

// ─── Кэш ответов ────────────────────────────────────────────────────────────
// Каждый поход в банк — это браузер, навигация и отрисовка SPA: 30–90 секунд.
// Сам банк отвечает мгновенно, потому что у него настоящий API, а мы ходим
// «как человек». Держим свежие ответы минуту: повторные открытия экранов
// становятся мгновенными, а нагрузка на банк падает.
const responseCache = new Map()
const CACHE_TTL_MS = 60 * 1000

/** Отдать из кэша или посчитать и запомнить. Ошибки не кэшируем. */
async function cached(key, ttlMs, producer) {
  const hit = responseCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) {
    console.log(`[cache] ${key}: отдано из кэша (${Math.round((Date.now() - hit.at) / 1000)} c назад)`)
    return hit.value
  }
  // Если такой запрос уже выполняется — ждём его, а не запускаем второй
  if (hit?.pending) {
    console.log(`[cache] ${key}: жду уже идущий запрос`)
    return hit.pending
  }
  const pending = producer()
  responseCache.set(key, { pending, at: 0 })
  try {
    const value = await pending
    responseCache.set(key, { value, at: Date.now() })
    return value
  } catch (e) {
    responseCache.delete(key)
    throw e
  }
}

/** Сбросить кэш после операций, меняющих данные в банке. */
function invalidateCache() {
  responseCache.clear()
  console.log('[cache] сброшен')
}

// Имя клиента меняется раз в никогда — держим его в памяти, чтобы вход
// не ждал полного захода в банк.
let cachedWhoAmI = null
let whoAmIWarming = false

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {}
  if (!login || !password) {
    return res.status(400).json({ success: false, error: 'Введите логин и пароль' })
  }

  // Пароль принимаем от владельца и держим ТОЛЬКО в памяти. Сверять его
  // с переменными окружения больше не с чем — и не нужно: правильность
  // проверит сам банк при входе.
  liveSession = { login, password, lastUsedAt: Date.now() }
  audit('auth.login', 'info', { login, ip: req.ip })

  // Отвечаем СРАЗУ: полный заход в банк занимает 40-90 c, и сервис-воркер
  // на телефоне обрывал такой запрос по таймауту — человек видел
  // «Failed to fetch» вместо входа. Сессию прогреваем фоном.
  res.json({ success: true, name: cachedWhoAmI || login })

  if (!whoAmIWarming) {
    whoAmIWarming = true
    getWhoAmI(login, password)
      .then(name => { if (name) { cachedWhoAmI = name; console.log('[login] вход выполнен:', name); audit('auth.login', 'ok', { name }) } })
      .catch(err => {
        console.error('[login] вход не удался:', err.message)
        audit('auth.login', 'error', { login, reason: err.message })
        // Стираем пароль ТОЛЬКО если банк отверг сами учётные данные.
        // Раньше стирали при любой неудаче — и человека выбрасывало на
        // экран входа через пару минут, стоило банку ответить «временное
        // ограничение», уйти на техработы или просто задуматься.
        // Такие ошибки о правильности пароля не говорят ничего.
        if (isWrongCredentials(err.message) && liveSession?.password === password) {
          liveSession = null
          console.log('[auth] банк отверг учётные данные — пароль стёрт')
        }
      })
      .finally(() => { whoAmIWarming = false })
  }
})

// Выход: стираем пароль из памяти немедленно, не дожидаясь таймаута.
app.post('/api/session/end', (_, res) => {
  liveSession = null
  cachedWhoAmI = null
  invalidateCache()
  console.log('[auth] выход — пароль стёрт из памяти')
  res.json({ success: true })
})

// Имя клиента отдельным запросом — приложение подтягивает его, когда придёт.
app.get('/api/whoami', (_, res) => {
  res.json({ success: true, name: cachedWhoAmI })
})

// Последний удачный список СВОИХ счетов (из формы платежа) — источник истины.
// Разбор текста страницы подхватывает чужие счета из назначений платежей
// («перевод на ЛС 40817…») и получателей — на форме перевода это опасно.
let cachedOwnAccounts = null

app.get('/api/accounts', async (req, res) => {
  try {
    // Кэшируем оба захода в банк разом: страницу счетов и форму платежа
    const { data, own } = await cached('accounts', CACHE_TTL_MS, async () => {
      const pageAccounts = await getAccountsData(dbo().login, dbo().password)
      let names = []
      try {
        names = await getAccountNames(dbo().login, dbo().password)
      } catch (e) {
        console.warn('[accounts] список счетов из формы недоступен:', e.message)
      }
      return { data: pageAccounts, own: names }
    })
    const seizure = data.find(a => a.seizureNotice)

    if (own.length > 0) {
      cachedOwnAccounts = own.map(a => ({
        number: a.number,
        name: a.name,
        currency: a.currency || 'RUR',
        balance: a.balance ?? 0,
        balanceSource: (a.balance === null || a.balance === undefined) ? 'unknown' : 'form',
        status: 'Открыт',
      }))
    }
    console.log('[accounts] счетов от банка:', own.length, '| со страницы было:', data.length,
      '| кэш:', cachedOwnAccounts ? cachedOwnAccounts.length : 0)

    // Порядок надёжности: свежий достоверный список → последний удачный из кэша.
    // Сырой список со страницы НЕ отдаём: в нём чужие счета, и на форме перевода
    // из них можно ошибочно выбрать счёт.
    let result
    if (cachedOwnAccounts) {
      // Аресты приклеиваем к текущему ответу
      result = cachedOwnAccounts.map(a => ({ ...a, seizureNotice: seizure?.seizureNotice, seizureAccounts: seizure?.seizureAccounts }))
    } else {
      // Достоверного списка ещё не было — отдаём ошибку, а не мусор
      return res.status(503).json({ success: false, error: 'Список счетов ещё загружается, повторите через несколько секунд' })
    }

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[accounts]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments', async (req, res) => {
  try {
    const data = await cached('payments', CACHE_TTL_MS, () => getPaymentsData(dbo().login, dbo().password))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[payments]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Один документ по идентификатору. Банк не отдаёт выписку постранично с id,
// поэтому ищем операцию в свежем списке по её устойчивому ключу (дата|номер|сумма).
app.get('/api/payments/:id', async (req, res) => {
  try {
    const list = await getPaymentsData(dbo().login, dbo().password)
    const found = (list || []).find(p => p.id === req.params.id)
    if (!found) return res.status(404).json({ success: false, error: 'Операция не найдена в выписке' })
    res.json({ success: true, data: found })
  } catch (err) {
    console.error('[payment by id]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Map the PWA payment payload → webpay fields.
function mapPayment(body) {
  const r = body.recipient || {}
  const p = body.payer || {}
  return {
    payerAccount: p.account || body.payerAccount,
    receiverName: r.name,
    receiverINN: r.inn || body.recipientInn || '',
    receiverKPP: r.kpp || body.recipientKpp || '',
    receiverAccount: (r.account || '').replace(/\s/g, ''),
    receiverBic: (r.bic || '').replace(/\D/g, ''),
    amount: Number(body.amount).toFixed(2),
    purpose: body.purpose || '',
    vat: body.vat || 'VatZero',
    priority: body.priority === 'urgent' ? '1' : '5',
  }
}

app.post('/api/payments', async (req, res) => {
  const body = req.body || {}
  try {
    // sign=false → save as DRAFT (no money). Real send only when body.sign === true.
    const result = await webpay.submitPayment(dbo().login, dbo().password, mapPayment(body), { sign: !!body.sign })
    res.json({ success: !!result.ok, data: result })
  } catch (err) {
    console.error('[payments POST]', err.message)
    // Fall back to draft so UI doesn't break
    res.json({
      success: false,
      error: err.message,
      data: {
        ...body,
        id: `draft-${Date.now()}`,
        status: 'draft',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      }
    })
  }
})

app.get('/debug/contractors-raw', async (req, res) => {
  try {
    const p = await require('./browser').getAccountsDomDebug ? null : null  // ensure browser loaded
    const { chromium } = require('playwright-chromium')
    // Re-use session via the module-level page
    const mod = require('./browser')
    // Just get DOM text of current page
    const data = await mod.getAccountsDomDebug(dbo().login, dbo().password)
    const text = data.domTextPreview || ''
    const payments = text.split('\n').filter(l => /^\d{2}\.\d{2}\.\d{4}$/.test(l.trim()))
    res.json({
      url: data.urlAfter,
      domLen: data.domTextLength,
      dateLines: payments.length,
      accountNumbers: data.accountNumbers,
      preview: text.substring(0, 3000),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/contractors', async (req, res) => {
  try {
    const data = await getContractorsFromHistory(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[contractors]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/tariffs', async (req, res) => {
  try {
    const data = await getTariffs(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[tariffs]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})


app.post('/api/transfer-own', async (req, res) => {
  const { fromAccount, toAccount, amount, purpose, sign } = req.body || {}
  if (!fromAccount || !toAccount || !amount) return res.status(400).json({ success:false, error:'fromAccount, toAccount, amount обязательны' })
  try {
    // Структурный API вместо кликов по форме: счета выбираются по идентификатору,
    // поэтому не бывает «счёт получателя не выбран». success = реальный итог банка.
    audit('transfer.create', 'info', { fromAccount, toAccount, amount, purpose })
    const data = await transferOwnStructured(dbo().login, dbo().password, { fromAccount, toAccount, amount, purpose, sign: !!sign })
    invalidateCache()   // появился новый документ — список устарел
    audit('transfer.create', data.ok !== false ? 'ok' : 'error',
      { fromAccount, toAccount, amount, docId: data.id, error: data.error })
    res.json({ success: data.ok !== false, error: data.error || undefined, data })
  } catch (err) {
    console.error('[transfer-own]', err.message)
    audit('transfer.create', 'error', { fromAccount, toAccount, amount, error: err.message })
    res.status(500).json({ success:false, error: err.message })
  }
})

// Документы клиента из структурного интерфейса банка: с идентификаторами,
// настоящими статусами, номерами и назначением. В отличие от /api/payments
// (разбор выписки) не содержит входящих поступлений, зато пригодно для действий
// над документами. Только чтение.
app.get('/api/documents', async (_, res) => {
  try {
    const data = await cached('documents', CACHE_TTL_MS, () => getDocuments(dbo().login, dbo().password))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[documents]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Подпись документа — двухшаговый поток с вводом ключа eToken.
// Шаг 1: отправить на подпись и получить серийник токена для окна ввода.
app.post('/api/documents/:id/sign/start', async (req, res) => {
  try {
    const data = await signStart(dbo().login, dbo().password, { id: req.params.id })
    audit('sign.start', 'ok', { docId: req.params.id, stage: data.stage, serial: data.serial })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[sign start]', err.message)
    audit('sign.start', 'error', { docId: req.params.id, error: err.message })
    res.status(400).json({ success: false, error: err.message })
  }
})

// Шаг 1.5: опрос подтверждения в PayControl. Пока клиент не нажал в приложении
// на телефоне — банк держит подпись неподтверждённой. Как подтвердит, этот же
// маршрут вернёт stage:'needKey' с серийником токена.
app.get('/api/documents/:id/sign/status', async (req, res) => {
  try {
    const data = await signStatus(dbo().login, dbo().password, { id: req.params.id })
    // Пишем только завершение: промежуточные опросы идут раз в 5 секунд и
    // засорили бы журнал, ничего к нему не добавляя.
    if (data.stage === 'done' || data.stage === 'signed' || data.stage === 'error') {
      audit('sign.finish', data.stage === 'error' ? 'error' : 'ok',
        { docId: req.params.id, stage: data.stage, message: data.message, error: (data.errors || [])[0] })
    }
    res.json({ success: data.stage !== 'error', data })
  } catch (err) {
    console.error('[sign status]', err.message)
    res.status(400).json({ success: false, error: err.message })
  }
})

// Синхронизация токена: попытки ввода ключа исчерпаны, банк просит два ключа
// подряд. Это последний шанс — при неверных ключах банк блокирует доступ.
app.post('/api/documents/:id/sign/sync', async (req, res) => {
  const { firstKey, secondKey } = req.body || {}
  try {
    const data = await signSyncToken(dbo().login, dbo().password, { id: req.params.id, firstKey, secondKey })
    audit('sign.sync', data.stage === 'error' ? 'error' : 'ok',
      { docId: req.params.id, stage: data.stage })
    invalidateCache()
    res.json({ success: data.stage !== 'error', data })
  } catch (err) {
    console.error('[sign sync]', err.message)
    res.status(400).json({ success: false, error: err.message })
  }
})

// Отмена подписи: гасим висящую операцию в банке, если человек закрыл окно.
app.post('/api/documents/:id/sign/cancel', async (req, res) => {
  try {
    const data = await signCancel(dbo().login, dbo().password, { id: req.params.id })
    audit('sign.cancel', 'ok', { docId: req.params.id })
    res.json({ success: true, data })
  } catch (err) {
    res.status(400).json({ success: false, error: err.message })
  }
})

// Шаг 2: пользователь ввёл ключ с токена — отправляем и ждём PayControl.
app.post('/api/documents/:id/sign/key', async (req, res) => {
  const { key } = req.body || {}
  if (!key) return res.status(400).json({ success: false, error: 'не передан ключ токена' })
  try {
    const data = await signSubmitKey(dbo().login, dbo().password, { id: req.params.id, key })
    invalidateCache()   // статус документа изменился
    // Сам ключ в журнал не попадает — только факт ввода и итог
    audit('sign.key', data.stage === 'error' ? 'error' : 'ok',
      { docId: req.params.id, stage: data.stage, error: (data.errors || [])[0] })
    res.json({ success: data.stage !== 'error', data })
  } catch (err) {
    console.error('[sign key]', err.message)
    audit('sign.key', 'error', { docId: req.params.id, error: err.message })
    res.status(400).json({ success: false, error: err.message })
  }
})

// Действие над документом: подпись, удаление, отправка.
// _sign/_send двигают реальные деньги — прокси требует confirm:true, и это
// осознанное решение вызывающей стороны, а не значение по умолчанию.
app.post('/api/documents/:id/action', async (req, res) => {
  const { action, confirm } = req.body || {}
  const allowed = ['_sign', '_send', '_removeSign', '_delete_payments', '_edit']
  if (!allowed.includes(action)) {
    return res.status(400).json({ success: false, error: 'Недопустимое действие: ' + action })
  }
  try {
    const data = await documentAction(dbo().login, dbo().password, { id: req.params.id, action, confirm: !!confirm })
    res.json({ success: data.ok, data })
  } catch (err) {
    console.error('[document action]', action, err.message)
    res.status(400).json({ success: false, error: err.message })
  }
})

// Разведка документного API — нужна, чтобы понять, возможны ли подпись и
// удаление документов из приложения. Только чтение трафика, ничего не нажимает.
// Отдаёт сводку (эндпоинты, ключи-идентификаторы, действия), а не сами данные.
app.get('/api/recon/documents', async (_, res) => {
  try {
    const data = await reconDocuments(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[recon]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Разведка REST-эндпоинтов: пробует варианты списка документов, отдаёт сырое.
app.get('/api/recon/doc-model', async (req, res) => {
  try {
    res.json({ success: true, data: await reconDocModel(dbo().login, dbo().password, { id: req.query.id }) })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/recon/rest', async (_, res) => {
  try {
    const data = await reconRest(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[recon rest]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Разведка формы перевода между своими счетами — только чтение полей.
app.get('/api/recon/transfer', async (_, res) => {
  try {
    const data = await reconTransferForm(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[recon transfer]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Список разделов ДБО, которые умеет отдавать прокси
app.get('/api/sections', (_, res) => {
  res.json({
    success: true,
    data: Object.entries(DBO_SECTIONS).map(([key, s]) => ({ key, title: s.title })),
  })
})

// Данные конкретного раздела ДБО (кредиты, депозиты, эквайринг, АУСН и т.д.)
app.get('/api/sections/:key', async (req, res) => {
  try {
    const data = await getSectionData(dbo().login, dbo().password, req.params.key)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[section]', req.params.key, err.message)
    res.status(err.message.startsWith('Неизвестный раздел') ? 404 : 500)
      .json({ success: false, error: err.message })
  }
})

app.get('/api/templates', async (req, res) => {
  try {
    const data = await getTemplatesData(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[templates]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments-debug', async (req, res) => {
  try {
    const data = await getPaymentsDebug(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[payments-debug]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/nav-debug', async (req, res) => {
  try {
    const data = await getNavDebug(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[nav-debug]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/debug/api-responses', (req, res) => {
  res.json({ success: true, data: getApiResponsesDebug() })
})

app.get('/debug/accounts-dom', async (req, res) => {
  try {
    const data = await getAccountsDomDebug(dbo().login, dbo().password)
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/statement', async (req, res) => {
  // reportForm — форма отчёта банка (1, 1a, 2, 3, 4): от неё зависит содержимое файла
  // by=account|contractor — выписка по счёту или по контрагенту
  const { account = '', dateFrom, dateTo, format = 'pdf', reportForm = '1', by = 'account' } = req.query
  try {
    const { buffer, filename, mimeType } = await downloadStatement(dbo().login, dbo().password, { account, dateFrom, dateTo, format, reportForm, by })
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    console.error('[statement]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Мост к REST-API банка (/api/v1/...) — тому самому, которым пользуется
// веб-версия d2sme. Позволяет приложению работать с банком напрямую, а не
// через разбор страниц: списки, фильтры, документы, справочники.
//
// Тело: { method, path, body }. Путь обязан начинаться с /api/v1/.
// Ответ банка возвращается как есть — интерпретирует вызывающая сторона.
//
// ВНИМАНИЕ: через мост доступны и операции, двигающие деньги (подпись,
// отправка документа). Мост закрыт тем же PROXY_TOKEN, что и остальные
// маршруты; ответственность за вызовы — на вызывающей стороне.
app.post('/api/bank', async (req, res) => {
  const { method = 'GET', path, body = null } = req.body || {}
  if (!path || typeof path !== 'string' || !path.startsWith('/api/v1/')) {
    return res.status(400).json({ success: false, error: 'path должен начинаться с /api/v1/' })
  }
  try {
    const r = await callBankApi(dbo().login, dbo().password, { method, path, body })
    // Изменяющие запросы могли поменять данные — сбрасываем кэш чтения.
    if (String(method).toUpperCase() !== 'GET') invalidateCache()
    res.json({ success: true, status: r.status, data: r.json })
  } catch (err) {
    console.error('[bank]', method, path, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Выписка по счёту, подготовленная на сервере.
//
// Банк отдаёт операции одним списком по возрастанию даты — у этого клиента
// почти 10 000 записей (~7 МБ). Гонять их на телефон при каждом открытии
// выписки нельзя, поэтому тяжёлый запрос остаётся здесь: фильтруем по счёту,
// сортируем свежими вверх и отдаём последние N.
//
// Параметры: account (номер счёта), limit (по умолчанию 200), from/to (YYYY-MM-DD).
const stmtCache = { at: 0, data: null, pending: null }
const STMT_TTL = 120000

async function loadAllOperations() {
  const now = Date.now()
  if (stmtCache.data && now - stmtCache.at < STMT_TTL) return stmtCache.data
  if (stmtCache.pending) return stmtCache.pending
  stmtCache.pending = (async () => {
    // Банк отдаёт операции от старых к новым и не поддерживает сортировку,
    // поэтому свежие лежат В КОНЦЕ списка. Тянуть всё разом нельзя: у клиента
    // около 10 000 операций (~7 МБ), и такой ответ внутри страницы роняет
    // браузер в контейнере — вход в банк после этого падает с ERR_ABORTED.
    // Поэтому идём с конца страницами: обычно хватает одной-двух.
    const PAGE = 1500
    let offset = 8000
    let tail = []
    for (let step = 0; step < 6; step++) {
      const r = await callBankApi(dbo().login, dbo().password, {
        method: 'GET',
        path: `/api/v1/statements/operations?_offset=${offset}&_limit=${PAGE}`,
      })
      const arr = Array.isArray(r.json) ? r.json : (r.json?.list || r.json?.items || [])
      if (arr.length === 0) {
        // Ушли за конец — отступаем назад и пробуем ближе к началу
        if (offset <= 0) break
        offset = Math.max(0, offset - PAGE)
        continue
      }
      tail = arr
      if (arr.length < PAGE) break          // это последняя страница
      offset += PAGE                        // возможно, есть ещё свежее
    }
    stmtCache.at = Date.now(); stmtCache.data = tail; stmtCache.pending = null
    console.log('[operations] загружено операций (хвост):', tail.length)
    return tail
  })().catch(e => { stmtCache.pending = null; throw e })
  return stmtCache.pending
}

// Имя /api/statement уже занято выгрузкой файла выписки из банка,
// поэтому список операций живёт по адресу /api/operations.
app.get('/api/operations', async (req, res) => {
  const account = String(req.query.account || '').replace(/\D/g, '')
  const limit = Math.min(Number(req.query.limit) || 200, 1000)
  const from = req.query.from || null
  const to = req.query.to || null
  try {
    // Сначала просим банк отсортировать и отдать свежие. Так не приходится
    // угадывать смещение в истории на тысячи записей: при большом объёме
    // окно попадало в середину, и в приложении висел прошлогодний период.
    try {
      const fresh = await getOperations(dbo().login, dbo().password, {
        dateFrom: from, dateTo: to, limit,
        accounts: account ? [account] : undefined,
      })
      if (fresh.length) {
        console.log('[operations] сортировка банка:', fresh.length, '| свежая:', fresh[0]?.date)
        return res.json({ success: true, total: fresh.length, data: fresh })
      }
    } catch (e) {
      console.warn('[operations] поиск с сортировкой не удался, беру страницами:', e.message)
    }

    let ops = await loadAllOperations()
    if (account) {
      ops = ops.filter(o => {
        const p = String(o.payer?.account || '').replace(/\D/g, '')
        const r2 = String(o.receiver?.account || '').replace(/\D/g, '')
        return p === account || r2 === account
      })
    }
    if (from) ops = ops.filter(o => String(o.operationDate || '').slice(0, 10) >= from)
    if (to) ops = ops.filter(o => String(o.operationDate || '').slice(0, 10) <= to)
    // свежие сверху
    ops = ops.slice().sort((a, b) => String(b.operationDate || '').localeCompare(String(a.operationDate || '')))
    // Отдаём разобранными: приложению нужны знак суммы, направление и
    // контрагент, а не сырые поля банка. Дебет или кредит определяется
    // наличием суммы — так же считает фронт самого банка.
    const data = ops.slice(0, limit).map(o => {
      const debit = !!o.debet && Number(o.debet) !== 0
      const party = debit ? o.receiver : o.payer
      return {
        id: o.id,
        date: String(o.operationDate || '').slice(0, 10),
        number: String(o.documentNumber ?? '').trim(),
        account: String(o.accountName ?? '').trim(),
        purpose: String(o.paymentPurpose ?? '').trim(),
        amount: debit ? -Math.abs(Number(o.debet) || 0) : Math.abs(Number(o.credit) || 0),
        direction: debit ? 'out' : 'in',
        currency: o.payerCurrIsoCode || o.receiverCurrIsoCode || 'RUR',
        counterparty: {
          name: String(party?.name ?? '').trim(),
          inn: party?.inn || '',
          account: party?.account || '',
          bank: party?.bankName || '',
          bic: party?.bankBic || '',
        },
        status: 'Исполнен',
      }
    })
    res.json({ success: true, total: ops.length, data })
  } catch (err) {
    console.error('[statement]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Платёж контрагенту. Всегда сохраняется ЧЕРНОВИКОМ: деньги двигает только
// подпись, которую делает владелец своими средствами.
app.post('/api/pay-contragent', async (req, res) => {
  const b = req.body || {}
  try {
    audit('pay.contragent', 'info', {
      fromAccount: b.fromAccount, receiverAccount: b.receiverAccount,
      amount: b.amount, receiverName: b.receiverName,
    })
    const data = await payContragent(dbo().login, dbo().password, b)
    invalidateCache()
    audit('pay.contragent', data.ok ? 'ok' : 'error',
      { amount: b.amount, docId: data.id, error: data.error })
    res.json({ success: !!data.ok, error: data.error || undefined, data })
  } catch (err) {
    console.error('[pay-contragent]', err.message)
    audit('pay.contragent', 'error', { amount: b.amount, error: err.message })
    res.status(500).json({ success: false, error: err.message })
  }
})

// Платёж в бюджет: налоги, взносы, пошлины. Тоже черновиком — подпись отдельно.
app.post('/api/pay-budget', async (req, res) => {
  const b = req.body || {}
  try {
    audit('pay.budget', 'info', { fromAccount: b.fromAccount, amount: b.amount, cbc: b.cbc })
    const data = await payBudget(dbo().login, dbo().password, b)
    invalidateCache()
    audit('pay.budget', data.ok ? 'ok' : 'error', { amount: b.amount, docId: data.id, error: data.error })
    res.json({ success: !!data.ok, error: data.error || undefined, data })
  } catch (err) {
    console.error('[pay-budget]', err.message)
    audit('pay.budget', 'error', { amount: b.amount, error: err.message })
    res.status(500).json({ success: false, error: err.message })
  }
})

// Печатная форма документа с отметкой банка — её просят контрагенты и налоговая
app.get('/api/documents/:id/print', async (req, res) => {
  try {
    const r = await getDocumentPrint(dbo().login, dbo().password, {
      id: req.params.id,
      format: String(req.query.format || 'PDF').toUpperCase(),
    })
    const buf = Buffer.from(r.base64, 'base64')
    res.setHeader('Content-Type', r.type)
    res.setHeader('Content-Disposition', r.disposition || 'attachment; filename="document.pdf"')
    audit('doc.print', 'ok', { docId: req.params.id })
    res.send(buf)
  } catch (err) {
    console.error('[print]', err.message)
    audit('doc.print', 'error', { docId: req.params.id, error: err.message })
    res.status(500).json({ success: false, error: err.message })
  }
})

// Справочник контрагентов банка — реквизиты подставляются, а не вводятся руками
app.get('/api/partners', async (req, res) => {
  try {
    const data = await cached(`partners:${req.query.search || ''}`, CACHE_TTL_MS, () =>
      getPartners(dbo().login, dbo().password, { search: req.query.search }))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[partners]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Поиск банка по БИК или названию
app.get('/api/bics', async (req, res) => {
  try {
    const data = await getBics(dbo().login, dbo().password, { query: req.query.q })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[bics]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── Письма в банк ──────────────────────────────────────────────────────────
app.get('/api/mail', async (req, res) => {
  const box = req.query.box === 'out' ? 'out' : 'in'
  try {
    const data = await cached(`mail:${box}`, CACHE_TTL_MS, () =>
      getMail(dbo().login, dbo().password, { box, limit: Math.min(Number(req.query.limit) || 50, 200) }))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[mail]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/mail/counters', async (_, res) => {
  try {
    const data = await cached('mail:counters', CACHE_TTL_MS, () =>
      getMailCounters(dbo().login, dbo().password, {}))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[mail counters]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/mail/:id', async (req, res) => {
  const box = req.query.box === 'out' ? 'out' : 'in'
  try {
    const data = await getMailItem(dbo().login, dbo().password, { box, id: req.params.id })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[mail item]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Отметка о прочтении: письмо открыли — банк должен об этом знать,
// иначе счётчик непрочитанных не сойдётся с тем, что видно в ДБО.
app.post('/api/mail/:id/read', async (req, res) => {
  const box = req.query.box === 'out' ? 'out' : 'in'
  try {
    const data = await markMailRead(dbo().login, dbo().password, {
      box, id: req.params.id, read: req.body?.read !== false,
    })
    invalidateCache()
    audit('mail.read', 'ok', { mailId: req.params.id })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[mail read]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Журнал действий: что происходило, когда и чем закончилось.
// Секретов не содержит, номера счетов маскированы.
app.get('/api/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500)
  res.json({ success: true, data: auditTail(limit) })
})

// Раздел банка по пункту меню.
//
// Часть разделов (тарифы, депозиты, кредиты) живёт не в REST, а в командном
// протоколе: банк отдаёт модель формы, а данные лежат в её полях-гридах.
// Настоящие идентификаторы пунктов берутся из GET /api/v1/menu — угадывать их
// по исходникам фронта нельзя, у этого клиента они другие.
//
// Возвращаем нормализованный вид: {title, grids: {поле: [строки]}, selects: {...}}.
app.get('/api/form', async (req, res) => {
  const menuItem = String(req.query.menuItem || '').trim()
  // tab — идентификатор вкладки внутри раздела (form_switcher). Разделы вроде
  // эквайринга при открытии отдают только каркас: содержимое приходит после
  // переключения на нужную вкладку, как при клике в интерфейсе.
  const tab = String(req.query.tab || '').trim()
  if (!menuItem) return res.status(400).json({ success: false, error: 'не указан menuItem' })
  try {
    const data = await cached('form:' + menuItem + ':' + tab, CACHE_TTL_MS, async () => {
      const r = await callBankApi(dbo().login, dbo().password, {
        method: 'POST', path: '/api/v1/menu/click', body: { menuItem },
      })
      let cmds = r.json?.commands || []

      if (tab) {
        // Вкладки бывают вложенными («Мои ТСП» → «Терминалы»), и содержимое
        // приходит только после переключения на конечный уровень. Поэтому
        // принимаем цепочку через запятую и проходим её по шагам, каждый раз
        // заново отыскивая форму со свитчером — после переключения банк
        // присылает новую форму с новым токеном.
        // Самый свежий токен формы: банк выдаёт новый на каждое обновление,
        // а старый после этого данных уже не отдаёт.
        const tokenOf = (name) => {
          let t = null
          for (const c of cmds) if (c.instanceName === name && c.instanceToken) t = c.instanceToken
          return t
        }
        for (const step of tab.split(',').map(s => s.trim()).filter(Boolean)) {
          const hosts = cmds.filter(c => c.command === 'formInit'
            && Object.values(c.fields || {}).some(f => f?.type === 'form_switcher')).reverse()
          // Берём ту форму, в свитчере которой есть нужная вкладка
          let host = null, switcherId = null
          for (const h of hosts) {
            for (const [id, f] of Object.entries(h.fields || {})) {
              if (f?.type !== 'form_switcher') continue
              if ((f.items || []).some(i => i.id === step)) { host = h; switcherId = id; break }
            }
            if (host) break
          }
          if (!host) { console.log('[form] вкладка не найдена:', step); break }

          // Переключение вкладки — doAction с extActionId, как делает веб-версия.
          // stateUpdate по полю свитчера банк принимает молча и форму вкладки
          // не присылает: раздел выглядит пустым, хотя данные есть.
          const upd = await callBankApi(dbo().login, dbo().password, {
            method: 'PUT',
            path: `/api/v1/${host.instanceName}/doAction`,
            body: {
              instanceToken: tokenOf(host.instanceName) || host.instanceToken,
              actionId: `_switchForm_${switcherId}`,
              extActionId: step,
            },
          })
          const more = upd.json?.commands || []
          if (more.length) cmds = cmds.concat(more)
          console.log(`[form] вкладка ${step}: команд ${more.length}`)
        }
      }

      const err = cmds.find(c => /errorDialog/.test(c.instanceName || ''))
      if (err) {
        const msg = err.fields?.message?.value || err.fields?.message || 'раздел недоступен'
        throw new Error(String(msg))
      }

      // Разворачиваем поля вида {value: …} в простые значения
      const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
      const flat = (row) => {
        const out = {}
        for (const [k, v] of Object.entries(row || {})) {
          const val = plain(v)
          if (val === null || val === undefined || typeof val === 'object') continue
          out[k] = val
        }
        return out
      }

      // Списки банк присылает не только в formInit: терминалы, реестры и другие
      // «скроллеры» приходят отдельными командами со своими items/columns.
      // Разбираем всё, где есть содержимое, иначе раздел выглядит пустым.
      const forms = cmds.filter(c => c.command === 'formInit' || c.command === 'scrollerInit'
        || c.command === 'getPage' || Array.isArray(c.items))
      const grids = {}
      const selects = {}
      const extras = {}
      let title = ''

      for (const f of forms) {
        if (f.title && !title) title = f.title

        // Скроллер отдаёт строки прямо в items — без обёртки в поля формы
        if (Array.isArray(f.items) && f.items.length) {
          const key = f.instanceName ? String(f.instanceName).split('/').pop() : (f.command || 'items')
          const rows = f.items.map(it => {
            const base = flat(it)
            if (it && typeof it === 'object' && it.fields) Object.assign(base, flat(it.fields))
            return base
          }).filter(r => Object.keys(r).length)
          if (rows.length) grids[key] = (grids[key] || []).concat(rows)
        }
        for (const [id, field] of Object.entries(f.fields || {})) {
          const items = field?.items || (Array.isArray(field?.value) ? field.value : null)
          if (!Array.isArray(items) || items.length === 0) continue
          const rows = items.map(it => {
            const base = flat(it)
            // Особенности тарифа приходят отдельным списком пар
            if (Array.isArray(it.addProps)) {
              base._props = it.addProps
                .map(p => ({ label: String(p.label || '').trim(), value: String(p.value || '').trim() }))
                .filter(p => p.label || p.value)
            }
            return base
          })
          if (field.type === 'select') selects[id] = rows
          else if (field.type === 'grid' || field.type === 'lines') grids[id] = rows
          else extras[id] = rows
        }
      }
      return { title, grids, selects, extras }
    })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[form]', menuItem, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Эквайринг: терминалы, отчёты (платежи, операции, СБП), возвраты, счета и акты.
//
// Отдельный маршрут, а не /api/form, потому что раздел требует своей
// последовательности: переключение вкладки действием и применение периода —
// иначе банк отдаёт пустые списки за сегодняшний день.
app.get('/api/acquiring/:key', async (req, res) => {
  const key = String(req.params.key || '').trim()
  const { from = '', to = '', search = '', limit = '' } = req.query
  try {
    const cacheKey = `acq:${key}:${from}:${to}:${search}:${limit}`
    const data = await cached(cacheKey, CACHE_TTL_MS, () =>
      getAcquiring(dbo(), { key, from, to, search, limit }))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[acquiring]', key, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Меню банка целиком — с настоящими идентификаторами разделов.
app.get('/api/menu', async (_req, res) => {
  try {
    const data = await cached('menu', 10 * 60 * 1000, async () => {
      const r = await callBankApi(dbo().login, dbo().password, { method: 'GET', path: '/api/v1/menu' })
      const found = []
      const walk = (n) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) return n.forEach(walk)
        if (n.id && (n.label || n.name)) found.push({ id: n.id, label: n.label || n.name })
        Object.values(n).forEach(walk)
      }
      walk(r.json)
      return found
    })
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/logout', async (req, res) => {
  // Кто именно инициировал выход — записываем всегда. Выход стирает пароль,
  // и без источника невозможно понять, почему сессия обрывается сама.
  const from = req.get('origin') || req.get('referer') || '—'
  const who = shortAgent(req.get('user-agent'))
  console.log(`[auth] запрос выхода от ${who} ${from}`)
  audit('auth.logout', 'info', { origin: from, agent: who, ip: req.ip })

  // Выход обязан стирать пароль из памяти, а не только закрывать браузер:
  // иначе после «выхода» сервис продолжал бы ходить в банк под владельцем.
  liveSession = null
  cachedWhoAmI = null
  invalidateCache()
  // Браузер не трогаем, пока идёт вход: закрытие на полпути роняло его
  // ошибкой «browser has been closed» и вход не завершался никогда.
  if (whoAmIWarming) {
    console.log('[auth] выход во время входа — браузер оставлен, пароль стёрт')
    audit('auth.logout', 'ok', { note: 'во время входа' })
    return res.json({ success: true })
  }
  await closeBrowser()
  console.log('[auth] выход — пароль стёрт из памяти')
  audit('auth.logout', 'ok', {})
  res.json({ success: true })
})

app.listen(PORT, () => {
  console.log(`Centrinvest proxy on http://localhost:${PORT}`)
})
