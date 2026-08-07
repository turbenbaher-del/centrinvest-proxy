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
const { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, reconRest, getDocuments, getAccountNames, documentAction, signStart, signStatus, signSubmitKey, reconTransferForm, reconDocModel, transferOwnStructured, closeBrowser } = require('./browser')
const webpay = require('./webpay') // reliable /api-ui/ REST payment sender (reversed 2026-07-03)

const app = express()
const PORT = process.env.PORT || 3001

// ─── Доступы ────────────────────────────────────────────────────────────────
// Креды ДБО берём ТОЛЬКО из окружения. Раньше здесь стояли боевые значения
// по умолчанию — на публичном хостинге это отдавало счёта и выписки любому,
// кто знал адрес сервиса.
const USERNAME = process.env.DBO_LOGIN
const PASSWORD = process.env.DBO_PASSWORD
const CONFIGURED = !!(USERNAME && PASSWORD)
if (!CONFIGURED) {
  // Не падаем: иначе деплой уходит в бесконечный перезапуск и сервис недоступен целиком.
  // Поднимаемся, но на все банковские запросы честно отвечаем 503.
  console.error('[fatal] Не заданы DBO_LOGIN и DBO_PASSWORD. Задайте их в переменных окружения (на Railway — Variables).')
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
    status: CONFIGURED ? 'ok' : 'misconfigured',
    // Видно в мониторинге, что сервис жив, но креды ДБО не заданы
    dboConfigured: CONFIGURED,
    time: new Date().toISOString(),
  })
})

// Без кредов ДБО банковские маршруты отвечают понятной ошибкой, а не падают
app.use((req, res, next) => {
  if (CONFIGURED || req.path === '/health' || req.method === 'OPTIONS') return next()
  res.status(503).json({
    success: false,
    error: 'Прокси не настроен: не заданы DBO_LOGIN и DBO_PASSWORD',
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
  if (login !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ success: false, error: 'Неверные учетные данные' })
  }
  // Вход отвечает СРАЗУ. Раньше здесь ждали getWhoAmI — полный заход в банк
  // на 40-90 c; на телефоне сервис-воркер обрывал запрос по таймауту и человек
  // видел «Failed to fetch» вместо входа. Имя банка не нужно для входа: пароль
  // уже проверен, а сессию прогреваем фоном, чтобы первый экран открылся быстро.
  res.json({ success: true, name: cachedWhoAmI || login })

  if (!cachedWhoAmI && !whoAmIWarming) {
    whoAmIWarming = true
    getWhoAmI(USERNAME, PASSWORD)
      .then(name => { if (name) { cachedWhoAmI = name; console.log('[login] имя клиента:', name) } })
      .catch(err => console.error('[login] прогрев не удался:', err.message))
      .finally(() => { whoAmIWarming = false })
  }
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
      const pageAccounts = await getAccountsData(USERNAME, PASSWORD)
      let names = []
      try {
        names = await getAccountNames(USERNAME, PASSWORD)
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
    const data = await cached('payments', CACHE_TTL_MS, () => getPaymentsData(USERNAME, PASSWORD))
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
    const list = await getPaymentsData(USERNAME, PASSWORD)
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
    const result = await webpay.submitPayment(USERNAME, PASSWORD, mapPayment(body), { sign: !!body.sign })
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
    const data = await mod.getAccountsDomDebug(USERNAME, PASSWORD)
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
    const data = await getContractorsFromHistory(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[contractors]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/tariffs', async (req, res) => {
  try {
    const data = await getTariffs(USERNAME, PASSWORD)
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
    const data = await transferOwnStructured(USERNAME, PASSWORD, { fromAccount, toAccount, amount, purpose, sign: !!sign })
    invalidateCache()   // появился новый документ — список устарел
    res.json({ success: data.ok !== false, error: data.error || undefined, data })
  } catch (err) {
    console.error('[transfer-own]', err.message)
    res.status(500).json({ success:false, error: err.message })
  }
})

// Документы клиента из структурного интерфейса банка: с идентификаторами,
// настоящими статусами, номерами и назначением. В отличие от /api/payments
// (разбор выписки) не содержит входящих поступлений, зато пригодно для действий
// над документами. Только чтение.
app.get('/api/documents', async (_, res) => {
  try {
    const data = await cached('documents', CACHE_TTL_MS, () => getDocuments(USERNAME, PASSWORD))
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
    const data = await signStart(USERNAME, PASSWORD, { id: req.params.id })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[sign start]', err.message)
    res.status(400).json({ success: false, error: err.message })
  }
})

// Шаг 1.5: опрос подтверждения в PayControl. Пока клиент не нажал в приложении
// на телефоне — банк держит подпись неподтверждённой. Как подтвердит, этот же
// маршрут вернёт stage:'needKey' с серийником токена.
app.get('/api/documents/:id/sign/status', async (req, res) => {
  try {
    const data = await signStatus(USERNAME, PASSWORD, { id: req.params.id })
    res.json({ success: data.stage !== 'error', data })
  } catch (err) {
    console.error('[sign status]', err.message)
    res.status(400).json({ success: false, error: err.message })
  }
})

// Шаг 2: пользователь ввёл ключ с токена — отправляем и ждём PayControl.
app.post('/api/documents/:id/sign/key', async (req, res) => {
  const { key } = req.body || {}
  if (!key) return res.status(400).json({ success: false, error: 'не передан ключ токена' })
  try {
    const data = await signSubmitKey(USERNAME, PASSWORD, { id: req.params.id, key })
    invalidateCache()   // статус документа изменился
    res.json({ success: data.stage !== 'error', data })
  } catch (err) {
    console.error('[sign key]', err.message)
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
    const data = await documentAction(USERNAME, PASSWORD, { id: req.params.id, action, confirm: !!confirm })
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
    const data = await reconDocuments(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[recon]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Разведка REST-эндпоинтов: пробует варианты списка документов, отдаёт сырое.
app.get('/api/recon/doc-model', async (req, res) => {
  try {
    res.json({ success: true, data: await reconDocModel(USERNAME, PASSWORD, { id: req.query.id }) })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/recon/rest', async (_, res) => {
  try {
    const data = await reconRest(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[recon rest]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Разведка формы перевода между своими счетами — только чтение полей.
app.get('/api/recon/transfer', async (_, res) => {
  try {
    const data = await reconTransferForm(USERNAME, PASSWORD)
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
    const data = await getSectionData(USERNAME, PASSWORD, req.params.key)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[section]', req.params.key, err.message)
    res.status(err.message.startsWith('Неизвестный раздел') ? 404 : 500)
      .json({ success: false, error: err.message })
  }
})

app.get('/api/templates', async (req, res) => {
  try {
    const data = await getTemplatesData(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[templates]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments-debug', async (req, res) => {
  try {
    const data = await getPaymentsDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[payments-debug]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/nav-debug', async (req, res) => {
  try {
    const data = await getNavDebug(USERNAME, PASSWORD)
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
    const data = await getAccountsDomDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/statement', async (req, res) => {
  const { account = '', dateFrom, dateTo, format = 'pdf' } = req.query
  try {
    const { buffer, filename, mimeType } = await downloadStatement(USERNAME, PASSWORD, { account, dateFrom, dateTo, format })
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    console.error('[statement]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/logout', async (_, res) => {
  await closeBrowser()
  res.json({ success: true })
})

app.listen(PORT, () => {
  console.log(`Centrinvest proxy on http://localhost:${PORT}`)
})
