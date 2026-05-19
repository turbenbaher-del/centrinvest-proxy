const { chromium } = require('playwright-chromium')

let browser = null
let page = null
let sessionExpiry = 0
let isNewInterface = false

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
      const checkUrl = isNewInterface
        ? 'https://dbo.centrinvest.ru/api-ui/'
        : MAIN_URL
      await page.goto(checkUrl, { timeout: 12000, waitUntil: 'domcontentloaded' })
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

  isNewInterface = page.url().includes('/api-ui')
  console.log('[browser] Interface:', isNewInterface ? 'NEW (/api-ui/)' : 'CLASSIC (ZK)')

  sessionExpiry = Date.now() + 20 * 60 * 1000
  console.log('[browser] Logged in, URL:', page.url())
  return page
}

async function getAccountsData(username, password) {
  const p = await ensureLoggedIn(username, password)

  if (isNewInterface) {
    return getAccountsNewInterface(p)
  } else {
    return getAccountsClassicInterface(p)
  }
}

async function getAccountsNewInterface(p) {
  console.log('[browser] Using new interface to get accounts via API interception')

  // Intercept REST API responses to capture accounts data
  const capturedAccounts = []

  await p.route('**/*', async (route, request) => {
    const url = request.url()
    const response = await route.fetch()
    // Log API calls that might have account data
    if (url.includes('/api') || url.includes('/account') || url.includes('/balance')) {
      try {
        const body = await response.text()
        if (body.includes('balance') || body.includes('account') || body.includes('number')) {
          console.log('[api]', request.method(), url.replace('https://dbo.centrinvest.ru', ''))
          // Look for 20-digit numbers in API responses
          const nums = body.match(/\d{20}/g)
          if (nums) {
            console.log('[api] found numbers:', nums.slice(0, 5))
            nums.forEach(n => capturedAccounts.push(n))
          }
          if (body.length < 3000) console.log('[api] body:', body.substring(0, 500))
        }
      } catch {}
    }
    route.fulfill({ response })
  })

  // Navigate through sections to trigger API calls
  try {
    await p.click('text=Счета и платежи', { timeout: 5000 })
    await p.waitForTimeout(3000)
  } catch {}

  try {
    await p.click('text=Выписка', { timeout: 3000 })
    await p.waitForTimeout(3000)
  } catch {}

  await p.unroute('**/*')

  console.log('[browser] Captured account numbers:', capturedAccounts)

  if (capturedAccounts.length > 0) {
    const seen = new Set()
    return capturedAccounts
      .filter(n => { if (seen.has(n)) return false; seen.add(n); return true })
      .map(number => ({ number, currency: 'RUR', balance: 0, status: 'Открыт' }))
  }

  // Fallback: scrape DOM
  const bodyText = await p.evaluate(() => document.body.innerText)
  console.log('[browser] URL:', p.url())
  console.log('[browser] Page text (2000):', bodyText.substring(0, 2000))

  return []
}

async function getAccountsClassicInterface(p) {
  console.log('[browser] Using classic ZK interface to get accounts')

  try {
    await p.click('text=СЧЕТА', { timeout: 5000 })
    console.log('[browser] Clicked СЧЕТА menu')
  } catch (e) {
    console.log('[browser] Could not click СЧЕТА:', e.message)
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
    const menuText = isNewInterface ? 'Мои документы' : 'ПЛАТЕЖНЫЕ ДОКУМЕНТЫ'
    await p.click(`text=${menuText}`, { timeout: 5000 })
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

async function getWhoAmI(username, password) {
  const p = await ensureLoggedIn(username, password)
  const name = await p.evaluate(() => {
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

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    sessionExpiry = 0
    isNewInterface = false
  }
}

module.exports = { getAccountsData, getPaymentsData, getWhoAmI, closeBrowser }
