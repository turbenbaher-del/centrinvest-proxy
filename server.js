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
const { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, reconRest, getDocuments, getAccountNames, documentAction, signStart, signStatus, signSubmitKey, signSyncToken, signCancel, reconTransferForm, reconDocModel, transferOwnStructured, closeBrowser, callBankApi } = require('./browser')
const { audit, auditTail, maskAccount } = require('./audit')
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
        // Банк не пустил — держать неверный пароль в памяти незачем
        console.error('[login] вход не удался:', err.message)
        audit('auth.login', 'error', { login, reason: err.message })
        if (liveSession?.password === password) liveSession = null
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
  const { account = '', dateFrom, dateTo, format = 'pdf' } = req.query
  try {
    const { buffer, filename, mimeType } = await downloadStatement(dbo().login, dbo().password, { account, dateFrom, dateTo, format })
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
    const r = await callBankApi(dbo().login, dbo().password, {
      method: 'GET',
      path: '/api/v1/statements/operations?_offset=0&_limit=20000',
    })
    const arr = Array.isArray(r.json) ? r.json : (r.json?.list || r.json?.items || [])
    stmtCache.at = Date.now(); stmtCache.data = arr; stmtCache.pending = null
    console.log('[statement] получено операций:', arr.length)
    return arr
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
    res.json({ success: true, total: ops.length, data: ops.slice(0, limit) })
  } catch (err) {
    console.error('[statement]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Журнал действий: что происходило, когда и чем закончилось.
// Секретов не содержит, номера счетов маскированы.
app.get('/api/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500)
  res.json({ success: true, data: auditTail(limit) })
})

app.post('/api/logout', async (_, res) => {
  // Выход обязан стирать пароль из памяти, а не только закрывать браузер:
  // иначе после «выхода» сервис продолжал бы ходить в банк под владельцем.
  liveSession = null
  cachedWhoAmI = null
  invalidateCache()
  await closeBrowser()
  console.log('[auth] выход — пароль стёрт из памяти')
  audit('auth.logout', 'ok', {})
  res.json({ success: true })
})

app.listen(PORT, () => {
  console.log(`Centrinvest proxy on http://localhost:${PORT}`)
})
