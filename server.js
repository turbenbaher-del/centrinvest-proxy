const express = require('express')
const cors = require('cors')
const { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, getDocuments, closeBrowser } = require('./browser')
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

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {}
  if (login !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ success: false, error: 'Неверные учетные данные' })
  }
  try {
    const name = await getWhoAmI(USERNAME, PASSWORD)
    res.json({ success: true, name: name || login })
  } catch (err) {
    console.error('[login]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/accounts', async (req, res) => {
  try {
    const data = await getAccountsData(USERNAME, PASSWORD)

    // Названия счетов («ГО», «корп.карта») и остатки по каждому счёту банк
    // отдаёт в форме платежа, а не на странице счетов. Если не получилось —
    // отдаём то, что есть: список счетов важнее подписей.
    try {
      const extra = await webpay.getPayerAccounts(USERNAME, PASSWORD)
      const byNumber = new Map(extra.map(a => [a.number, a]))
      for (const acc of data) {
        const e = byNumber.get(String(acc.number).replace(/\D/g, ''))
        if (!e) continue
        if (e.name) acc.name = e.name
        if (e.currency && e.currency !== 'RUR') acc.currency = e.currency
        if (e.balance !== null && e.balance !== undefined) {
          acc.balance = e.balance
          acc.balanceSource = 'form'
        }
      }
      console.log('[accounts] названий подмешано:', data.filter(a => a.name).length)
    } catch (e) {
      console.warn('[accounts] названия счетов недоступны:', e.message)
    }

    res.json({ success: true, data })
  } catch (err) {
    console.error('[accounts]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments', async (req, res) => {
  try {
    const data = await getPaymentsData(USERNAME, PASSWORD)
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
    const data = await transferOwn(USERNAME, PASSWORD, { fromAccount, toAccount, amount, purpose, sign: !!sign })
    res.json({ success: true, data })
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
    const data = await getDocuments(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[documents]', err.message)
    res.status(500).json({ success: false, error: err.message })
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
