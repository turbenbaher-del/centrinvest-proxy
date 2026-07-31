const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/apiresp.jsonl'
const U = process.env.DBO_LOGIN || '24cmvKy8'
const P = process.env.DBO_PASSWORD || 'dbocib14Z'

;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const out = fs.createWriteStream(OUT)
  page.on('response', async (r) => {
    try {
      const url = r.url()
      if (!url.includes('centrinvest.ru')) return
      const ct = r.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await r.text()
      if (body.length > 5) out.write(JSON.stringify({ url: url.replace('https://dbo.centrinvest.ru',''), len: body.length, body }) + '\n')
    } catch {}
  })

  // login
  await page.goto(`${BASE}/ru/html/login.html`, { waitUntil: 'commit', timeout: 30000 })
  await page.waitForSelector('#userName', { timeout: 30000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', U.toLowerCase()); await page.fill('#password', P)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 30000, waitUntil: 'commit' })
  console.log('logged in:', page.url())
  await page.waitForTimeout(6000)

  // drive toward the tariff/limits screen
  const clicks = ['Продукты и услуги', 'Продукты', 'Тарифы', 'Тарифы и лимиты',
    'Перейти в тарифы', 'Посмотреть подключенный тариф', 'Установка/Изменение лимитов',
    'Счета и платежи', 'Настройки', 'Лимиты', 'Ещё']
  for (const label of clicks) {
    try {
      await page.click(`text=${label}`, { timeout: 2000 })
      await page.waitForTimeout(2500)
      console.log('clicked', label)
    } catch {}
  }
  await page.waitForTimeout(3000)
  out.end()
  await b.close()
  console.log('DONE -> apiresp.jsonl')
})()
