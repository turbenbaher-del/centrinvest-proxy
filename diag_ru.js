const { chromium } = require('playwright-chromium')
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 })
    await page.waitForTimeout(7000)
    const info = await page.evaluate(() => ({
      readyState: document.readyState, title: document.title,
      hasUserName: !!document.querySelector('#userName'),
      bodyLen: document.body ? document.body.innerHTML.length : 0,
      inputs: Array.from(document.querySelectorAll('input')).map(i=>i.id||i.type),
    }))
    console.log(JSON.stringify(info))
  } catch(e){ console.log('ERR', e.message) } finally { await b.close() }
})()
