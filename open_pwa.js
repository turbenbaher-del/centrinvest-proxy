// Open our PWA in a visible browser (talks to local proxy on :3001). Run:
//   node open_pwa.js
const { chromium } = require('playwright-chromium')
const URL = process.env.PWA_URL || 'http://localhost:5173/pwa-ci/'
;(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
  })
  const ctx = await browser.newContext({ viewport: null })
  const page = await ctx.newPage()
  console.log('Открываю наш PWA:', URL)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  console.log('✅ PWA открыт. Логинься (24cmvKy8 / dbocib14Z) и работай. Закрой окно по завершении.')
  await new Promise((resolve) => { browser.on('disconnected', resolve); page.on('close', resolve) })
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
