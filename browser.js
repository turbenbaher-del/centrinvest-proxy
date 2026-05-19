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
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    })
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

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  try { await page.click('#btn', { timeout: 2000 }) } catch {}
  await page.fill('#userName', username.toLowerCase())
  await page.fill('#password', password)
  await page.click('#submitButton')

  await page.waitForURL(url => !url.toString().includes('login.html'), { timeout: 25000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  console.log('[browser] Logged in, URL:', page.url())
  sessionExpiry = Date.now() + 20 * 60 * 1000
  return page
}

async function getAccountsData(username, password) {
  const p = await ensureLoggedIn(username, password)
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

  // Navigate to accounts/statement section (known to work)
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(3000) } catch {}
  try { await p.click('text=Выписка', { timeout: 3000 }); await p.waitForTimeout(3000) } catch {}

  // Also click on first account row to trigger its transaction API calls
  const clickedAccount = await p.evaluate(() => {
    const rows = document.querySelectorAll('tr, [class*="row"], [class*="item"], li')
    for (const row of rows) {
      if (/\d{5}[.\d]{15,}/.test(row.textContent || '')) {
        row.click()
        return (row.textContent || '').trim().substring(0, 60)
      }
    }
    return null
  })
  if (clickedAccount) {
    console.log('[browser] Clicked account:', clickedAccount)
    await p.waitForTimeout(3000)
  }

  p.off('response', onResponse)
  console.log('[browser] Captured', apiData.length, 'API responses total')

  // Save for payments endpoint to reuse
  cachedApiResponses = apiData

  // Parse account numbers
  const accounts = []
  const seen = new Set()
  for (const { url, body } of apiData) {
    try {
      const nums = body.match(/\d{20}/g) || []
      const dotNums = body.match(/\d{5}\.\d{3}\.\d\.\d{11}/g) || []
      dotNums.forEach(n => nums.push(n.replace(/\./g, '')))
      nums.forEach(n => {
        if (!seen.has(n)) {
          seen.add(n)
          let balance = 0, currency = 'RUR', status = 'Открыт'
          try {
            const parsed = JSON.parse(body)
            const find = (obj, key) => {
              if (!obj || typeof obj !== 'object') return undefined
              if (obj[key] !== undefined) return obj[key]
              for (const v of Object.values(obj)) {
                const r = find(v, key); if (r !== undefined) return r
              }
            }
            balance = parseFloat(find(parsed, 'balance') || find(parsed, 'остаток') || 0) || 0
            currency = find(parsed, 'currency') || find(parsed, 'валюта') || 'RUR'
          } catch {}
          accounts.push({ number: n, currency, balance, status })
        }
      })
    } catch {}
  }

  if (accounts.length === 0) {
    const bodyText = await p.evaluate(() => document.body.innerText)
    console.log('[browser] No accounts found. Page text:', bodyText.substring(0, 400))
  }

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

  // Try "История операций" first (shows all ops), fall back to "Исходящие документы"
  let navigated = await zkClickMenu('История операций')
  if (!navigated) navigated = await zkClickMenu('Исходящие документы')
  console.log('[zk] navigated:', navigated)

  const afterText = await p.evaluate(() => document.body.innerText.substring(0, 800))
  console.log('[zk] Page after nav:', afterText)

  // ZK "История операций" shows a date filter form first — must submit it to load data.
  // Detect the filter form and fill dates: last 90 days.
  const filterSubmitted = await p.evaluate(() => {
    const today = new Date()
    const fmt = (d) => {
      const dd = String(d.getDate()).padStart(2,'0')
      const mm = String(d.getMonth()+1).padStart(2,'0')
      const yyyy = d.getFullYear()
      return `${dd}.${mm}.${yyyy}`
    }
    const from90 = new Date(today - 90*86400000)
    const dateFrom = fmt(from90)
    const dateTo   = fmt(today)

    // Find date inputs (ZK renders them as input[type=text] with date format hints)
    const allInputs = Array.from(document.querySelectorAll('input[type=text], input:not([type])'))
    const dateInputs = allInputs.filter(i => {
      const v = i.value || ''
      const ph = (i.placeholder || '').toLowerCase()
      return /\d{2}\.\d{2}\.\d{4}/.test(v) || ph.includes('дата') || ph.includes('date') ||
             i.className.includes('z-datebox') || (i.closest && i.closest('.z-datebox'))
    })
    console.log('Date inputs found:', dateInputs.length)

    if (dateInputs.length >= 2) {
      // Set from-date and to-date
      const setVal = (el, val) => {
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        nativeInput.set.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('blur', { bubbles: true }))
      }
      setVal(dateInputs[0], dateFrom)
      setVal(dateInputs[1], dateTo)
    }

    // Look for "Показать", "Найти", "OK" buttons in the filter area
    const btnTexts = ['Показать', 'Найти', 'Применить', 'OK', 'Поиск']
    for (const btn of document.querySelectorAll('button, a.z-button, td.z-button')) {
      const t = btn.textContent.trim()
      if (btnTexts.some(b => t === b || t.startsWith(b))) {
        btn.click()
        return `clicked: ${t}`
      }
    }
    // Try ZK button classes
    for (const btn of document.querySelectorAll('.z-button')) {
      const t = btn.textContent.trim()
      if (btnTexts.some(b => t.includes(b))) {
        btn.click()
        return `zk-clicked: ${t}`
      }
    }
    return 'no filter button found'
  })
  console.log('[zk] filter submit result:', filterSubmitted)
  await p.waitForTimeout(6000)

  const extractPaymentRows = () => {
    const results = []
    const seen = new Set()

    const processRows = (selector) => {
      document.querySelectorAll(selector).forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'))
          .map(td => td.textContent.trim())
          .filter(Boolean)
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
        const amtCell = cells.find(c => /^[\d\s]+[,\.]\d{1,2}$/.test(c.trim()))
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
        // Extract just the date part (without time)
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

    processRows('tr.z-listitem, tr.z-row, tr[class*="listitem"], tr[class*="z-list"]')
    if (results.length === 0) processRows('tr')
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
  for (const label of ['История операций', 'Исходящие документы']) {
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

  // Try to submit the date filter
  const filterResult = await p.evaluate(() => {
    const today = new Date()
    const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
    const dateFrom = fmt(new Date(today - 90*86400000))
    const dateTo = fmt(today)

    const inputs = Array.from(document.querySelectorAll('input[type=text], input:not([type])'))
    const dateInputs = inputs.filter(i => /\d{2}\.\d{2}\.\d{4}/.test(i.value) ||
      (i.placeholder||'').toLowerCase().includes('дата'))
    if (dateInputs.length >= 2) {
      const setVal = (el, val) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, val)
        el.dispatchEvent(new Event('input',{bubbles:true}))
        el.dispatchEvent(new Event('change',{bubbles:true}))
        el.dispatchEvent(new Event('blur',{bubbles:true}))
      }
      setVal(dateInputs[0], dateFrom)
      setVal(dateInputs[1], dateTo)
    }
    for (const btn of document.querySelectorAll('button, .z-button, a.z-button')) {
      const t = btn.textContent.trim()
      if (['Показать','Найти','Применить','OK','Поиск'].some(b => t.startsWith(b))) {
        btn.click(); return `clicked: ${t}`
      }
    }
    return `no btn, dateInputs: ${dateInputs.length}`
  })
  await p.waitForTimeout(7000)

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
    return out.slice(0, 40)
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

  return { version: 'v4', clickedLabel, filterResult, pageTextBefore: pageTextBefore.substring(0,600), pageTextAfter: pageTextAfter.substring(0,800), allInputs, allButtons, rows, domSearch }
}

module.exports = { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, closeBrowser }
