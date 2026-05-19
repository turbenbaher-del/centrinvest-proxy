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
        '--single-process',
      ],
    })
  }
  return browser
}

async function ensureLoggedIn(username, password) {
  const now = Date.now()
  if (page && now < sessionExpiry) {
    try {
      await page.goto(MAIN_URL, { timeout: 12000, waitUntil: 'domcontentloaded' })
      if (!page.url().toString().includes('login.html')) {
        return page
      }
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

  try {
    await page.click('#btn', { timeout: 2000 })
  } catch {}

  await page.fill('#userName', username.toLowerCase())
  await page.fill('#password', password)
  await page.click('#submitButton')

  await page.waitForURL(url => !url.toString().includes('login.html'), { timeout: 20000 })
  await page.waitForTimeout(2000)

  // New interface (/api-ui/) — switch back to old ZK interface
  if (page.url().includes('/api-ui')) {
    console.log('[browser] New interface detected, switching to classic ZK...')
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)
  }

  sessionExpiry = Date.now() + 20 * 60 * 1000
  console.log('[browser] Logged in, URL:', page.url())
  return page
}

async function getAccountsData(username, password) {
  const p = await ensureLoggedIn(username, password)

  // Click СЧЕТА menu to ensure accounts section is active
  try {
    await p.click('text=СЧЕТА', { timeout: 5000 })
    console.log('[browser] Clicked СЧЕТА menu')
  } catch (e) {
    console.log('[browser] Could not click СЧЕТА:', e.message)
  }

  // Wait for a row with a 20-digit number to appear (poll up to 20s)
  console.log('[browser] Waiting for account rows...')
  let accounts = []
  for (let attempt = 0; attempt < 8; attempt++) {
    await p.waitForTimeout(2500)

    accounts = await p.evaluate(() => {
      const results = []
      const seen = new Set()
      document.querySelectorAll('td, span, div').forEach(el => {
        const text = el.textContent.trim()
        // Match 20-digit account numbers, possibly formatted with dots (e.g. 40802.810.3.09500000228)
        const stripped = text.replace(/\./g, '')
        if (stripped.match(/^\d{20}$/) && !seen.has(stripped)) {
          seen.add(stripped)
          const row = el.closest('tr') || el.parentElement
          if (row) {
            const cells = Array.from(row.querySelectorAll('td, span')).map(c => c.textContent.trim())
            results.push({
              number: stripped,
              raw: text,
              cells: cells.filter(c => c.length > 0).slice(0, 10),
            })
          }
        }
      })
      return results
    })

    if (accounts.length > 0) break
    console.log(`[browser] Attempt ${attempt + 1}: no accounts yet`)
  }

  // Debug: log page text if still empty
  if (accounts.length === 0) {
    const bodyText = await p.evaluate(() => document.body.innerText)
    console.log('[browser] Page text (first 600):', bodyText.substring(0, 600))
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
          date: cells[0],
          number: cells[1] || '',
          recipient: cells[2] || '',
          amount: parseFloat((cells[3] || '0').replace(/\s/g, '').replace(',', '.')) || 0,
          status: cells[4] || '',
        })
      }
    })
    return results
  })

  return payments
}

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    sessionExpiry = 0
  }
}

async function getWhoAmI(username, password) {
  const p = await ensureLoggedIn(username, password)
  const name = await p.evaluate(() => {
    // ZK renders the user name in the top area
    const selectors = ['.z-identity', '.user-name', 'span.name', 'div.user']
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el?.textContent?.trim()) return el.textContent.trim()
    }
    // Fallback: find the name-looking text near the top (all-caps Cyrillic, 3 words)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim()
      if (t.match(/^[А-ЯЁ][А-ЯЁ\s]{10,}[А-ЯЁ]$/) && t.split(' ').length === 3) {
        return t
      }
    }
    return null
  })
  return name
}

module.exports = { getAccountsData, getPaymentsData, getWhoAmI, closeBrowser }
