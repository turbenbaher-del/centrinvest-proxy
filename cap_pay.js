// Capture the api-ui payment flow: login (RU-SOCKS), record all /api/v1 req+resp,
// grab a fresh authToken + the menu, then dump for analysis. Run:
//   BANK_SOCKS=socks5://127.0.0.1:10810 node cap_pay.js
const { chromium } = require('playwright-chromium')
const fs = require('fs')

const USER = (process.env.DBO_LOGIN || '24cmvKy8').toLowerCase()
const PASS = process.env.DBO_PASSWORD || 'dbocib14Z'
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

;(async () => {
  const socks = process.env.BANK_SOCKS
  const browser = await chromium.launch({
    headless: true,
    ...(socks ? { proxy: { server: socks } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()

  const log = []
  let authToken = null
  const isApi = u => u.includes('/api/v1/') || u.includes('/api-ui/api/')
  page.on('request', req => {
    const u = req.url()
    if (!isApi(u)) return
    const t = req.headers()['authtoken']; if (t) authToken = t
    let body = null; try { body = req.postData() } catch {}
    log.push({ dir: 'REQ', method: req.method(), url: u.replace('https://dbo.centrinvest.ru', ''), body })
  })
  page.on('response', async resp => {
    const u = resp.url()
    if (!isApi(u)) return
    let body = null
    try { const ct = resp.headers()['content-type'] || ''; if (ct.includes('json')) body = (await resp.text()).slice(0, 6000) } catch {}
    log.push({ dir: 'RESP', status: resp.status(), url: u.replace('https://dbo.centrinvest.ru', ''), body })
  })

  console.log('login...')
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 40000 })
  await page.waitForSelector('#userName', { timeout: 40000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', USER); await page.fill('#password', PASS)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 40000, waitUntil: 'commit' })
  const urlTok = (page.url().match(/authToken=([0-9a-f-]+)/) || [])[1]
  if (urlTok) authToken = urlTok
  console.log('logged in ->', page.url())
  // slow SPA: wait for it to make its API calls (menu, accounts). Poll until traffic settles.
  let prev = 0
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500)
    if (log.length === prev && log.length > 3) break
    prev = log.length
  }

  await page.waitForTimeout(9000)

  const dump = async (tag) => {
    try { await page.screenshot({ path: `_${tag}.png` }) } catch {}
    const ui = await page.evaluate(() => {
      const texts = new Set()
      document.querySelectorAll('a,button,[role="button"],li,[class*="item"],[class*="menu"] *').forEach(el => {
        const t = (el.innerText || el.textContent || '').trim()
        if (t && t.length < 45 && !t.includes('\n')) texts.add(t)
      })
      return { clickable: [...texts].slice(0, 120) }
    })
    console.log(`\n[${tag}] clickable: ${ui.clickable.join(' | ')}`)
  }
  const clickText = async (rx) => {
    const h = await page.evaluateHandle((pattern) => {
      const re = new RegExp(pattern, 'i')
      const els = [...document.querySelectorAll('a,button,[role="button"],li,span,div')]
      return els.find(e => re.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 45) || null
    }, rx)
    const el = h.asElement()
    if (!el) { console.log('  no match for', rx); return false }
    try { await el.click({ timeout: 5000 }); return true } catch (e) { console.log('  click err', e.message); return false }
  }

  const visibleText = async () => page.evaluate(() => {
    const out = []
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length) return
      const t = (el.innerText || '').trim()
      const r = el.getBoundingClientRect()
      if (t && t.length < 50 && r.width > 0 && r.height > 0) out.push(t)
    })
    return [...new Set(out)]
  })

  await dump('dash')
  console.log('\n>>> click Создать')
  try { await page.locator('button:has-text("Создать"), :text("Создать")').first().click({ force: true, timeout: 8000 }) } catch (e) { console.log('  err', e.message) }
  await page.waitForTimeout(4000)
  await page.screenshot({ path: '_create.png' })
  console.log('[create dropdown text]:', (await visibleText()).join(' | ').slice(0, 900))

  // click "Платеж контрагенту" exactly (r030contragent form)
  console.log('\n>>> click Платеж контрагенту')
  const before = log.length
  try {
    await page.getByText('Платеж контрагенту', { exact: true }).first().click({ force: true, timeout: 8000 })
    console.log('  clicked')
  } catch (e) { console.log('  err', e.message) }
  await page.waitForTimeout(9000)
  console.log('  new api events:', log.length - before)
  await page.screenshot({ path: '_form.png' })
  console.log('[form text]:', (await visibleText()).join(' | ').slice(0, 500))

  // Fill via a template (own transfer to Ц-и = safest), then SAVE AS DRAFT (no money). Capture doActions.
  console.log('\n>>> pick template "Себе на карту ФЛ в Ц-и"')
  try { await page.getByText('Себе на карту ФЛ в Ц-и', { exact: false }).first().click({ force: true, timeout: 8000 }); console.log('  template clicked') } catch (e) { console.log('  err', e.message) }
  await page.waitForTimeout(7000)
  await page.screenshot({ path: '_filled.png' })
  console.log('[filled text]:', (await visibleText()).join(' | ').slice(0, 600))

  console.log('\n>>> click Сохранить (draft — no money)')
  const b2 = log.length
  try { await page.getByText('Сохранить', { exact: true }).first().click({ force: true, timeout: 8000 }); console.log('  saved') } catch (e) { console.log('  err', e.message) }
  await page.waitForTimeout(9000)
  console.log('  new events after save:', log.length - b2)
  await page.screenshot({ path: '_saved.png' })

  fs.writeFileSync('_apiflow.json', JSON.stringify(log, null, 1))
  console.log('\ncaptured', log.length, 'api events; authToken=', authToken)
  fs.writeFileSync('_token.txt', authToken || '')
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
