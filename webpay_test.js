// Validate the API-driven web payment flow (no UI clicks): login → menu/click →
// createByTemplate → _save (DRAFT, no money). Run:
//   BANK_SOCKS=socks5://127.0.0.1:10810 node webpay_test.js
const { chromium } = require('playwright-chromium')
const USER = (process.env.DBO_LOGIN || '24cmvKy8').toLowerCase()
const PASS = process.env.DBO_PASSWORD || 'dbocib14Z'
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

;(async () => {
  const socks = process.env.BANK_SOCKS
  const browser = await chromium.launch({ headless: true, ...(socks ? { proxy: { server: socks } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage', '--disable-gpu'] })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()
  let token = null
  page.on('request', r => { const t = r.headers()['authtoken']; if (t) token = t })

  console.log('login...')
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 40000 })
  await page.waitForSelector('#userName', { timeout: 40000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', USER); await page.fill('#password', PASS)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 40000, waitUntil: 'commit' })
  await page.waitForTimeout(9000) // let SPA postLogin/init run so header token rotates
  console.log('token:', token)

  // API call from page context (cookies incl. DDoS-Guard/route sent automatically; add authToken header)
  const api = (method, path, body) => page.evaluate(async ([m, p, b, tok]) => {
    const res = await fetch('https://dbo.centrinvest.ru' + p, {
      method: m, headers: { 'Content-Type': 'application/json', 'authToken': tok, 'Accept': 'application/json, text/plain, */*' },
      body: b ? JSON.stringify(b) : undefined, credentials: 'include',
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body, token])
  const cmdBy = (r, suffix) => (r.json?.commands || []).find(c => (c.instanceName || '').endsWith(suffix))

  console.log('\n1) open form (menu/click)')
  let r = await api('POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030contragent' })
  console.log('  status', r.status)
  const tplCmd = cmdBy(r, '/templates')
  const tplToken = tplCmd?.instanceToken
  const items = tplCmd?.fields?.templates?.items || []
  const tpl = items.find(i => /Себе на карту/i.test(i.templateName)) || items[0]
  console.log('  templatesToken:', tplToken, '\n  template:', tpl?.templateName, tpl?.id, '→', tpl?.receiverAccount, tpl?.documentSum + '₽')
  if (!tplToken || !tpl) { console.log('  cmds:', (r.json?.commands || []).map(c => c.instanceName + '/' + c.command)); await browser.close(); return }

  console.log('\n2) createByTemplate')
  r = await api('PUT', '/api/v1/ui/rur/payment/templates/doAction',
    { actionId: 'createByTemplate_templates', fields: { templates: { value: tpl.id } }, instanceToken: tplToken })
  console.log('  status', r.status)
  const formCmd = cmdBy(r, '/r030contragent')
  const formToken = formCmd?.instanceToken
  console.log('  r030 formToken:', formToken)
  if (!formToken) { console.log('  cmds:', (r.json?.commands || []).map(c => c.instanceName + '/' + c.command)); await browser.close(); return }

  console.log('\n3) _save (DRAFT — no money)')
  r = await api('PUT', '/api/v1/ui/rur/payment/r030contragent/doAction',
    { actionId: '_save', fields: {}, instanceToken: formToken })
  console.log('  status', r.status)
  const dlg = cmdBy(r, 'confirmDialog') || (r.json?.commands || []).find(c => c.fields?.message)
  console.log('  RESULT:', dlg?.fields?.title?.value, '—', dlg?.fields?.message?.value)
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
