const { chromium } = require('playwright-chromium')

let browser = null
let page = null
let sessionExpiry = 0

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

  await page.waitForURL(url => !url.toString().includes('login.html'), { timeout: 20000 })
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

// New interface: listen to REST API responses made by Chromium (no Node.js TLS involved)
async function getAccountsViaResponseListener(p) {
  console.log('[browser] Listening to REST API responses...')
  const apiData = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!url.includes('centrinvest.ru')) return
    if (response.status() !== 200) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await response.text()
      if (body.length > 20) {
        console.log('[api]', response.request().method(), url.replace('https://dbo.centrinvest.ru', ''), body.length + 'b')
        if (body.length < 2000) console.log('[api] body:', body.substring(0, 500))
        apiData.push({ url, body })
      }
    } catch {}
  }

  p.on('response', onResponse)

  // Navigate through new interface to trigger account-loading API calls
  try {
    await p.click('text=Счета и платежи', { timeout: 5000 })
    await p.waitForTimeout(3000)
  } catch {}
  try {
    await p.click('text=Выписка', { timeout: 3000 })
    await p.waitForTimeout(3000)
  } catch {}

  p.off('response', onResponse)

  console.log('[browser] Captured', apiData.length, 'API responses')

  // Parse account numbers from captured responses
  const accounts = []
  const seen = new Set()
  for (const { url, body } of apiData) {
    try {
      // Look for 20-digit account numbers
      const nums = body.match(/\d{20}/g) || []
      const dotNums = body.match(/\d{5}\.\d{3}\.\d\.\d{11}/g) || []
      dotNums.forEach(n => nums.push(n.replace(/\./g, '')))
      nums.forEach(n => {
        if (!seen.has(n)) {
          seen.add(n)
          // Try to parse balance from JSON
          let balance = 0, currency = 'RUR', status = 'Открыт'
          try {
            const parsed = JSON.parse(body)
            const find = (obj, key) => {
              if (!obj || typeof obj !== 'object') return undefined
              if (obj[key] !== undefined) return obj[key]
              for (const v of Object.values(obj)) {
                const r = find(v, key)
                if (r !== undefined) return r
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

async function getPaymentsData(username, password) {
  const p = await ensureLoggedIn(username, password)
  try {
    await p.click('text=ПЛАТЕЖНЫЕ ДОКУМЕНТЫ', { timeout: 5000 })
    await p.waitForTimeout(3000)
  } catch {}
  const payments = await p.evaluate(() => {
    const results = []
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim())
      if (cells.length >= 3 && cells[0].match(/\d{2}\.\d{2}\.\d{4}/)) {
        results.push({
          date: cells[0], number: cells[1] || '', recipient: cells[2] || '',
          amount: parseFloat((cells[3] || '0').replace(/\s/g, '').replace(',', '.')) || 0,
          status: cells[4] || '',
        })
      }
    })
    return results
  })
  return payments
}

async function getWhoAmI(username, password) {
  const p = await ensureLoggedIn(username, password)
  const name = await p.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim()
      if (t.match(/^[А-ЯЁ][А-ЯЁ\s]{10,}[А-ЯЁ]$/) && t.split(' ').length === 3) return t
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

module.exports = { getAccountsData, getPaymentsData, getWhoAmI, closeBrowser }
