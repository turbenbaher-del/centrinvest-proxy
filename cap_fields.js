// Capture the r030contragent form field schema + the onChange doAction format for
// FREE-FORM payments (no template). Run:
//   BANK_SOCKS=socks5://127.0.0.1:10810 node cap_fields.js
const { chromium } = require('playwright-chromium')
const fs = require('fs')
const USER = (process.env.DBO_LOGIN || '24cmvKy8').toLowerCase()
const PASS = process.env.DBO_PASSWORD || 'dbocib14Z'
const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

;(async () => {
  const socks = process.env.BANK_SOCKS
  const browser = await chromium.launch({ headless: true, ...(socks ? { proxy: { server: socks } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage', '--disable-gpu'] })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()
  const log = []
  page.on('response', async resp => {
    const u = resp.url(); if (!/\/api\/v1\//.test(u)) return
    let body = null; try { const ct = resp.headers()['content-type'] || ''; if (ct.includes('json')) body = await resp.json() } catch {}
    log.push({ dir: 'RESP', url: u.replace('https://dbo.centrinvest.ru', ''), body })
  })
  page.on('request', req => {
    const u = req.url(); if (!/doAction/.test(u)) return
    let body = null; try { body = req.postData() } catch {}
    log.push({ dir: 'REQ', url: u.replace('https://dbo.centrinvest.ru', ''), body })
  })

  console.log('login...')
  await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 40000 })
  await page.waitForSelector('#userName', { timeout: 40000, state: 'attached' })
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', USER); await page.fill('#password', PASS)
  await page.click('#submitButton')
  await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 40000, waitUntil: 'commit' })
  await page.waitForTimeout(9000)

  console.log('open form...')
  try { await page.locator('button:has-text("Создать"), :text("Создать")').first().click({ force: true, timeout: 8000 }) } catch {}
  await page.waitForTimeout(3500)
  try { await page.getByText('Платеж контрагенту', { exact: true }).first().click({ force: true, timeout: 8000 }) } catch (e) { console.log('form err', e.message) }
  await page.waitForTimeout(9000)

  // dump the r030contragent form field schema (field ids/types/labels)
  const forms = log.filter(e => e.dir === 'RESP' && e.body && (e.body.commands || []).some(c => /r030contragent/.test(c.instanceName || '')))
  const cmd = forms.flatMap(e => e.body.commands).find(c => /r030contragent/.test(c.instanceName || '') && c.fields)
  if (cmd) {
    const fields = Object.entries(cmd.fields).map(([id, f]) => `${id} : ${f.type}${f.label ? ' ("' + f.label + '")' : ''}`)
    console.log('\n=== r030contragent FIELDS ===\n' + fields.join('\n'))
    const actions = Object.keys(cmd.actions || {})
    console.log('\n=== ACTIONS ===\n' + actions.join(', '))
  } else {
    console.log('\n(no r030contragent formInit captured; commands seen:',
      [...new Set(log.filter(e => e.body).flatMap(e => (e.body.commands || []).map(c => (c.instanceName || '') + '/' + c.command)))].join(', '), ')')
  }

  // dump the visible input elements (name/id/placeholder) to know how to fill via UI
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea,select')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ tag: el.tagName, type: el.type, name: el.name, id: el.id, ph: el.placeholder, aria: el.getAttribute('aria-label') })))
  fs.writeFileSync('_inputs.json', JSON.stringify(inputs, null, 1))
  console.log('\n=== VISIBLE INPUTS (' + inputs.length + ') ===')
  inputs.forEach(i => console.log(`  ${i.tag}/${i.type} name=${i.name || '-'} id=${i.id || '-'} ph="${i.ph || ''}" aria="${i.aria || ''}"`))

  fs.writeFileSync('_fields_flow.json', JSON.stringify(log, null, 1))
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
