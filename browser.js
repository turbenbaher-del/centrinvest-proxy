const { chromium } = require('playwright-chromium')

let browser = null
let page = null
let sessionExpiry = 0
let cachedAccounts = []          // last successful accounts fetch
let cachedApiResponses = []      // all JSON API responses from last full navigation

const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const LOGIN_URL = `${BASE}/ru/html/login.html`
const MAIN_URL = `${BASE}/main.zul`

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    // Банк гео-блокирует иностранные IP → ходим через российский выход (SOCKS).
    // BANK_SOCKS, напр. socks5://127.0.0.1:10810 (локальный xray на RU-сервер RedShield).
    const socks = process.env.BANK_SOCKS
    browser = await chromium.launch({
      headless: true,
      ...(socks ? { proxy: { server: socks } } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    })
    if (socks) console.log('[browser] via SOCKS', socks)
  }
  return browser
}

async function ensureLoggedIn(username, password) {
  const now = Date.now()
  if (page && now < sessionExpiry) {
    try {
      const url = page.url()
      if (!url.includes('login.html')) return page
    } catch {}
  }

  console.log('[browser] Logging in...')
  const b = await getBrowser()
  const ctx = await b.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  page = await ctx.newPage()

  // Сервер держит соединение открытым (стримит) → ждём только commit, а форму — по селектору.
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 })
  await page.waitForSelector('#userName', { timeout: 30000, state: 'attached' })
  // '#btn' раскрывает форму «вход по логину/паролю» (поля скрыты до клика)
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', username.toLowerCase(), { timeout: 15000 })
  await page.fill('#password', password, { timeout: 15000 })
  await page.click('#submitButton')

  await page.waitForURL(url => !url.toString().includes('login.html'), { timeout: 30000, waitUntil: 'commit' })
  await waitForAppReady(page)

  console.log('[browser] Logged in, URL:', page.url())
  sessionExpiry = Date.now() + 20 * 60 * 1000
  return page
}

/**
 * Ждём, пока SPA банка действительно отрисует содержимое.
 *
 * Раньше здесь стояла пауза в 2,5 секунды. На машине с российским каналом этого
 * хватало, а с хостинга — нет: чтение начиналось по пустой странице, и наружу
 * уходил ответ «счетов 0» вместо ошибки. Теперь ждём появления содержимого,
 * а по истечении срока честно пишем в лог, что страница осталась пустой.
 */
async function waitForAppReady(p, timeoutMs = 60000) {
  const started = Date.now()
  const MARKERS = /Счета и платежи|СОБСТВЕННЫЕ СРЕДСТВА|Контрагенты|Мои документы/i

  while (Date.now() - started < timeoutMs) {
    // Модальное окно «обязательно к прочтению» перекрывает интерфейс и мешает отрисовке
    try {
      await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) {
          const bs = Array.from(m.querySelectorAll('button,[role=button]'))
          const b = bs[bs.length - 1]; if (b) b.click(); else m.remove()
        }
      })
    } catch {}

    const text = await p.evaluate(() => document.body.innerText || '').catch(() => '')
    if (text.length > 300 && MARKERS.test(text)) {
      console.log(`[browser] Интерфейс отрисован за ${Math.round((Date.now() - started) / 1000)} c`)
      return true
    }
    await p.waitForTimeout(1500)
  }

  const len = await p.evaluate(() => (document.body.innerText || '').length).catch(() => 0)
  console.warn(`[browser] Интерфейс не отрисовался за ${timeoutMs / 1000} c (текста на странице: ${len} символов)`)
  return false
}

async function getAccountsData(username, password) {
  const p = await ensureLoggedIn(username, password)
  // Если интерфейс банка не отрисовался, читать нечего: лучше вернуть ошибку,
  // чем пустой список — «счетов 0» выглядит как достоверный ответ.
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился — банк не отдал содержимое страницы')
  const currentUrl = p.url()
  console.log('[browser] Getting accounts from:', currentUrl)

  if (currentUrl.includes('/api-ui')) {
    return getAccountsViaResponseListener(p)
  } else {
    return getAccountsClassicZK(p)
  }
}

// New interface: listen to ALL REST API responses during full navigation
// This function is authoritative — it also populates cachedApiResponses for payments
async function getAccountsViaResponseListener(p) {
  console.log('[browser] Full navigation with response capture, URL:', p.url())
  const apiData = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!url.includes('centrinvest.ru')) return
    if (response.status() !== 200) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await response.text()
      if (body.length > 10) {
        console.log('[api]', response.request().method(), url.replace('https://dbo.centrinvest.ru', ''), body.length + 'b')
        if (body.length < 5000) console.log('[api] body:', body.substring(0, 600))
        apiData.push({ url, body })
      }
    } catch {}
  }

  p.on('response', onResponse)

  // Dismiss any "mustRead" modal that blocks navigation
  const dismissed = await p.evaluate(() => {
    const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
    if (!modal) return false
    const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
    const closeBtn = btns.find(b => /закр|ок\b|ok\b|прочит|понят|close|подтв/i.test(b.textContent || '')) || btns[btns.length - 1]
    if (closeBtn) { closeBtn.click(); return 'btn:' + (closeBtn.textContent || '').trim().substring(0, 30) }
    modal.remove()
    return 'removed'
  })
  if (dismissed) { console.log('[browser] Dismissed modal:', dismissed); await p.waitForTimeout(1000) }
  else { await p.keyboard.press('Escape'); await p.waitForTimeout(500) }

  // Navigate to statement section
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(3000) } catch {}
  try { await p.click('text=Выписка', { timeout: 3000 }); await p.waitForTimeout(2000) } catch {}

  // Try clicking the account number to open account switcher and reveal all accounts
  const switcherOpened = await p.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'))
    for (const el of allEls) {
      const t = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
        ? (el.textContent || '').trim() : ''
      if (/^\d{20}$/.test(t) || /^\d{5}\.\d{3}\.\d\.\d{11}$/.test(t)) {
        el.click(); return t
      }
    }
    return null
  })
  if (switcherOpened) { console.log('[browser] Clicked account number:', switcherOpened); await p.waitForTimeout(2000) }

  p.off('response', onResponse)
  console.log('[browser] Captured', apiData.length, 'API responses total')

  // Save for payments endpoint to reuse
  cachedApiResponses = apiData

  // Parse from DOM text — balance is in page header, account num in transaction rows
  const pageBodyText = await p.evaluate(() => document.body.innerText)

  // Balance: look for "СОБСТВЕННЫЕ СРЕДСТВА ... {amount} ₽" in page header
  const ownFundsM = pageBodyText.match(/СОБСТВЕННЫЕ СРЕДСТВА[\s\S]{0,30}?([\d\s]+[.,]\d{2})\s*₽/)
  const currentBalance = ownFundsM
    ? parseFloat(ownFundsM[1].replace(/[\s ]/g, '').replace(',', '.')) : 0
  console.log('[browser] Balance from header:', currentBalance)

  // Account numbers: only valid Russian bank account prefixes
  const accountPrefix = /^(407|408|423|301|455|454|426|427|428|429|430|431)/
  const allNums = [...new Set((pageBodyText.match(/\b\d{20}\b/g) || []).filter(n => accountPrefix.test(n)))]
  console.log('[browser] Account numbers in DOM:', allNums)

  const accounts = []
  const seen = new Set()
  allNums.forEach((num, idx) => {
    if (seen.has(num)) return
    seen.add(num)
    accounts.push({ number: num, currency: 'RUR', balance: idx === 0 ? currentBalance : 0, status: 'Открыт' })
  })

  // Supplement with any account numbers from API responses
  for (const { body } of apiData) {
    try {
      const nums = (body.match(/\b\d{20}\b/g) || []).filter(n => accountPrefix.test(n))
      nums.forEach(n => {
        if (seen.has(n)) return
        seen.add(n)
        accounts.push({ number: n, currency: 'RUR', balance: 0, status: 'Открыт' })
      })
    } catch {}
  }
  console.log('[browser] Parsed accounts:', accounts.map(a => `${a.number}=${a.balance}`))

  console.log('[browser] Found accounts:', accounts.length, accounts.map(a => a.number))
  if (accounts.length > 0) cachedAccounts = accounts
  return accounts
}

// Classic ZK interface: scrape DOM
async function getAccountsClassicZK(p) {
  console.log('[browser] Classic ZK interface')
  try {
    await p.click('text=СЧЕТА', { timeout: 5000 })
  } catch (e) {
    console.log('[browser] СЧЕТА click failed:', e.message)
  }

  let accounts = []
  for (let attempt = 0; attempt < 8; attempt++) {
    await p.waitForTimeout(2500)
    accounts = await p.evaluate(() => {
      const results = []
      const seen = new Set()
      document.querySelectorAll('td, span, div').forEach(el => {
        const text = el.textContent.trim()
        const stripped = text.replace(/\./g, '')
        if (stripped.match(/^\d{20}$/) && !seen.has(stripped)) {
          seen.add(stripped)
          const row = el.closest('tr') || el.parentElement
          if (row) {
            const cells = Array.from(row.querySelectorAll('td, span')).map(c => c.textContent.trim())
            results.push({ number: stripped, raw: text, cells: cells.filter(c => c.length > 0).slice(0, 10) })
          }
        }
      })
      return results
    })
    if (accounts.length > 0) break
    console.log(`[browser] Attempt ${attempt + 1}: no accounts yet`)
  }

  console.log('[browser] Found accounts:', accounts.length, accounts.map(a => a.number))
  return accounts.map(a => {
    const balCell = a.cells.find(c => c.match(/^\d[\d\s]*[,\.]\d{2}$/))
    const balance = balCell ? parseFloat(balCell.replace(/\s/g, '').replace(',', '.')) : 0
    const currency = a.cells.find(c => c.match(/^(RUR|USD|EUR|CNY|GBP)$/)) || 'RUR'
    const status = a.cells.find(c => c.match(/^(Открыт|Закрыт|Заблокирован)$/)) || ''
    return { number: a.number, currency, balance, status }
  })
}

// Parse transactions from the new API-UI interface page text.
// The new interface renders transactions as plain text in this pattern:
//   dd.mm.yyyy
//   № docnum,
//   [optional: счет списания / status lines]
//   ГО (status)
//   COUNTERPARTY NAME
//   description text
//   +/-amount.xx ₽
function parsePaymentLines(text) {
  const payments = []
  const seen = new Set()
  // Start parsing from after "РАСШИРЕННЫЙ ПОИСК" marker to skip nav/header dates
  const markerIdx = text.indexOf('РАСШИРЕННЫЙ ПОИСК')
  const txText = markerIdx >= 0 ? text.substring(markerIdx + 17) : text
  const lines = txText.split('\n').map(l => l.trim()).filter(Boolean)
  const dateRe = /^\d{2}\.\d{2}\.\d{4}$/
  const amtRe = /^([+\-]?\d[\d\s]*[,.]\d{2})\s*₽?$/

  let i = 0
  while (i < lines.length) {
    if (!dateRe.test(lines[i])) { i++; continue }
    const date = lines[i]; i++

    let docNum = '', counterparty = '', desc = '', amount = 0, amountStr = '', status = ''
    const chunk = []
    while (i < lines.length && !dateRe.test(lines[i]) && !amtRe.test(lines[i])) {
      chunk.push(lines[i]); i++
    }
    if (i < lines.length && amtRe.test(lines[i])) {
      const m = lines[i].match(amtRe)
      amountStr = (m[1] || '0').trim()
      amount = parseFloat(amountStr.replace(/\s/g, '').replace(',', '.')) || 0
      i++
    }

    for (const line of chunk) {
      if (/^№\s*[\d\/\-]+,?$/.test(line)) {
        docNum = line.replace(/^№\s*/, '').replace(/,$/, '').trim()
      } else if (/^(ГО|ИСПОЛНЕН|ВЫПОЛНЕН|ОТКЛОНЕН|ОТКЛОНЁН|ЧЕРНОВИК|НА ПОДПИСЬ|В ОБРАБОТКЕ)$/i.test(line)) {
        // Статус документа: раньше строка отбрасывалась и всем операциям
        // жёстко ставился 'executed' — из-за этого фильтры ДБО (черновики,
        // на подпись, в обработке, отклонённые) были неработоспособны.
        status = line.toUpperCase()
      } else if (/^счет /i.test(line) || line === ' ') {
        // skip
      } else if (!counterparty) {
        counterparty = line
      } else {
        desc += (desc ? ' ' : '') + line
      }
    }

    // Направление операции. Если выписка сама дала знак суммы («+2.00 ₽»), он и есть
    // истина: эвристика по префиксу «От:» в новом интерфейсе есть далеко не всегда,
    // и поступления помечались списаниями.
    const byPrefix = /^От:/i.test(counterparty)
    counterparty = counterparty.replace(/^(От|Кому)\s*:\s*/i, '').trim()
    const hadSign = /^[+\-]/.test(amountStr)
    const isIncoming = hadSign ? amount > 0 : byPrefix
    if (!hadSign && amount !== 0) {
      amount = isIncoming ? Math.abs(amount) : -Math.abs(amount)
    }

    if (amount !== 0 && counterparty) {
      const key = `${date}|${docNum}|${amount}`
      if (!seen.has(key)) {
        seen.add(key)
        payments.push({
          // Устойчивый идентификатор операции: банк не отдаёт id документа
          // в выписке, поэтому собираем ключ из даты, номера и суммы.
          id: key,
          date,
          number: docNum,
          recipient: counterparty,
          amount,
          direction: isIncoming ? 'in' : 'out',
          // 'ГО' в выписке = «исполнен банком»; если статус не нашёлся, операция
          // уже в выписке, значит проведена.
          status: status || 'ИСПОЛНЕН',
          purpose: desc,
        })
      }
    }
  }
  return payments
}

function extractPaymentsFromApiData(apiData) {
  const payments = []
  const seen = new Set()
  const getField = (o, ...names) => {
    for (const n of names) {
      for (const k of Object.keys(o)) {
        if (k.toLowerCase().includes(n.toLowerCase())) return o[k]
      }
    }
    return ''
  }
  const scan = (obj) => {
    if (Array.isArray(obj) && obj.length > 0 && obj.length < 2000) {
      for (const item of obj) {
        if (item && typeof item === 'object') {
          const keys = Object.keys(item).map(k => k.toLowerCase())
          const hasDate = keys.some(k => k.includes('date') || k.includes('дата') || k.includes('time'))
          const hasAmount = keys.some(k =>
            k.includes('amount') || k.includes('sum') || k.includes('сумм') ||
            k.includes('debit') || k.includes('credit')
          )
          if (hasDate && hasAmount) {
            const key = JSON.stringify(item).substring(0, 120)
            if (!seen.has(key)) {
              seen.add(key)
              payments.push({
                date: String(getField(item, 'date', 'дата', 'ddate', 'valueDate', 'operDate', 'docDate', 'createDate') || ''),
                number: String(getField(item, 'number', 'num', 'docNum', 'номер', 'id', 'docId', 'docNumber') || ''),
                recipient: String(getField(item, 'recipient', 'payee', 'beneficiary', 'контрагент', 'получатель', 'name', 'payeeName', 'counterparty') || ''),
                amount: parseFloat(String(getField(item, 'amount', 'sum', 'summa', 'сумма', 'debit', 'credit', 'debitAmount') || '0').replace(/\s/g, '').replace(',', '.')) || 0,
                status: String(getField(item, 'status', 'state', 'статус', 'состояние', 'docStatus') || ''),
              })
            }
          }
        }
      }
    } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const v of Object.values(obj)) scan(v)
    }
  }
  for (const { body } of apiData) {
    try { scan(JSON.parse(body)) } catch {}
  }
  return payments
}

async function getPaymentsData(username, password) {
  const p = await ensureLoggedIn(username, password)
  const currentUrl = p.url()
  if (currentUrl.includes('/api-ui')) {
    return getPaymentsViaResponseListener(p)
  } else {
    return getPaymentsClassicZK(p)
  }
}

async function getPaymentsViaResponseListener(p) {
  console.log('[browser] Collecting payment data, URL:', p.url(), 'cached responses:', cachedApiResponses.length)

  // Fast path: scroll to load all transactions, then parse from DOM text.
  const scrollAndParse = async () => {
    let prevCount = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      // Dismiss any modal that might have appeared
      await p.evaluate(() => {
        const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (modal) {
          const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
          const last = btns[btns.length - 1]
          if (last) last.click()
          else modal.remove()
        }
      })
      // Scroll to bottom to trigger infinite load
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await p.waitForTimeout(1500)
      const text = await p.evaluate(() => document.body.innerText)
      const payments = parsePaymentLines(text)
      console.log('[browser] Scroll attempt', attempt + 1, ':', payments.length, 'payments')
      if (payments.length === prevCount && attempt > 0) break  // no new items loaded
      prevCount = payments.length
    }
    const finalText = await p.evaluate(() => document.body.innerText)
    return parsePaymentLines(finalText)
  }
  const domPayments = await scrollAndParse()
  if (domPayments.length > 0) {
    // Тегируем операции счётом выписки (20-значный номер из DOM)
    const acct = await p.evaluate(() => {
      const m = document.body.innerText.match(/\b(4\d{19})\b/)
      return m ? m[1] : ''
    })
    if (acct) domPayments.forEach(pm => { if (!pm.account) pm.account = acct })
    console.log('[browser] Got', domPayments.length, 'payments from DOM text (new interface), account', acct)
    return domPayments
  }

  // Payments can reuse the captured responses from the accounts navigation.
  // Attempt extraction from cached data first.
  if (cachedApiResponses.length > 0) {
    const fast = extractPaymentsFromApiData(cachedApiResponses)
    if (fast.length > 0) {
      console.log('[browser] Got', fast.length, 'payments from cached API responses')
      return fast
    }
    console.log('[browser] Cached responses had no payment data, doing fresh navigation')
  }
  const apiData = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!url.includes('centrinvest.ru')) return
    if (response.status() !== 200) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await response.text()
      if (body.length > 10) {
        console.log('[api tx]', response.request().method(), url.replace('https://dbo.centrinvest.ru', ''), body.length + 'b')
        if (body.length < 5000) console.log('[api tx] body:', body.substring(0, 800))
        apiData.push({ url, body })
      }
    } catch {}
  }

  p.on('response', onResponse)

  // Step 1: log all clickable nav elements so we can see the real structure in logs
  const navLinks = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('a, button, [role="menuitem"], [role="tab"], [role="button"]').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
      const href = el.getAttribute('href') || ''
      if (t.length > 1 && t.length < 60) out.push({ text: t, href })
    })
    return out.slice(0, 60)
  })
  console.log('[browser] Nav items found:', JSON.stringify(navLinks))

  // Step 2: navigate same path that works for accounts
  try { await p.click('text=Счета и платежи', { timeout: 4000 }); await p.waitForTimeout(2500) } catch {}
  try { await p.click('text=Выписка', { timeout: 3000 }); await p.waitForTimeout(3000) } catch {}

  // Step 3: click on the first listed account to load its transactions
  const firstAccountClicked = await p.evaluate(() => {
    const rows = document.querySelectorAll('tr, [class*="account-row"], [class*="AccountRow"], [class*="list-item"]')
    for (const row of rows) {
      const t = row.textContent || ''
      if (t.match(/\d{20}|\d{5}\.\d{3}/)) {
        row.click()
        return (row.textContent || '').trim().substring(0, 80)
      }
    }
    return null
  })
  if (firstAccountClicked) {
    console.log('[browser] Clicked account row:', firstAccountClicked)
    await p.waitForTimeout(3000)
  }

  // Step 4: try payment-keyword nav items
  const payKeywords = ['Платеж', 'платеж', 'Документ', 'История', 'Операци', 'Исходящи', 'Входящи', 'Перевод', 'Транзакци']
  for (const { text } of navLinks) {
    if (payKeywords.some(kw => text.includes(kw))) {
      try {
        console.log('[browser] Clicking:', text)
        await p.click(`text="${text}"`, { timeout: 2000 })
        await p.waitForTimeout(2500)
      } catch {}
    }
  }

  // Step 5: try direct REST API calls from page context (uses browser session/cookies)
  const origin = 'https://dbo.centrinvest.ru'
  const today = new Date().toISOString().split('T')[0]
  const ago90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]

  // Generic paths + account-specific transaction paths
  const accounts4Api = cachedAccounts.length > 0 ? cachedAccounts : [{ number: '' }]
  const tryPaths = [
    '/api/v1/payments', '/api/v1/transactions', '/api/v1/documents',
    '/api/v1/history', '/api/v1/operations', '/api/v1/statements',
    '/api/payments', '/api/documents', '/api/transactions', '/api/operations',
    '/rest/v1/payments', '/rest/v1/transactions',
    // Account-specific paths with known account numbers
    ...accounts4Api.flatMap(a => a.number ? [
      `/api/v1/accounts/${a.number}/transactions`,
      `/api/v1/accounts/${a.number}/statements`,
      `/api/v1/accounts/${a.number}/history`,
      `/api/v1/statements?accountNumber=${a.number}&dateFrom=${ago90}&dateTo=${today}`,
    ] : []),
  ]
  for (const path of tryPaths) {
    try {
      const result = await p.evaluate(async ({ origin, path }) => {
        const r = await fetch(origin + path, { credentials: 'include' })
        if (!r.ok) return null
        const ct = r.headers.get('content-type') || ''
        if (!ct.includes('json')) return null
        const text = await r.text()
        return { url: origin + path, body: text }
      }, { origin, path })
      if (result && result.body.length > 10) {
        console.log('[browser] Direct API hit:', path, result.body.length + 'b', result.body.substring(0, 400))
        apiData.push(result)
      }
    } catch {}
  }

  p.off('response', onResponse)
  console.log('[browser] Total tx API responses captured:', apiData.length)

  const payments = extractPaymentsFromApiData(apiData)

  if (payments.length === 0) {
    const bodyText = await p.evaluate(() => document.body.innerText)
    console.log('[browser] No payments. Page text:', bodyText.substring(0, 600))
    for (const { url, body } of apiData) {
      console.log('[browser] Had response', url.replace('https://dbo.centrinvest.ru', ''), ':', body.substring(0, 200))
    }
  }
  console.log('[browser] Found payments:', payments.length)
  return payments
}

async function getPaymentsClassicZK(p) {
  console.log('[zk] Starting payments navigation')

  // ZK submenus are hidden via CSS until parent menu item is hovered.
  // Use 4 methods in order: standard click → hover-parent+click → force click → JS DOM click.
  const zkClickMenu = async (label) => {
    const subSel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content, td.z-menuitemwrap-content, a.z-menuitem-content'

    // 1. Standard Playwright click (works if item is already visible)
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ timeout: 3000 })
      await p.waitForTimeout(7000)
      console.log(`[zk] std-clicked: ${label}`)
      return true
    } catch {}

    // 2. Hover over each top-level nav item to open its submenu, then click
    const parents = ['ПЛАТЕЖНЫЕ ДОКУМЕНТЫ', 'ПИСЬМА', 'АНАЛИТИКА', 'ВАЛЮТНЫЕ ОПЕРАЦИИ', 'ПРОДУКТЫ И УСЛУГИ', 'СЧЕТА']
    for (const parent of parents) {
      try {
        await p.locator(`text="${parent}"`).first().hover({ timeout: 2000 })
        await p.waitForTimeout(600)
        const el = p.locator(subSel).filter({ hasText: label }).first()
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 2000 })
          await p.waitForTimeout(7000)
          console.log(`[zk] hover(${parent})->clicked: ${label}`)
          return true
        }
      } catch {}
    }

    // 3. Playwright force click (bypasses actionability checks, fires pointer events)
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ force: true, timeout: 3000 })
      await p.waitForTimeout(7000)
      console.log(`[zk] force-clicked: ${label}`)
      return true
    } catch {}

    // 4. Unhide hidden ancestors then click — DOM inspection shows elements exist but
    //    are inside display:none popup containers. Must unhide chain first so ZK
    //    doesn't ignore the click as "element not visible".
    const clicked = await p.evaluate((label) => {
      // Target span.z-menuitemwrap-text (leaf element with exact own text)
      for (const span of document.querySelectorAll('span.z-menuitemwrap-text')) {
        if (span.textContent.trim() !== label) continue
        // Walk ancestors and unhide any display:none containers
        let el = span
        let unhid = 0
        while (el && el !== document.body) {
          if (window.getComputedStyle(el).display === 'none') {
            el.style.display = 'block'
            unhid++
          }
          el = el.parentElement
        }
        // Click the anchor parent which has the ZK event handler
        const a = span.closest('a') || span
        a.click()
        return `unhid-${unhid} cls=${a.className.substring(0, 40)}`
      }
      return null
    }, label)
    if (clicked) {
      console.log(`[zk] js-unhide-click: ${label} => ${clicked}`)
      await p.waitForTimeout(7000)
      return true
    }

    return false
  }

  // "Выписки" (Statement) shows ALL account operations as a flat table with date filter.
  // Fall back to "Исходящие документы" (outgoing only) if "Выписки" isn't found.
  let navigated = await zkClickMenu('Выписки')
  if (!navigated) navigated = await zkClickMenu('Исходящие документы')
  if (!navigated) navigated = await zkClickMenu('История операций')
  console.log('[zk] navigated:', navigated)

  const afterText = await p.evaluate(() => document.body.innerText.substring(0, 800))
  console.log('[zk] Page after nav:', afterText)

  // Switch to "Выписки за период" tab which shows individual transactions with amounts,
  // rather than statement summaries ("Все выписки" tab has no amount column).
  const tabSwitched = await p.evaluate(() => {
    for (const el of document.querySelectorAll('button, td.z-button, a.z-button, .z-button, .z-toolbarbutton, .z-tab, [class*="tab"]')) {
      const t = (el.textContent || '').trim().toUpperCase()
      if (t === 'ВЫПИСКИ ЗА ПЕРИОД') { el.click(); return el.textContent.trim() }
    }
    return null
  })
  if (tabSwitched) {
    console.log('[zk] Switched to tab:', tabSwitched)
    await p.waitForTimeout(5000)
  } else {
    console.log('[zk] ВЫПИСКИ ЗА ПЕРИОД tab not found, staying on current view')
  }

  const today = new Date()
  const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
  const dateFrom = fmt(new Date(today - 90 * 86400000))
  const dateTo   = fmt(today)
  let filterSubmitted = 'no date inputs found'

  try {
    const dateInputs = p.locator('input.z-dateboxwrap-input')
    const count = await dateInputs.count()
    console.log('[zk] z-dateboxwrap-input count:', count)
    if (count >= 2) {
      await dateInputs.first().click({ force: true, timeout: 3000 }).catch(() => {})
      await dateInputs.first().fill(dateFrom).catch(() => {})
      await dateInputs.first().press('Tab').catch(() => {})
      await p.waitForTimeout(300)
      await dateInputs.nth(1).click({ force: true, timeout: 3000 }).catch(() => {})
      await dateInputs.nth(1).fill(dateTo).catch(() => {})
      await dateInputs.nth(1).press('Enter').catch(() => {})
      filterSubmitted = `playwright-fill: ${dateFrom} -> ${dateTo}`
      console.log('[zk] Date inputs filled')
    }
  } catch {}

  const jsResult = await p.evaluate(({ dateFrom, dateTo }) => {
    const inputs = [...document.querySelectorAll('input.z-dateboxwrap-input, input[class*="z-datebox"]')]
    if (inputs.length < 2) return 'no-inputs'
    const set = (el, val) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, val)
      el.dispatchEvent(new Event('input',{bubbles:true}))
      el.dispatchEvent(new Event('change',{bubbles:true}))
      el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',keyCode:13}))
    }
    set(inputs[0], dateFrom); set(inputs[1], dateTo)
    return `js-set-ok`
  }, { dateFrom, dateTo })
  filterSubmitted = `${filterSubmitted || 'no-click'}+${jsResult}`
  await p.waitForTimeout(3000)

  const btnClicked = await p.evaluate(() => {
    const btnTexts = ['Показать', 'Найти', 'Применить', 'Поиск', 'Искать']
    for (const btn of document.querySelectorAll('button, .z-button, a.z-button, td.z-button, .z-toolbarbutton')) {
      const t = btn.textContent.trim()
      if (btnTexts.some(b => t.includes(b))) { btn.click(); return `clicked: ${t}` }
    }
    return null
  })
  console.log('[zk] filter result:', filterSubmitted, '| btn:', btnClicked)
  await p.waitForTimeout(6000)

  const extractPaymentRows = () => {
    const results = []
    const seen = new Set()

    const processRows = (selector, useChildren) => {
      document.querySelectorAll(selector).forEach(row => {
        const cellEls = useChildren
          ? Array.from(row.querySelectorAll('td, .z-listcell, .z-cell, .z-detailtd'))
          : Array.from(row.querySelectorAll('td'))
        const cells = cellEls.map(td => td.textContent.trim()).filter(Boolean)
        if (cells.length < 3) return
        // Accept dates with or without time: 19.05.2026 or 19.05.2026 02:25
        const dateIdx = cells.findIndex(c => /^\d{2}\.\d{2}\.\d{4}/.test(c))
        if (dateIdx === -1) return
        if (cells.some(c =>
          c.includes('за прошлый день') || c.includes('за сегодня') ||
          c.includes('за период') || c === 'Дата' || c === 'Дата операции' ||
          c === 'Номер' || c === 'Сумма' || c === 'Получатель'
        )) return
        // Amount: digits/spaces + comma/dot + 1-2 digits (handles "221,10" and "1 234,56")
        const amtCell = cells.find(c => /^[\d\s]+[,\.]\d{1,2}$/.test(c.trim()) && c.trim() !== '0,00')
        if (!amtCell) return
        const key = cells.slice(0, 4).join('|')
        if (seen.has(key)) return
        seen.add(key)
        const recipientCell = cells.find((c, i) =>
          i !== dateIdx && c.length > 3 &&
          !/^\d{1,}$/.test(c) &&
          !/^\d{2}\.\d{2}\.\d{4}/.test(c) &&
          !/^\d{5}\.\d{3}/.test(c) &&
          !c.includes('за ')
        ) || ''
        const dateRaw = cells[dateIdx]
        const dateOnly = (dateRaw.match(/\d{2}\.\d{2}\.\d{4}/) || [dateRaw])[0]
        results.push({
          date: dateOnly,
          number: cells.find((c, i) => i > dateIdx && /^\d{4,}$/.test(c)) || '',
          recipient: recipientCell,
          amount: parseFloat(amtCell.replace(/\s/g, '').replace(',', '.')) || 0,
          status: cells[cells.length - 1] || '',
        })
      })
    }

    processRows('tr.z-listitem, tr.z-row, tr[class*="listitem"], tr[class*="z-list"]', false)
    if (results.length === 0) processRows('tr', false)
    // Also try ZK detail/grid rows that use non-tr containers
    if (results.length === 0) processRows('[class*="z-detail"], [class*="z-row"], [class*="listitem"]', true)
    return results
  }

  let payments = await p.evaluate(extractPaymentRows)

  // If still empty, try waiting longer and re-extract
  if (payments.length === 0) {
    console.log('[zk] No payments yet, waiting 5s more...')
    await p.waitForTimeout(5000)
    const afterText2 = await p.evaluate(() => document.body.innerText.substring(0, 800))
    console.log('[zk] Page after extra wait:', afterText2)
    payments = await p.evaluate(extractPaymentRows)
  }

  console.log('[zk] Payments found:', payments.length, payments.slice(0, 3))
  return payments
}

async function getWhoAmI(username, password) {
  const p = await ensureLoggedIn(username, password)
  const name = await p.evaluate(() => {
    // Check common profile selectors first
    for (const sel of ['.user-name', '.profile-name', '[data-testid="user-name"]', '.header-user', '.navbar-user']) {
      const el = document.querySelector(sel)
      if (el) { const t = el.textContent.trim(); if (t.length > 5) return t }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim()
      // All-caps: ПОПЕНКОВ СЕРГЕЙ ВАСИЛЬЕВИЧ
      if (t.match(/^[А-ЯЁ][А-ЯЁ\s]{10,}[А-ЯЁ]$/) && t.split(' ').length === 3) return t
      // Mixed-case: Попенков Сергей Васильевич
      if (t.match(/^[А-ЯЁ][а-яё]{2,}\s[А-ЯЁ][а-яё]{2,}\s[А-ЯЁ][а-яё]{2,}$/) && t.split(' ').length === 3) return t
    }
    return null
  })
  return name
}

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    sessionExpiry = 0
  }
}

async function getNavDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  const currentUrl = p.url()

  // Show already-cached API responses
  const cachedUrls = cachedApiResponses.map(r => ({
    url: r.url.replace('https://dbo.centrinvest.ru', ''),
    len: r.body.length,
    preview: r.body.substring(0, 200),
  }))

  // Dump full nav structure + all page text
  const navItems = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('a, button, [role="menuitem"], [role="tab"], [role="button"], li').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
      const href = el.getAttribute('href') || ''
      const cls = el.className || ''
      if (t.length > 1 && t.length < 80) out.push({ text: t, href, cls: cls.substring(0, 60) })
    })
    return out.slice(0, 80)
  })

  const pageText = await p.evaluate(() => document.body.innerText.substring(0, 1000))

  // Try direct API fetch from page context to discover endpoints
  const origin = 'https://dbo.centrinvest.ru'
  const tryPaths = [
    '/api/v1/payments', '/api/v1/transactions', '/api/v1/documents',
    '/api/v1/accounts', '/api/v1/history', '/api/v1/operations',
    '/api-ui/api/v1/accounts', '/api-ui/api/v1/payments',
    '/sbns-web/api/v1/accounts',
  ]
  const directResults = []
  for (const path of tryPaths) {
    try {
      const result = await p.evaluate(async ({ origin, path }) => {
        const r = await fetch(origin + path, { credentials: 'include' })
        const ct = r.headers.get('content-type') || ''
        const body = ct.includes('json') ? await r.text() : '[not json: ' + ct + ']'
        return { path, status: r.status, body: body.substring(0, 300) }
      }, { origin, path })
      directResults.push(result)
    } catch (e) {
      directResults.push({ path, error: e.message })
    }
  }

  return { currentUrl, cachedUrls, navItems, pageText, directResults }
}

async function getTemplatesData(username, password) {
  const p = await ensureLoggedIn(username, password)
  console.log('[zk] Getting templates')

  // "Корреспонденты" is in Справочники submenu — these are payment counterparties/templates
  const sel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content'
  for (const label of ['Корреспонденты', 'Шаблоны', 'Шаблоны платежей']) {
    try {
      const el = p.locator(sel).filter({ hasText: label }).first()
      await el.click({ timeout: 4000 })
      await p.waitForTimeout(6000)
      console.log('[zk] templates nav clicked:', label)
      break
    } catch {}
  }

  const templates = await p.evaluate(() => {
    const results = []
    const seen = new Set()
    document.querySelectorAll('tr.z-listitem, tr.z-row, tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()).filter(Boolean)
      if (cells.length < 2) return
      // A counterparty/template row: has a name (non-numeric, > 3 chars) and account number
      const name = cells.find(c => c.length > 3 && !/^\d+$/.test(c) && !/^\d{2}\.\d{2}/.test(c))
      const account = cells.find(c => /^\d{20}$/.test(c.replace(/\./g, '').replace(/\s/g, '')))
      if (!name || !account) return
      const key = account
      if (seen.has(key)) return
      seen.add(key)
      const bic = cells.find(c => /^\d{9}$/.test(c)) || ''
      results.push({ id: account, name, account: account.replace(/\./g, ''), bank: '', bic, inn: '' })
    })
    return results
  })

  console.log('[zk] Templates found:', templates.length)
  return templates
}

async function getPaymentsDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  console.log('[debug] Current URL:', p.url())

  const subSel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content, td.z-menuitemwrap-content, a.z-menuitem-content'
  let clickedLabel = null
  for (const label of ['Выписки', 'Исходящие документы', 'История операций']) {
    // Try standard click first, then hover parents, then JS force-click
    let done = false
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ timeout: 3000 })
      await p.waitForTimeout(7000); done = true
    } catch {}
    if (!done) {
      for (const parent of ['ПЛАТЕЖНЫЕ ДОКУМЕНТЫ', 'ПИСЬМА', 'АНАЛИТИКА', 'ВАЛЮТНЫЕ ОПЕРАЦИИ', 'ПРОДУКТЫ И УСЛУГИ']) {
        try {
          await p.locator(`text="${parent}"`).first().hover({ timeout: 2000 })
          await p.waitForTimeout(500)
          const el = p.locator(subSel).filter({ hasText: label }).first()
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 2000 })
            await p.waitForTimeout(7000); done = true; break
          }
        } catch {}
      }
    }
    if (!done) {
      const clicked = await p.evaluate((label) => {
        for (const span of document.querySelectorAll('span.z-menuitemwrap-text')) {
          if (span.textContent.trim() !== label) continue
          let el = span; let unhid = 0
          while (el && el !== document.body) {
            if (window.getComputedStyle(el).display === 'none') { el.style.display = 'block'; unhid++ }
            el = el.parentElement
          }
          const a = span.closest('a') || span
          a.click()
          return `unhid-${unhid}`
        }
        return null
      }, label)
      if (clicked) { await p.waitForTimeout(7000); done = true }
    }
    if (done) { clickedLabel = label; break }
  }

  const pageTextBefore = await p.evaluate(() => document.body.innerText.substring(0, 1500))

  // Fill date inputs via Playwright native fill (proper ZK event chain)
  const today2 = new Date()
  const fmt2 = (d) => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
  const dbgDateFrom = fmt2(new Date(today2 - 90*86400000))
  const dbgDateTo = fmt2(today2)
  let filterResult = 'no date inputs'
  try {
    const dbgInputs = p.locator('input.z-dateboxwrap-input')
    const dbgCount = await dbgInputs.count()
    if (dbgCount >= 2) {
      await dbgInputs.first().click({ force: true, timeout: 3000 }).catch(() => {})
      await dbgInputs.first().fill(dbgDateFrom).catch(() => {})
      await dbgInputs.first().press('Tab').catch(() => {})
      await p.waitForTimeout(300)
      await dbgInputs.nth(1).click({ force: true, timeout: 3000 }).catch(() => {})
      await dbgInputs.nth(1).fill(dbgDateTo).catch(() => {})
      await dbgInputs.nth(1).press('Enter').catch(() => {})
      filterResult = `playwright-fill: ${dbgDateFrom}->${dbgDateTo}`
    }
  } catch (e) { filterResult = `error: ${e.message}` }
  // Also try JS setter
  const dbgJs = await p.evaluate(({ df, dt }) => {
    const inputs = [...document.querySelectorAll('input.z-dateboxwrap-input')]
    if (inputs.length < 2) return 'no-inputs'
    const set = (el,v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v)
      el.dispatchEvent(new Event('input',{bubbles:true}))
      el.dispatchEvent(new Event('change',{bubbles:true}))
    }
    set(inputs[0],df); set(inputs[1],dt); return 'js-ok'
  }, { df: dbgDateFrom, dt: dbgDateTo })
  filterResult = `${filterResult}+${dbgJs}`
  // Click Показать if present
  const showClicked = await p.evaluate(() => {
    for (const btn of document.querySelectorAll('button,.z-button,a.z-button,td.z-button')) {
      const t = btn.textContent.trim()
      if (['Показать','Найти','Применить'].some(b => t.includes(b))) { btn.click(); return t }
    }
    return null
  })
  filterResult = `${filterResult}|btn:${showClicked}`
  await p.waitForTimeout(7000)

  // Click the first STATEMENT row (must have 20-digit account number + date).
  // Using this specificity avoids accidentally clicking news/nav z-listitem rows.
  const rowClicked = await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.z-listitem'))
    const stmtRow = rows.find(r => {
      const t = r.textContent || ''
      return /\d{20}/.test(t) && /\d{2}\.\d{2}\.\d{4}/.test(t)
    })
    if (!stmtRow) return null
    stmtRow.click()
    return (stmtRow.textContent || '').trim().substring(0, 100)
  })
  filterResult = `${filterResult}|row:${rowClicked ? 'clicked' : 'null'}`
  if (rowClicked) {
    console.log('[dbg] Clicked statement row:', rowClicked)
    await p.waitForTimeout(10000)
  }

  // After row click: look for any popup/detail window that appeared
  const popupText = await p.evaluate(() => {
    const detailSelectors = ['.z-window', '.z-popup', '[class*="z-detail"]', '[class*="z-panel"]']
    for (const sel of detailSelectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) {
        return { sel, text: (el.textContent || '').trim().substring(0, 800) }
      }
    }
    return null
  })

  // Find DOM structure for amount elements (works for new API-UI interface)
  const amountElements = await p.evaluate(() => {
    const out = []
    const amtRe = /[+\-]?\d[\d\s]*[,.]\d{2}\s*[₽$€]|[+\-]\d+\.?\d*\s*₽/
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (!amtRe.test(t)) continue
      const parent = el.parentElement
      const grand = parent?.parentElement
      out.push({
        tag: el.tagName,
        cls: (el.className || '').substring(0, 60),
        text: t.substring(0, 40),
        parentTag: parent?.tagName,
        parentCls: (parent?.className || '').substring(0, 80),
        grandCls: (grand?.className || '').substring(0, 80),
        rowHtml: (grand?.outerHTML || parent?.outerHTML || '').substring(0, 500),
      })
      if (out.length >= 5) break
    }
    return out
  })

  const pageTextAfter = await p.evaluate(() => document.body.innerText.substring(0, 2000))
  const allInputs = await p.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, value: i.value, placeholder: i.placeholder, cls: i.className.substring(0,40) })).slice(0, 20)
  )
  const allButtons = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button, .z-button')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 20)
  )
  const rows = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()).filter(Boolean)
      if (cells.length >= 2) out.push({ cls: row.className.substring(0,50), cells: cells.slice(0, 8) })
    })
    return out.slice(0, 60)
  })

  // Dump structure around rows containing date-like text (dd.mm.yyyy) to understand DOM
  const dateRowsHtml = await p.evaluate(() => {
    const out = []
    const dateRe = /\d{2}\.\d{2}\.\d{4}/
    // Check non-tr rows too (ZK grid/detail rows use div)
    for (const el of document.querySelectorAll('tr, [class*="z-row"], [class*="z-listitem"], [class*="z-detail"]')) {
      if (dateRe.test(el.textContent || '')) {
        out.push({
          tag: el.tagName,
          cls: (el.className || '').substring(0, 60),
          text: (el.textContent || '').trim().substring(0, 120),
          html: el.outerHTML.substring(0, 400),
        })
        if (out.length >= 10) break
      }
    }
    return out
  })

  // Inspect DOM for target labels — help diagnose why click fails
  const domSearch = await p.evaluate(() => {
    const targets = ['История операций', 'Исходящие документы']
    const results = {}
    for (const label of targets) {
      const found = []
      document.querySelectorAll('*').forEach(el => {
        const t = (el.textContent || '').trim()
        const own = [...(el.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('')
        if (own.includes(label) || t === label) {
          found.push({
            tag: el.tagName,
            cls: (el.className || '').substring(0, 60),
            text: t.substring(0, 60),
            ownText: own.substring(0, 60),
            vis: el.offsetParent !== null,
            display: (window.getComputedStyle(el).display || '').substring(0, 20),
          })
        }
      })
      results[label] = found.slice(0, 6)
    }
    return results
  })

  return { version: 'v14', clickedLabel, filterResult, pageTextBefore: pageTextBefore.substring(0,600), pageTextAfter: pageTextAfter.substring(0,3000), popupText, amountElements, allInputs, allButtons, rows, dateRowsHtml, domSearch }
}

function getApiResponsesDebug() {
  return cachedApiResponses.map(r => ({
    url: r.url.replace('https://dbo.centrinvest.ru', ''),
    length: r.body.length,
    preview: r.body.substring(0, 500)
  }))
}

async function getAccountsDomDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  const before = { url: p.url() }
  const apiCapture = []
  const onResp = async (resp) => {
    if (!resp.url().includes('centrinvest.ru')) return
    if (resp.status() !== 200) return
    try {
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await resp.text()
      if (body.length > 10) apiCapture.push({ url: resp.url().replace('https://dbo.centrinvest.ru', ''), body: body.substring(0, 800) })
    } catch {}
  }
  p.on('response', onResp)
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(3000) } catch (e) { before.clickErr = e.message }
  p.off('response', onResp)
  const domText = await p.evaluate(() => document.body.innerText)
  return {
    urlBefore: before.url,
    urlAfter: p.url(),
    clickErr: before.clickErr,
    apiCapture,
    domTextLength: domText.length,
    domTextPreview: domText.substring(0, 2000),
    accountNumbers: (domText.match(/\b\d{20}\b/g) || []).slice(0, 30)
  }
}



async function getContractorsFromHistory(username, password) {
  // Get full payment list (already handles scrolling and loading)
  const payments = await getPaymentsData(username, password)
  console.log('[contractors] Using', payments.length, 'payments to extract contractors')

  // Self-transfer names to exclude
  const selfNames = /ПОПЕНКОВ|ПАО КБ|ЦЕНТР-ИНВЕСТ|корп\.карта|р\/с Ставрополь/i

  // Aggregate by recipient name — include both directions (incoming = client, outgoing = supplier)
  const byName = {}
  for (const pay of payments) {
    const name = (pay.recipient || '').trim()
    if (!name || selfNames.test(name)) continue
    if (!byName[name]) byName[name] = { name, count: 0 }
    byName[name].count++
  }

  const targets = Object.values(byName).sort((a, b) => b.count - a.count)
  console.log('[contractors] Unique external counterparties:', targets.length, targets.map(t => t.name))

  if (targets.length === 0) return []

  // Return without account/BIC — user fills in or we scrape details later
  return targets.map(t => ({
    id: t.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '_').substring(0, 40) + '_' + Date.now(),
    name: t.name,
    account: '',
    bic: '',
    bank: '',
    inn: '',
  }))
}




async function submitPayment(username, password, paymentData) {
  const p = await ensureLoggedIn(username, password)

  console.log('[browser] Submitting payment:', JSON.stringify(paymentData).substring(0, 200))

  // Dismiss modal if present
  await p.evaluate(() => {
    const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
    if (modal) {
      const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
      const last = btns[btns.length - 1]
      if (last) last.click(); else modal.remove()
    }
  })
  await p.waitForTimeout(500)

  // Click "Оплатить" (Pay) in the nav to open payment form
  try {
    await p.click('text=Оплатить', { timeout: 5000 })
    await p.waitForTimeout(2000)
  } catch {
    // Try "Создать" button
    try {
      await p.click('text=Создать', { timeout: 3000 })
      await p.waitForTimeout(2000)
    } catch (e) {
      throw new Error('Не удалось открыть форму платежа: ' + e.message)
    }
  }

  // If multiple options appear, click "Платёж" or "Платежное поручение"
  try {
    const optionClicked = await p.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a'))
      for (const el of items) {
        const t = (el.textContent || '').trim()
        if (/^(Платёж|Платежное поручение|Платеж)$/i.test(t)) {
          el.click(); return t
        }
      }
      return null
    })
    if (optionClicked) {
      console.log('[browser] Clicked option:', optionClicked)
      await p.waitForTimeout(2000)
    }
  } catch {}

  // Fill recipient account
  const rec = paymentData.recipient || {}
  const fillField = async (labelText, value) => {
    if (!value) return
    try {
      // Try label-based targeting
      const filled = await p.evaluate((args) => {
        const [label, val] = args
        const labels = Array.from(document.querySelectorAll('label, [placeholder]'))
        for (const el of labels) {
          if ((el.textContent || el.getAttribute('placeholder') || '').toLowerCase().includes(label.toLowerCase())) {
            const input = el.tagName === 'LABEL'
              ? document.getElementById(el.htmlFor) || el.nextElementSibling
              : el
            if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
              input.focus()
              input.value = val
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
          }
        }
        return false
      }, [labelText, value])
      if (filled) console.log('[browser] Filled field:', labelText)
    } catch (e) {
      console.log('[browser] Could not fill', labelText, ':', e.message)
    }
  }

  await fillField('счёт получателя', rec.account || '')
  await fillField('расчётный счёт', rec.account || '')
  await p.waitForTimeout(500)
  await fillField('бик', rec.bic || '')
  await fillField('БИК', rec.bic || '')
  await p.waitForTimeout(800)
  await fillField('получател', rec.name || '')
  await fillField('наименование', rec.name || '')
  await fillField('сумм', String(paymentData.amount || ''))
  await fillField('назначение', paymentData.purpose || '')

  // Capture the form state for debugging
  const formState = await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
    return inputs.map(el => ({
      name: el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '',
      value: el.value,
      type: el.tagName
    })).filter(f => f.name || f.value)
  })
  console.log('[browser] Form state after fill:', JSON.stringify(formState).substring(0, 600))

  // Submit the form
  try {
    // Try clicking submit button
    const submitted = await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], button'))
      const submitBtn = btns.find(b => /отправ|подпис|сохран|создат|ok|далее|продолж/i.test(b.textContent || ''))
      if (submitBtn) { submitBtn.click(); return (submitBtn.textContent || '').trim() }
      return null
    })
    if (submitted) {
      console.log('[browser] Clicked submit:', submitted)
      await p.waitForTimeout(3000)
    } else {
      throw new Error('Кнопка отправки не найдена')
    }
  } catch (e) {
    throw new Error('Ошибка отправки формы: ' + e.message)
  }

  // Check result
  const resultText = await p.evaluate(() => document.body.innerText)
  const success = /исполнен|отправлен|принят|сохранён|черновик|создан/i.test(resultText.substring(0, 500))
  const docNum = (resultText.match(/№\s*([\d\/]+)/) || [])[1] || `local-${Date.now()}`

  return {
    ...paymentData,
    id: docNum,
    status: success ? 'created' : 'draft',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  }
}

async function downloadStatement(username, password, { account = '', dateFrom, dateTo, format = 'pdf' }) {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')

  const p = await ensureLoggedIn(username, password)

  // Dismiss modal
  await p.evaluate(() => {
    const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
    if (modal) {
      const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
      const last = btns[btns.length - 1]
      if (last) last.click(); else modal.remove()
    }
  })
  await p.waitForTimeout(800)

  // Navigate to statement section
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(2000) } catch (e) {
    console.log('[statement] nav1 fail:', e.message)
  }
  try { await p.click('text=Выписка', { timeout: 5000 }); await p.waitForTimeout(2000) } catch (e) {
    console.log('[statement] nav2 fail:', e.message)
  }

  console.log('[statement] URL after nav:', p.url())

  // Set date range via DOM evaluation
  if (dateFrom || dateTo) {
    await p.evaluate(({ from, to }) => {
      const allInputs = Array.from(document.querySelectorAll('input'))
      const dateInputs = allInputs.filter(i =>
        i.type === 'date' ||
        /дата|date|от|по|нач|кон/i.test(i.placeholder || '') ||
        /дата|date|от|по|нач|кон/i.test((i.closest('label,div')?.textContent || ''))
      )
      const setVal = (el, val) => {
        if (!el || !val) return
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        if (nativeInputValueSetter) nativeInputValueSetter.call(el, val)
        else el.value = val
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (dateInputs[0] && from) setVal(dateInputs[0], from)
      if (dateInputs[1] && to) setVal(dateInputs[1], to)
    }, { from: dateFrom, to: dateTo })
    await p.waitForTimeout(500)
  }

  // Select format if a selector exists
  const fmtLabels = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', '1c': '1С' }
  const targetLabel = fmtLabels[format] || 'PDF'
  await p.evaluate((lbl) => {
    const els = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], option, label, span'))
    for (const el of els) {
      const t = (el.textContent || '').trim()
      if (t === lbl || t.toUpperCase() === lbl.toUpperCase()) { el.click(); return true }
    }
    return false
  }, targetLabel)
  await p.waitForTimeout(300)

  // Find and click the download button, capture the file
  const dlDir = os.tmpdir()
  await p.context().route('**', route => route.continue())

  let downloadPath = null
  let suggestedFilename = `statement_${dateFrom || 'all'}_${dateTo || 'all'}.${format}`

  // Try using Playwright download event
  try {
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 25000 }),
      p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'))
        const btn = btns.find(b => /скачат|выгруз|экспорт|download|print/i.test(b.textContent || b.title || ''))
        if (btn) { btn.click(); return (btn.textContent || '').trim() }
        return null
      })
    ])
    const tmpPath = path.join(dlDir, `statement_${Date.now()}.tmp`)
    await download.saveAs(tmpPath)
    suggestedFilename = download.suggestedFilename() || suggestedFilename
    downloadPath = tmpPath
    console.log('[statement] Downloaded via event:', suggestedFilename, 'size:', fs.statSync(tmpPath).size)
  } catch (e) {
    console.log('[statement] Download event failed:', e.message)
    // Fallback: intercept via network response
    throw new Error('Кнопка скачивания не найдена или загрузка не запустилась: ' + e.message)
  }

  const buffer = fs.readFileSync(downloadPath)
  try { fs.unlinkSync(downloadPath) } catch {}

  const mimeTypes = {
    pdf:  'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv:  'text/csv; charset=utf-8',
    '1c': 'text/plain; charset=windows-1251',
  }

  return { buffer, filename: suggestedFilename, mimeType: mimeTypes[format] || 'application/octet-stream' }
}

// Реальные тарифы/лимиты: открываем экран «Продукты → Тарифы» и вынимаем поля label→value.
// Перевод между своими счетами. sign=false → только черновик (деньги не уходят);
// sign=true → «Подписать и отправить» (PayControl-пуш, деньги уходят после подтверждения на телефоне).
// Реальный маппинг прозвище↔номер (счета ИП Попенкова)
const OWN_ACCOUNTS = {
  '40802810600000018205': 'ГО',
  '40802810520000018686': 'корп.карта',
  '40802810309500000228': 'р/с Ставрополь',
}
async function transferOwn(username, password, { fromAccount, toAccount, amount, purpose = '', sign = false }) {
  const p = await ensureLoggedIn(username, password)
  const log = (...a) => console.log('[transfer]', ...a)
  // счёт может прийти номером ИЛИ прозвищем — нормализуем к прозвищу (форма показывает прозвища)
  const toAlias = (x) => OWN_ACCOUNTS[x] || x
  const fromAliasName = toAlias(fromAccount)
  const toAliasName = toAlias(toAccount)
  const dismiss = async () => { try { await p.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){const bs=[...m.querySelectorAll('button,[role=button]')]; (bs[bs.length-1]||{click(){}}).click()} }) } catch {} }

  await p.waitForTimeout(500); await dismiss()

  // 1) навигация к форме перевода между своими счетами
  for (const label of ['Оплатить', 'Создать', 'Перевод между своими счетами', 'Между своими счетами', 'Перевод между счетами']) {
    try { await dismiss(); await p.click(`text=${label}`, { timeout: 2500 }); await p.waitForTimeout(2000); log('clicked', label) } catch {}
  }
  await p.waitForTimeout(1500); await dismiss()

  const title = await p.title().catch(()=> '')
  log('form title:', title)

  // 2) выбрать счёт по ПРОЗВИЩУ (форма показывает «ГО – 151.09 ₽» и т.п.).
  //    Открываем дропдаун JS-кликом (в обход перехвата span'ом), опцию тоже кликаем JS.
  const pickAccount = async (fieldName, alias) => {
    try {
      // force-клик открывает дропдаун (в обход перехвата наложенным span'ом)
      await p.click(`[name="${fieldName}"]`, { force: true, timeout: 5000 })
      await p.waitForTimeout(1300)
      const res = await p.evaluate((al) => {
        const els = Array.from(document.querySelectorAll('[role="option"],li,[class*="option"],[class*="item"],div,span'))
        const norm = e => (e.textContent || '').replace(/\s+/g, ' ').trim()
        const el = els.find(e => { const t = norm(e); return t.length < 120 && t.startsWith(al) })
        if (el) { el.click(); return { picked: norm(el).slice(0, 60) } }
        // debug: собрать похожие на счета опции
        const opts = [...new Set(els.map(norm).filter(t => t && t.length < 120 && /₽|р\/с|ГО|корп|счет|ЦЕНТР/i.test(t)))].slice(0, 12)
        return { picked: null, opts }
      }, alias)
      const ok = !!res.picked
      log('pick', fieldName, alias, '->', res.picked || ('NULL; opts=' + JSON.stringify(res.opts)))
      if (!ok) { await p.keyboard.press('Escape').catch(() => {}) }
      await p.waitForTimeout(900)
      return !!ok
    } catch (e) { log('pick fail', fieldName, e.message); return false }
  }

  await pickAccount('payerAccount', fromAliasName)
  await pickAccount('receiverAccount', toAliasName)

  // 3) сумма + назначение (обычные инпуты)
  const fill = async (name, val) => {
    try { await p.fill(`[name="${name}"]`, String(val), { timeout: 4000 }); log('filled', name, val) }
    catch (e) { log('fill fail', name, e.message) }
  }
  await fill('documentSum', amount)
  if (purpose) await fill('paymentPurpose', purpose)
  await p.waitForTimeout(800)

  // 4) снять состояние формы
  const formState = await p.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s))
    const val = (n) => { const e=document.querySelector(`[name="${n}"]`); return e ? (e.value || e.textContent || '') : null }
    return { payer: val('payerAccount'), receiver: val('receiverAccount'), sum: val('documentSum'), purpose: val('paymentPurpose') }
  })
  log('form state:', JSON.stringify(formState))

  // 5) сохранить черновик или подписать+отправить
  const btnLabel = sign ? 'Подписать и отправить' : 'Сохранить'
  let clicked = null
  try {
    clicked = await p.evaluate((lbl) => {
      const bs = Array.from(document.querySelectorAll('button,[role="button"],a'))
      const b = bs.find(x => (x.textContent||'').trim().toLowerCase() === lbl.toLowerCase())
        || bs.find(x => (x.textContent||'').trim().toLowerCase().includes(lbl.toLowerCase()))
      if (b) { b.click(); return (b.textContent||'').trim() }
      return null
    }, btnLabel)
    log('action button:', clicked)
  } catch (e) { log('action fail', e.message) }
  await p.waitForTimeout(sign ? 6000 : 3000)
  await dismiss()

  // 6) результат (текст экрана — статус/ошибка/запрос PayControl)
  const result = await p.evaluate(() => (document.body.innerText || '').replace(/\s+/g,' ').slice(0, 1200))
  return { formState, actionClicked: clicked, signed: !!sign, screen: result }
}

let cachedTariffs = []
async function getTariffs(username, password) {
  const p = await ensureLoggedIn(username, password)
  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!(u.includes('/api/v1/execution') || u.includes('/api/v1/menu/click')) || r.status() !== 200) return
      const ct = r.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const b = await r.text()
      if (b.length > 100) bodies.push(b)
    } catch {}
  }
  p.on('response', onResp)   // слушатель ДО навигации

  const dismiss = async () => {
    try {
      await p.evaluate(() => {
        const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (modal) {
          const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
          const b = btns[btns.length - 1]; if (b) b.click(); else modal.remove()
        }
      })
    } catch {}
  }

  await p.waitForTimeout(1500)
  await dismiss()

  // Пройти к экрану тарифов прямо с текущего (post-login) экрана
  for (const label of ['Продукты и услуги', 'Продукты', 'Тарифы и лимиты', 'Тарифы',
    'Посмотреть подключенный тариф', 'Перейти в тарифы', 'Установка/Изменение лимитов', 'Ещё']) {
    try {
      await dismiss()
      await p.click(`text=${label}`, { timeout: 2500 })
      await p.waitForTimeout(2500)
      console.log('[tariffs] clicked', label)
    } catch {}
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  // Извлечь тарифные поля
  const re = /(плата за|тариф|овердрафт|лимит|комисс|СБП)/i
  const items = []
  const seen = new Set()
  const walk = (n) => {
    if (n && typeof n === 'object') {
      if (!Array.isArray(n)) {
        const l = n.label, v = n.value
        if (typeof l === 'string' && typeof v === 'string' && v.trim() && re.test(l) && !seen.has(l.trim())) {
          seen.add(l.trim())
          items.push({ label: l.trim(), value: v.trim() })
        }
        for (const k of Object.keys(n)) walk(n[k])
      } else {
        for (const x of n) walk(x)
      }
    }
  }
  for (const b of bodies) { try { walk(JSON.parse(b)) } catch {} }
  console.log('[tariffs] parsed', items.length, 'fields from', bodies.length, 'execution responses')
  // кэшируем последний удачный (тарифы стабильны); при слабом результате отдаём кэш
  if (items.length >= 3) { cachedTariffs = items; return items }
  return cachedTariffs.length ? cachedTariffs : items
}

// ─── Разделы ДБО ────────────────────────────────────────────────────────────
// Обобщение приёма, на котором работают тарифы: слушаем JSON банка, проходим
// по пунктам меню раздела и вытаскиваем пары «подпись — значение» + строки таблиц.
// Так один механизм закрывает кредиты, депозиты, эквайринг, АУСН и т.п.
const DBO_SECTIONS = {
  credits:    { title: 'Мои кредиты',        labels: ['Мои кредиты', 'Кредиты'] },
  deposits:   { title: 'Мои депозиты',       labels: ['Мои депозиты', 'Депозиты'] },
  acquiring:  { title: 'Эквайринг',          labels: ['Эквайринг'] },
  ausn:       { title: 'АУСН',               labels: ['АУСН', 'Инструкция АУСН'] },
  salary:     { title: 'Зарплатный проект',  labels: ['Зарплатный проект', 'Зарплатный'] },
  documents:  { title: 'Мои документы',      labels: ['Мои документы', 'Документы'] },
  bonus:      { title: 'Бонус за партнёра',  labels: ['Бонус за партнера', 'Бонус за партнёра'] },
  services:   { title: 'Сервисы',            labels: ['Сервисы'] },
  products:   { title: 'Прочие продукты',    labels: ['Прочие продукты'] },
  // Подразделы «Счетов и платежей»
  bulk:       { title: 'Массовые платежи',   labels: ['Массовые платежи'] },
  invoices:   { title: 'Счета на оплату',    labels: ['Счета на оплату'] },
  stmtorders: { title: 'Запросы выписок',    labels: ['Запросы выписок'] },
}

const sectionCache = {}

async function getSectionData(username, password, key) {
  const section = DBO_SECTIONS[key]
  if (!section) throw new Error('Неизвестный раздел: ' + key)

  const p = await ensureLoggedIn(username, password)
  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!(u.includes('/api/v1/execution') || u.includes('/api/v1/menu/click')) || r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const b = await r.text()
      if (b.length > 100) bodies.push(b)
    } catch {}
  }
  p.on('response', onResp)

  const dismiss = async () => {
    try {
      await p.evaluate(() => {
        const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (modal) {
          const btns = Array.from(modal.querySelectorAll('button, [role="button"]'))
          const b = btns[btns.length - 1]; if (b) b.click(); else modal.remove()
        }
      })
    } catch {}
  }

  await p.waitForTimeout(1200)
  await dismiss()

  let navigated = false
  for (const label of section.labels) {
    try {
      await dismiss()
      await p.click(`text=${label}`, { timeout: 3000 })
      await p.waitForTimeout(2500)
      navigated = true
      console.log(`[section:${key}] clicked`, label)
      break
    } catch {}
  }
  await p.waitForTimeout(1200)
  p.off('response', onResp)

  // Собираем все пары label/value — какие именно поля отдаёт раздел, заранее неизвестно
  const fields = []
  const seen = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const l = n.label, v = n.value
    if (typeof l === 'string' && l.trim() && (typeof v === 'string' || typeof v === 'number')) {
      const val = String(v).trim()
      const kk = l.trim() + '=' + val
      if (val && !seen.has(kk)) { seen.add(kk); fields.push({ label: l.trim(), value: val }) }
    }
    Object.keys(n).forEach(k => walk(n[k]))
  }
  for (const b of bodies) { try { walk(JSON.parse(b)) } catch {} }

  // Текст экрана — чтобы показать раздел, даже если структурных полей банк не дал
  const screenText = await p.evaluate(() => (document.body.innerText || '').slice(0, 4000)).catch(() => '')

  const result = {
    key,
    title: section.title,
    navigated,
    fields,
    screenText,
    responses: bodies.length,
  }

  // Кэшируем последний непустой результат: разделы меняются редко,
  // а навигация по DOM банка иногда не срабатывает с первого раза
  if (fields.length > 0 || screenText.length > 200) sectionCache[key] = result
  return sectionCache[key] || result
}

/**
 * Документы из структурного интерфейса ДБО.
 *
 * В отличие от разбора текста выписки (getPaymentsData) здесь у каждого документа
 * есть идентификатор банка, настоящий статус, номер и назначение — банк отдаёт
 * платежи отдельными формами на каждый статус: ui/payments/draft, partlySigned,
 * inProcess, completed, canceled.
 *
 * Важно: это исходящие документы клиента. Входящие поступления сюда не попадают —
 * они видны только в выписке.
 *
 * Только чтение: переходы по вкладкам статусов, никаких действий над документами.
 */
const PAYMENT_FORMS = {
  'ui/payments/draft':         { status: 'ЧЕРНОВИК',    tab: 'Черновики' },
  'ui/payments/partlySigned':  { status: 'НА ПОДПИСЬ',  tab: 'На подпись' },
  'ui/payments/inProcess':     { status: 'В ОБРАБОТКЕ', tab: 'В обработке' },
  'ui/payments/canceled':      { status: 'ОТКЛОНЕН',    tab: 'Отклоненные' },
  'ui/payments/completed':     { status: 'ИСПОЛНЕН',    tab: 'Выполненные' },
}

/** Поля сетки приходят то простым значением, то обёрткой {value: …}. */
const fieldValue = (x) => {
  if (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) return x.value
  return x
}

const toAmount = (x) => {
  const raw = String(fieldValue(x) ?? '').replace(/\s/g, '').replace(',', '.')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

async function getDocuments(username, password) {
  const p = await ensureLoggedIn(username, password)
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился — банк не отдал содержимое страницы')

  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!u.includes('/api/v1')) return
      if (r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const body = await r.text()
      if (body.length > 100) bodies.push(body)
    } catch {}
  }
  p.on('response', onResp)

  const dismiss = async () => {
    try {
      await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) {
          const bs = Array.from(m.querySelectorAll('button,[role=button]'))
          const b = bs[bs.length - 1]; if (b) b.click(); else m.remove()
        }
      })
    } catch {}
  }

  // Открываем платежи и проходим по вкладкам статусов — каждая отдаёт свою форму
  const visited = []
  for (const label of ['Платежи', ...Object.values(PAYMENT_FORMS).map(f => f.tab)]) {
    try {
      await dismiss()
      await p.click(`text=${label}`, { timeout: 3000 })
      await p.waitForTimeout(2500)
      visited.push(label)
    } catch {}
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  const documents = []
  const seen = new Set()

  for (const body of bodies) {
    let parsed
    try { parsed = JSON.parse(body) } catch { continue }
    for (const cmd of (parsed.commands || [])) {
      const form = PAYMENT_FORMS[cmd.instanceName || '']
      if (!form) continue

      const items = cmd.fields?.payments?.items
      if (!Array.isArray(items)) continue

      for (const it of items) {
        const id = String(fieldValue(it.id) ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)

        // Статус берём из самого документа, а вкладку используем как запасной вариант
        const stateName = String(fieldValue(it.stateName) ?? '').trim()

        documents.push({
          id,
          number: String(fieldValue(it.docNumber) ?? '').trim(),
          account: String(fieldValue(it.payerAccount) ?? '').replace(/\D/g, ''),
          recipient: String(fieldValue(it.receiverName) ?? '').trim(),
          purpose: String(fieldValue(it.paymentPurpose) ?? '').trim(),
          // Документы в этих формах — исходящие, поэтому сумма со знаком минус
          amount: -Math.abs(toAmount(it.documentSum)),
          direction: 'out',
          status: stateName || form.status,
          stateCode: String(fieldValue(it.stateCode) ?? '').trim(),
          form: cmd.instanceName,
          // Что банк разрешает делать с этим документом
          actions: Array.isArray(it.actions) ? it.actions : Object.keys(it.actions || {}),
        })
      }
    }
  }

  console.log(`[documents] вкладок пройдено: ${visited.length}, документов: ${documents.length}`)
  return documents
}

/**
 * Разведка документного API: ищем, каким запросом банк отдаёт список документов
 * с идентификаторами и какие действия над ними доступны (подпись, удаление).
 * Сейчас платежи снимаются парсингом текста выписки, где id нет вовсе, —
 * поэтому подпись и удаление документов ДБО невозможны.
 *
 * ТОЛЬКО ЧТЕНИЕ: переходим по разделам документов и записываем трафик /api/v1.
 * Кнопки подписи, отправки и удаления не нажимаются — деньги не двигаются.
 */
async function reconDocuments(username, password) {
  const p = await ensureLoggedIn(username, password)
  const traffic = []

  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!u.includes('/api/v1') && !u.includes('/api-ui')) return
      if (r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const body = await r.text()
      if (body.length < 50) return
      traffic.push({
        url: u.replace('https://dbo.centrinvest.ru', ''),
        method: r.request().method(),
        size: body.length,
        body,
      })
    } catch {}
  }
  p.on('response', onResp)

  const dismiss = async () => {
    try {
      await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) {
          const bs = Array.from(m.querySelectorAll('button,[role=button]'))
          const b = bs[bs.length - 1]; if (b) b.click(); else m.remove()
        }
      })
    } catch {}
  }

  await p.waitForTimeout(1200)
  await dismiss()

  const visited = []
  for (const label of ['Платежи', 'Черновики', 'На подпись', 'В обработке', 'Отклоненные', 'Выполненные']) {
    try {
      await dismiss()
      await p.click(`text=${label}`, { timeout: 3000 })
      await p.waitForTimeout(2500)
      visited.push(label)
    } catch {}
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  // Что в ответах похоже на идентификаторы документов и действия над ними
  const idKeys = new Set()
  const idSamples = []
  const actions = new Set()
  const instances = new Set()

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    for (const [k, v] of Object.entries(node)) {
      if (/^(id|documentId|docId|uid|guid|instanceToken)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        idKeys.add(k)
        if (idSamples.length < 20) idSamples.push({ key: k, value: String(v).slice(0, 60) })
      }
      if (k === 'actions' && v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(a => actions.add(a))
      }
      if (k === 'instanceName' && typeof v === 'string') instances.add(v)
      walk(v)
    }
  }
  for (const t of traffic) { try { walk(JSON.parse(t.body)) } catch {} }

  // Скелет структуры форм с платежами: только имена полей и типы, без значений.
  // Нужен, чтобы понять, где лежит идентификатор документа и какие действия
  // доступны у конкретной строки — по этому строится подпись и удаление.
  const skeleton = (node, depth = 0) => {
    if (depth > 4) return '…'
    if (node === null) return 'null'
    if (Array.isArray(node)) {
      return node.length ? [`массив(${node.length})`, skeleton(node[0], depth + 1)] : 'массив(0)'
    }
    if (typeof node !== 'object') return typeof node
    const out = {}
    for (const k of Object.keys(node).slice(0, 40)) out[k] = skeleton(node[k], depth + 1)
    return out
  }

  const structures = {}
  for (const t of traffic) {
    let parsed
    try { parsed = JSON.parse(t.body) } catch { continue }
    for (const cmd of (parsed.commands || [])) {
      const name = cmd.instanceName || ''
      if (!/payments|mainForm/i.test(name)) continue
      if (structures[name]) continue
      structures[name] = {
        actions: Object.keys(cmd.actions || {}),
        fields: skeleton(cmd.fields, 1),
      }
    }
  }

  return {
    visitedSections: visited,
    responses: traffic.length,
    endpoints: [...new Set(traffic.map(t => `${t.method} ${t.url.split('?')[0]}`))].sort(),
    idKeys: [...idKeys],
    idSamples,
    // Здесь ищем что-то вроде _sign, _delete, _remove — это и есть ключ к подписи
    actions: [...actions].sort(),
    instances: [...instances].sort().slice(0, 150),
    structures,
  }
}

module.exports = { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, getDocuments, closeBrowser }
