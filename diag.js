const { chromium } = require('playwright-chromium')
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

;(async () => {
  const headless = process.argv[2] !== 'headed'
  const b = await chromium.launch({ headless })
  const ctx = await b.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await ctx.newPage()
  page.on('response', r => { if (r.url().includes('login.html')) console.log('[resp]', r.status(), r.url(), r.headers()['content-type']) })
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 })
    console.log('committed. url=', page.url())
    // wait a bit for body
    await page.waitForTimeout(6000)
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      hasUserName: !!document.querySelector('#userName'),
      hasBtn: !!document.querySelector('#btn'),
      bodyLen: document.body ? document.body.innerHTML.length : 0,
      bodySnippet: document.body ? document.body.innerHTML.replace(/\s+/g,' ').slice(0, 400) : '(no body)',
      inputs: Array.from(document.querySelectorAll('input')).map(i => i.id || i.name || i.type),
    }))
    console.log(JSON.stringify(info, null, 2))
  } catch (e) {
    console.log('ERR', e.message)
    try { console.log('url on err:', page.url()) } catch {}
  } finally {
    await b.close()
  }
})()
