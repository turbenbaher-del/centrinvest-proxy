// Open a VISIBLE browser through the RU-SOCKS exit, log into DBO, and leave it open
// so the user can send a payment manually. Run:
//   BANK_SOCKS=socks5://127.0.0.1:10810 node open_dbo.js
const { chromium } = require('playwright-chromium')
const USER = (process.env.DBO_LOGIN || '24cmvKy8').toLowerCase()
const PASS = process.env.DBO_PASSWORD || 'dbocib14Z'
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

;(async () => {
  const socks = process.env.BANK_SOCKS
  const browser = await chromium.launch({
    headless: false,
    ...(socks ? { proxy: { server: socks } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
           '--disable-dev-shm-usage', '--start-maximized'],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null })
  const page = await ctx.newPage()

  console.log('Открываю страницу входа (через РФ-выход, может грузиться медленно)...')
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 60000 })
  await page.waitForSelector('#userName', { timeout: 60000, state: 'attached' })
  try { await page.click('#btn', { timeout: 4000 }) } catch {}
  await page.fill('#userName', USER)
  await page.fill('#password', PASS)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 60000, waitUntil: 'commit' })
  console.log('✅ Вошёл в ДБО:', page.url())
  console.log('Браузер оставлен открытым. Делай платёж вручную. Закрой окно, когда закончишь.')

  // keep the process (and browser) alive until the window is closed
  await new Promise((resolve) => {
    browser.on('disconnected', resolve)
    page.on('close', resolve)
  })
  console.log('Окно закрыто — завершаюсь.')
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
