// Free-form payment (no template) → _save DRAFT (no money). Run:
//   BANK_SOCKS=socks5://127.0.0.1:10810 node cap_freeform.js
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

  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 40000 })
  await page.waitForSelector('#userName', { timeout: 40000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', USER); await page.fill('#password', PASS)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 40000, waitUntil: 'commit' })
  await page.waitForTimeout(9000)
  console.log('token', token)

  const api = (m, p, b) => page.evaluate(async ([m, p, b, t]) => {
    const r = await fetch('https://dbo.centrinvest.ru' + p, { method: m, credentials: 'include',
      headers: { 'Content-Type': 'application/json', authToken: t, Accept: 'application/json, text/plain, */*' },
      body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, json: await r.json().catch(() => null) }
  }, [m, p, b, token])
  const cmd = (r, suf) => (r.json?.commands || []).find(c => (c.instanceName || '').endsWith(suf))

  console.log('open form...')
  let r = await api('POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030contragent' })
  const form = cmd(r, '/r030contragent')
  const formToken = form?.instanceToken
  const payer = (form?.fields?.payerAccountId?.items || []).find(i => /ГО/.test(i.accountName)) || form?.fields?.payerAccountId?.items?.[0]
  console.log('formToken', formToken, '\npayer', payer?.accountName, payer?.id)
  if (!formToken || !payer) { console.log('cmds', (r.json?.commands || []).map(c => c.instanceName)); await browser.close(); return }

  // Free-form OWN transfer (safe draft): ГО → own Center-Invest account, 3.00 RUB
  const fields = {
    payerAccountId: { value: payer.id },
    receiverName: { value: 'ИП Попенков Сергей Васильевич' },
    receiverINN: { value: '6163011391' },
    receiverKPP: { value: '616301001' },
    receiverAccount: { value: '40817810720001200000' },
    receiverBankBic: { value: '046015762' },
    documentSum: { value: '3.00' },
    vatCalculationRule: { value: 'VatZero' },
    paymentPurpose: { value: 'Тестовый перевод. НДС не облагается' },
    paymentPriority: { value: '5' },
  }
  console.log('\n_save DRAFT with free-form fields...')
  r = await api('PUT', '/api/v1/ui/rur/payment/r030contragent/doAction', { actionId: '_save', fields, instanceToken: formToken })

  // resolve dialogs: reqBaseSelect→update, errorsSave→_save; loop until success/real error
  for (let step = 0; step < 8; step++) {
    const cmds = r.json?.commands || []
    const ok = cmds.find(c => /confirmDialog/.test(c.instanceName || '') && /createConfirm|success/i.test(JSON.stringify(c.fields || {})))
    if (ok) { console.log('\n✅ SAVED:', ok.fields?.title?.value, '—', ok.fields?.message?.value); break }
    const rbs = cmds.find(c => /reqBaseSelect/.test(c.instanceName || '') && c.actions?.update)
    if (rbs) {
      console.log('  reqBaseSelect → update (org:', rbs.fields?.reqBase?.items?.[0]?.value, ')')
      r = await api('PUT', '/api/v1/ui/reqBaseSelect/doAction', { actionId: 'update', fields: { reqBase: { value: rbs.fields?.reqBase?.value ?? '0' } }, instanceToken: rbs.instanceToken })
      continue
    }
    const es = cmds.find(c => /errorsSave/.test(c.instanceName || '') && c.actions?._save)
    if (es) {
      console.log('  errorsSave (warnings) → _save to proceed')
      r = await api('PUT', '/api/v1/ui/messages/errorsSave/doAction', { actionId: '_save', fields: {}, instanceToken: es.instanceToken })
      continue
    }
    console.log('  no known dialog to resolve; commands:', cmds.map(c => (c.instanceName || '') + '/' + c.command).join(', '))
    break
  }
  require('fs').writeFileSync('_freeform_resp.json', JSON.stringify(r.json, null, 1))
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
