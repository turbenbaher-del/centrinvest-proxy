/**
 * Разведка документного API ДБО — чтобы стали возможны подпись и удаление документов.
 *
 * Задача: выяснить, каким запросом банк отдаёт СПИСОК документов с их идентификаторами
 * (сейчас платежи снимаются парсингом текста выписки, где id нет вовсе) и какими
 * действиями документ подписывается/удаляется.
 *
 * Скрипт ТОЛЬКО ЧИТАЕТ: переходит по разделам платежей и записывает трафик /api/v1.
 * Кнопки подписи, отправки и удаления не нажимаются — деньги не двигаются.
 *
 * Запуск (креды берутся из окружения, в коде их нет):
 *   DBO_LOGIN=... DBO_PASSWORD=... node recon-documents.mjs
 * Результат: recon-documents.json (в .gitignore — содержит реальные данные).
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-chromium')

const LOGIN = process.env.DBO_LOGIN
const PASSWORD = process.env.DBO_PASSWORD
if (!LOGIN || !PASSWORD) {
  console.error('Задайте DBO_LOGIN и DBO_PASSWORD в окружении.')
  process.exit(1)
}

const LOGIN_URL = 'https://dbo.centrinvest.ru/sbns-web/ru/html/login.html'

// Разделы документов, куда заходим. Только навигация.
const TARGETS = [
  'Платежи',
  'Черновики',
  'На подпись',
  'В обработке',
  'Отклоненные',
  'Выполненные',
]

const traffic = []

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BANK_SOCKS ? { proxy: { server: process.env.BANK_SOCKS } } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()

page.on('response', async (r) => {
  try {
    const url = r.url()
    if (!url.includes('/api/v1') && !url.includes('/api-ui')) return
    if (r.status() !== 200) return
    if (!(r.headers()['content-type'] || '').includes('json')) return
    const body = await r.text()
    if (body.length < 50) return
    traffic.push({
      url: url.replace('https://dbo.centrinvest.ru', ''),
      method: r.request().method(),
      size: body.length,
      body,
    })
  } catch {}
})

const dismiss = async () => {
  try {
    await page.evaluate(() => {
      const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
      if (m) {
        const bs = Array.from(m.querySelectorAll('button,[role=button]'))
        const b = bs[bs.length - 1]; if (b) b.click(); else m.remove()
      }
    })
  } catch {}
}

console.log('Вход в ДБО…')
await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 60000 })
await page.waitForSelector('#userName', { timeout: 60000, state: 'attached' })
try { await page.click('#btn', { timeout: 4000 }) } catch {}
await page.fill('#userName', LOGIN.toLowerCase())
await page.fill('#password', PASSWORD)
await page.click('#submitButton')
await page.waitForURL(u => !u.toString().includes('login.html'), { timeout: 60000, waitUntil: 'commit' })
await page.waitForTimeout(8000)
await dismiss()
console.log('Вошли. URL:', page.url())

for (const label of TARGETS) {
  try {
    await dismiss()
    await page.click(`text=${label}`, { timeout: 3000 })
    await page.waitForTimeout(2500)
    console.log('  ✓ открыт раздел:', label)
  } catch {
    console.log('  – не найден:', label)
  }
}

await page.waitForTimeout(2000)

// Ищем в ответах то, что похоже на идентификаторы документов и доступные действия
const idKeys = new Set()
const actionNames = new Set()
const instanceNames = new Set()

const walk = (node) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  for (const [k, v] of Object.entries(node)) {
    if (/^(id|documentId|docId|uid|guid|instanceToken)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      idKeys.add(k)
    }
    if (k === 'actions' && v && typeof v === 'object' && !Array.isArray(v)) {
      Object.keys(v).forEach(a => actionNames.add(a))
    }
    if (k === 'instanceName' && typeof v === 'string') instanceNames.add(v)
    walk(v)
  }
}

for (const t of traffic) {
  try { walk(JSON.parse(t.body)) } catch {}
}

const endpoints = [...new Set(traffic.map(t => `${t.method} ${t.url.split('?')[0]}`))].sort()

const report = {
  capturedAt: new Date().toISOString(),
  responses: traffic.length,
  endpoints,
  idKeys: [...idKeys],
  // Действия документов: здесь ищем что-то вроде _sign, _delete, _remove
  actions: [...actionNames].sort(),
  instances: [...instanceNames].sort().slice(0, 120),
}

writeFileSync('recon-documents.json', JSON.stringify({ report, traffic }, null, 2))

console.log('\n─── Что нашлось ───')
console.log('ответов /api/v1:', traffic.length)
console.log('\nэндпоинты:'); endpoints.forEach(e => console.log('  ' + e))
console.log('\nключи-идентификаторы:', report.idKeys.join(', ') || '(нет)')
console.log('\nдействия документов:', report.actions.join(', ') || '(нет)')
console.log('\nПодробности в recon-documents.json')

await browser.close()
