const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/transfer.jsonl'
const DOM = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/transfer_dom.txt'
const U = '24cmvKy8', P = 'dbocib14Z'

;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const out = fs.createWriteStream(OUT)
  page.on('response', async (r) => {
    try {
      const u = r.url()
      if (!u.includes('centrinvest.ru')) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const body = await r.text()
      if (body.length > 50) out.write(JSON.stringify({ url: u.replace('https://dbo.centrinvest.ru',''), len: body.length, body }) + '\n')
    } catch {}
  })
  const dismiss = async () => { try { await page.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){const bs=[...m.querySelectorAll('button,[role=button]')]; (bs[bs.length-1]||{click(){}}).click()} }) } catch {} }

  await page.goto(`${BASE}/ru/html/login.html`, { waitUntil: 'commit', timeout: 30000 })
  await page.waitForSelector('#userName', { timeout: 30000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', U.toLowerCase()); await page.fill('#password', P)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 30000, waitUntil: 'commit' })
  await page.waitForTimeout(5000); await dismiss()
  console.log('logged in')

  // navigate toward own-account transfer
  for (const label of ['Оплатить', 'Создать', 'Перевод между своими счетами', 'Между своими счетами',
    'Между счетами', 'Перевод между счетами', 'Перевод', 'Переводы']) {
    try { await dismiss(); await page.click(`text=${label}`, { timeout: 2500 }); await page.waitForTimeout(2500); console.log('clicked', label) } catch {}
  }
  await page.waitForTimeout(2000); await dismiss()

  // dump visible form structure
  const dom = await page.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s))
    return {
      url: location.href,
      title: document.title,
      inputs: q('input,textarea,select').map(e => ({ id:e.id, name:e.name, ph:e.placeholder, type:e.type, label:(e.labels&&e.labels[0]?e.labels[0].innerText:'')||e.getAttribute('aria-label')||'' })).slice(0,40),
      buttons: q('button,[role=button],a').map(e => (e.textContent||'').trim()).filter(t=>t&&t.length<40).slice(0,50),
      headings: q('h1,h2,h3,[class*=title]').map(e=>(e.textContent||'').trim()).filter(Boolean).slice(0,20),
    }
  })
  fs.writeFileSync(DOM, JSON.stringify(dom, null, 1))
  out.end(); await b.close()
  console.log('DONE. url=', dom.url)
})()
