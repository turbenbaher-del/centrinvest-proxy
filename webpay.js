// Reliable web payment sender via the /api-ui/ JSON REST flow (reverse-engineered 2026-07-03).
// Flow: Playwright login (RU-SOCKS) → capture session authToken → drive /api/v1 from page context:
//   menu/click(r030contragent) → doAction(_save | _saveAndSign, fields) → resolve dialogs
//   (reqBaseSelect→update, errorsSave→proceed) → confirmDialog.
// _save = draft (no money). _saveAndSign = real send (money moves; sign step may need cert/SMS).
const { chromium } = require('playwright-chromium')

const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'
const FORM_PATH = '/api/v1/ui/rur/payment/r030contragent/doAction'

async function openSession(username, password) {
  const socks = process.env.BANK_SOCKS
  const browser = await chromium.launch({
    headless: true, ...(socks ? { proxy: { server: socks } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()
  let token = null
  page.on('request', r => { const t = r.headers()['authtoken']; if (t) token = t })

  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 60000 })
  await page.waitForSelector('#userName', { timeout: 60000, state: 'attached' })
  try { await page.click('#btn', { timeout: 4000 }) } catch {}
  await page.fill('#userName', username.toLowerCase())
  await page.fill('#password', password)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 60000, waitUntil: 'commit' })
  // wait for the SPA's postLogin/init to rotate the session token into request headers
  for (let i = 0; i < 25 && !token; i++) await page.waitForTimeout(2000)
  if (!token) { await browser.close(); throw new Error('web session token not captured (slow RU link?)') }

  const api = (method, path, body) => page.evaluate(async ([m, p, b, t]) => {
    const res = await fetch('https://dbo.centrinvest.ru' + p, {
      method: m, credentials: 'include',
      headers: { 'Content-Type': 'application/json', authToken: t, Accept: 'application/json, text/plain, */*' },
      body: b ? JSON.stringify(b) : undefined,
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body, token])

  return { browser, page, api }
}

const findCmd = (r, suffix) => (r.json?.commands || []).find(c => (c.instanceName || '').endsWith(suffix))
const anyCmd = (r, rx) => (r.json?.commands || []).find(c => rx.test(c.instanceName || ''))

/** Submit a payment to a contractor. sign=false → draft (safe); sign=true → real send.
 *  payment: { payerAccount, receiverName, receiverINN, receiverKPP?, receiverAccount,
 *             receiverBic, amount, purpose, vat?='VatZero', priority?='5' } */
async function submitPayment(username, password, payment, { sign = false } = {}) {
  const s = await openSession(username, password)
  try {
    // 1) open the contractor payment form
    let r = await s.api('POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030contragent' })
    const form = findCmd(r, '/r030contragent')
    if (!form?.instanceToken) throw new Error('form open failed: ' + JSON.stringify((r.json?.commands || []).map(c => c.instanceName)))
    const formToken = form.instanceToken
    const items = form.fields?.payerAccountId?.items || []
    const norm = x => String(x || '').replace(/\D/g, '')
    const payer = items.find(i => norm(i.accountNumber) === norm(payment.payerAccount))
      || items.find(i => JSON.stringify(i).includes(norm(payment.payerAccount)))
    if (!payer) throw new Error('payer account not found: ' + payment.payerAccount + ' (have: ' + items.map(i => i.accountNumber || i.accountName).join(', ') + ')')

    // 2) fill fields + save/sign
    const fields = {
      payerAccountId: { value: payer.id },
      receiverName: { value: payment.receiverName },
      receiverINN: { value: payment.receiverINN },
      receiverKPP: { value: payment.receiverKPP || '' },
      receiverAccount: { value: payment.receiverAccount },
      receiverBankBic: { value: payment.receiverBic },
      documentSum: { value: String(payment.amount) },
      vatCalculationRule: { value: payment.vat || 'VatZero' },
      paymentPurpose: { value: payment.purpose },
      paymentPriority: { value: payment.priority || '5' },
    }
    const action = sign ? '_saveAndSign' : '_save'
    r = await s.api('PUT', FORM_PATH, { actionId: action, fields, instanceToken: formToken })

    // 3) resolve interactive dialogs (ФНС org confirm, save warnings) until success/error
    const warnings = []
    for (let step = 0; step < 10; step++) {
      const cmds = r.json?.commands || []
      const ok = cmds.find(c => /confirmDialog/.test(c.instanceName || '') && /createConfirm|success|sign/i.test(JSON.stringify(c.fields || {})))
      if (ok) return { ok: true, sign, message: ok.fields?.message?.value || ok.fields?.title?.value, warnings }
      // hard errors (non-WARN) on any field or an errors panel
      const hard = cmds.flatMap(c => Object.entries(c.fields || {})).flatMap(([id, f]) => (f.errors || []).map(e => id + ': ' + (e.message || e)))
      const rbs = cmds.find(c => /reqBaseSelect/.test(c.instanceName || '') && c.actions?.update)
      if (rbs) { // confirm the ФНС-resolved organisation (default radio)
        r = await s.api('PUT', '/api/v1/ui/reqBaseSelect/doAction',
          { actionId: 'update', fields: { reqBase: { value: rbs.fields?.reqBase?.value ?? '0' } }, instanceToken: rbs.instanceToken })
        continue
      }
      const es = cmds.find(c => /errorsSave/.test(c.instanceName || '') && (c.actions?._save || c.actions?._saveAndSign))
      if (es) { // WARN-level dialog → proceed with our intended action
        (es.fields?.tree?.items || []).forEach(w => warnings.push(w.message))
        const proceed = sign && es.actions?._saveAndSign ? '_saveAndSign' : '_save'
        r = await s.api('PUT', '/api/v1/ui/messages/errorsSave/doAction', { actionId: proceed, fields: {}, instanceToken: es.instanceToken })
        continue
      }
      if (hard.length) return { ok: false, error: 'validation', details: hard, warnings }
      // signing step (real send) may hand off to certificate/SMS — surface it
      const sd = anyCmd(r, /sign|certificate|confirm|otp|sms/i)
      return { ok: false, error: 'unresolved', commands: cmds.map(c => (c.instanceName || '') + '/' + c.command), needsSign: !!sd, warnings }
    }
    return { ok: false, error: 'too many dialog steps', warnings }
  } finally {
    await s.browser.close()
  }
}

/**
 * Счета плательщика из формы платежа — источник НАЗВАНИЙ счетов («ГО»,
 * «корп.карта», «р/с Ставрополь») и, если банк их отдаёт, остатков.
 *
 * Разбор страницы даёт только номера: названия и суммы по каждому счёту
 * в новом интерфейсе из текста не вытащить. Здесь банк отдаёт их структурно.
 *
 * Только чтение: форма открывается, но ничего не сохраняется и не подписывается.
 */
async function getPayerAccounts(username, password) {
  const s = await openSession(username, password)
  try {
    const r = await s.api('POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030contragent' })
    const form = findCmd(r, '/r030contragent')
    const items = form?.fields?.payerAccountId?.items || []

    if (items.length === 0) {
      console.warn('[payerAccounts] банк не вернул список счетов формы')
      return []
    }
    // Имена полей у банка могут поменяться — видно в логе, что пришло
    console.log('[payerAccounts] поля счёта:', Object.keys(items[0]).join(', '))

    const num = (x) => String(x ?? '').replace(/\D/g, '')
    const money = (x) => {
      const n = parseFloat(String(x ?? '').replace(/\s/g, '').replace(',', '.'))
      return Number.isFinite(n) ? n : null
    }

    return items.map((i) => ({
      number: num(i.accountNumber || i.number || i.account),
      name: String(i.accountName || i.name || i.alias || '').trim(),
      balance: money(i.balance ?? i.rest ?? i.sum ?? i.availableBalance),
      currency: String(i.currency || i.currencyCode || '').trim().toUpperCase() || 'RUR',
    })).filter(a => a.number.length === 20)
  } finally {
    await s.browser.close()
  }
}

module.exports = { submitPayment, openSession, getPayerAccounts }
