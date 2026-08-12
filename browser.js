const { chromium } = require('playwright-chromium')

let browser = null
let page = null
let sessionExpiry = 0
let sessionAuthToken = null      // токен API банка из текущей сессии
let cachedAccounts = []          // last successful accounts fetch
let cachedApiResponses = []      // all JSON API responses from last full navigation
// Письмо банка «обязательно к прочтению»: банк показывает его поверх
// интерфейса и ждёт подтверждения ознакомления. Подтверждать за человека
// нельзя, поэтому просто запоминаем и отдаём приложению.
let pendingMustRead = null

const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const LOGIN_URL = `${BASE}/ru/html/login.html`
const MAIN_URL = `${BASE}/main.zul`
// Новый интерфейс: заходим сюда, чтобы после логина вернуться именно в него
const API_UI_URL = 'https://dbo.centrinvest.ru/api-ui/'

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    // Банк гео-блокирует иностранные IP → ходим через российский выход (SOCKS).
    // BANK_SOCKS, напр. socks5://127.0.0.1:10810 (локальный xray на RU-сервер RedShield).
    const socks = process.env.BANK_SOCKS
    browser = await chromium.launch({
      headless: true,
      ...(socks ? { proxy: { server: socks } } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    })
    if (socks) console.log('[browser] via SOCKS', socks)
  }
  return browser
}

// Вход идёт ОДИН на всех: приложение открывает экран и сразу шлёт пачку
// запросов (счета, документы, письма, баннеры). Раньше каждый из них, застав
// сессию просроченной, начинал собственный вход — банк видел серию попыток
// и включал временное ограничение, а запросы висели по 30–40 секунд.
let loginInFlight = null

async function ensureLoggedIn(username, password) {
  const now = Date.now()
  if (page && now < sessionExpiry) {
    try {
      const url = page.url()
      if (!url.includes('login.html')) return page
    } catch {}
  }
  if (loginInFlight) return loginInFlight
  loginInFlight = doLogin(username, password).finally(() => { loginInFlight = null })
  return loginInFlight
}

async function doLogin(username, password) {
  console.log('[browser] Logging in...')
  const b = await getBrowser()
  // Прошлую сессию закрываем: без этого контексты Chromium копились с каждым
  // входом, память в контейнере кончалась, и браузер падал с «Target page,
  // context or browser has been closed» — после чего висело всё подряд.
  try { if (page) await page.context().close() } catch { /* уже закрыт */ }
  page = null
  const ctx = await b.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  page = await ctx.newPage()

  // Токен сессии банка ловим прямо при входе: с ним можно обращаться к API
  // банка из уже открытой страницы, не логинясь второй раз. Отдельный вход
  // ради формы платежа удваивал нагрузку на банк.
  sessionAuthToken = null
  accountIdCache = null            // новая сессия — счета спросим заново
  page.on('request', (r) => {
    const t = r.headers()['authtoken']
    if (t) sessionAuthToken = t
  })

  // Заходим СРАЗУ на новый интерфейс. Он редиректит на страницу логина, но с
  // «возвратом» в api-ui — после входа банк вернёт нас в новый интерфейс.
  // Если же логиниться через классическую страницу напрямую, банк возвращает
  // в старый main.zul, откуда переход в api-ui сбрасывает сессию.
  await page.goto(API_UI_URL, { waitUntil: 'commit', timeout: 30000 })
  try {
    await page.waitForSelector('#userName', { timeout: 30000, state: 'attached' })
  } catch (e) {
    // Формы входа нет — надо знать почему: ограничение по адресу, заглушка
    // банка или изменившаяся страница. Без этого причина неотличима.
    const seen = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    })).catch(() => ({ url: '?', title: '?', text: '' }))
    console.error('[browser] Форма входа не появилась.')
    console.error('[browser] URL:', seen.url, '| Заголовок:', seen.title)
    console.error('[browser] Страница:', seen.text || '(пусто)')
    // Плановые работы банка — не поломка приложения. Человеку важно понимать
    // разницу: тут нечего чинить и незачем перебирать пароль, надо просто ждать.
    if (/техническ\w*\s+работ/i.test(seen.text)) {
      throw new Error('В банке идут технические работы. Интернет-банк временно недоступен — попробуйте позже')
    }
    throw new Error(
      seen.text
        ? 'Банк не показал форму входа. Ответ банка: ' + seen.text.slice(0, 200)
        : 'Банк не показал форму входа и вернул пустую страницу — вероятно, доступ ограничен'
    )
  }
  // '#btn' раскрывает форму «вход по логину/паролю» (поля скрыты до клика)
  try { await page.click('#btn', { timeout: 3000 }) } catch {}
  await page.fill('#userName', username.toLowerCase(), { timeout: 15000 })
  await page.fill('#password', password, { timeout: 15000 })
  await page.click('#submitButton')

  try {
    await page.waitForURL(url => !url.toString().includes('login.html'), { timeout: 30000, waitUntil: 'commit' })
  } catch (e) {
    // Банк не пустил в отведённое время — обычно это временное ограничение
    // частоты входов. Отдаём человекопонятную причину вместо сырого таймаута.
    await browserSafeClose()
    throw new Error('Банк не отвечает на вход — вероятно, временное ограничение. Повторите через 1–2 минуты.')
  }

  // Банк помнит выбранный интерфейс. Если он открыл СТАРЫЙ (sbns-web/main.zul),
  // весь структурный код работать не будет — переходим по ссылке «В новый
  // интерфейс». Обычный клик по ней не проходит (ZK-виджет), поэтому force,
  // а запасной вариант — клик через DOM.
  if (page.url().includes('main.zul')) {
    await page.waitForTimeout(2500)
    // Диагностика: как на самом деле выглядит ссылка перехода в старом интерфейсе
    try {
      const d = await page.evaluate(() => {
        const txt = (document.body.innerText || '').replace(/\s+/g, ' ')
        const els = [...document.querySelectorAll('a,button,span,div,td')].filter(e =>
          /нов\w* интерфейс/i.test(e.textContent || ''))
        return {
          естьТекст: /нов\w* интерфейс/i.test(txt),
          найдено: els.length,
          образцы: els.slice(0, 3).map(e => ({
            tag: e.tagName, id: e.id || '', cls: String(e.className).slice(0, 40),
            href: e.getAttribute('href') || '', onclick: !!e.onclick,
            текст: (e.textContent || '').trim().slice(0, 40),
          })),
        }
      })
      console.log('[browser] ссылка «новый интерфейс»:', JSON.stringify(d))
    } catch {}
    // Сначала пробуем ссылку, если она есть на странице
    for (let attempt = 0; attempt < 2 && page.url().includes('main.zul'); attempt++) {
      try {
        await page.locator('text=В новый интерфейс').first().click({ timeout: 4000, force: true })
      } catch {
        await page.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find(e => {
            const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
            return own === 'В новый интерфейс'
          })
          el?.click()
        }).catch(() => {})
      }
      await page.waitForTimeout(4000)
    }

    // Прямой переход на новый интерфейс. Раньше он сбрасывал на форму входа,
    // но, похоже, потому что делался слишком рано — до того как сессия
    // закрепилась. Даём старому интерфейсу догрузиться и только потом идём.
    if (page.url().includes('main.zul')) {
      try {
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {})
        await page.waitForTimeout(6000)
        console.log('[browser] старый интерфейс загружен, перехожу в новый')
        await page.goto(API_UI_URL, { waitUntil: 'commit', timeout: 30000 })
        await page.waitForTimeout(5000)
        console.log('[browser] URL после перехода:', page.url())
      } catch (e) {
        console.log('[browser] переход в новый интерфейс не удался:', e.message)
      }
    }
    console.log('[browser] После перехода в новый интерфейс, URL:', page.url())
  }

  await waitForAppReady(page)

  console.log('[browser] Logged in, URL:', page.url())
  sessionExpiry = Date.now() + 20 * 60 * 1000
  return page
}

// Тихо закрыть зависшую сессию, чтобы следующий вход начинался с чистого листа
async function browserSafeClose() {
  try { if (page) await page.context().close() } catch {}
  page = null
  sessionExpiry = 0
  sessionAuthToken = null
  accountIdCache = null
}

/**
 * Ждём, пока SPA банка действительно отрисует содержимое.
 *
 * Раньше здесь стояла пауза в 2,5 секунды. На машине с российским каналом этого
 * хватало, а с хостинга — нет: чтение начиналось по пустой странице, и наружу
 * уходил ответ «счетов 0» вместо ошибки. Теперь ждём появления содержимого,
 * а по истечении срока честно пишем в лог, что страница осталась пустой.
 */
async function waitForAppReady(p, timeoutMs = 60000) {
  const started = Date.now()
  const MARKERS = /Счета и платежи|СОБСТВЕННЫЕ СРЕДСТВА|Контрагенты|Мои документы/i

  while (Date.now() - started < timeoutMs) {
    // Окно «обязательно к прочтению» перекрывает интерфейс. Раньше здесь
    // вслепую нажималась последняя кнопка окна — то есть сервис мог сам
    // подтверждать ознакомление с письмом банка, которого человек не видел.
    // Так делать нельзя: подтверждение прочтения — действие клиента.
    // Теперь письмо запоминается и отдаётся приложению (GET /api/mustread),
    // а окно временно убирается с экрана, чтобы читать данные было можно.
    try {
      const found = await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (!m) return null
        const text = (m.innerText || '').replace(/\s+/g, ' ').trim()
        m.setAttribute('data-pva-hidden', '1')
        m.style.display = 'none'
        return text.slice(0, 4000)
      })
      if (found) {
        pendingMustRead = { text: found, seenAt: Date.now() }
        console.log('[browser] банк показал письмо, обязательное к прочтению — жду подтверждения человека')
      }
    } catch {}

    const text = await p.evaluate(() => document.body.innerText || '').catch(() => '')
    if (text.length > 300 && MARKERS.test(text)) {
      console.log(`[browser] Интерфейс отрисован за ${Math.round((Date.now() - started) / 1000)} c`)
      return true
    }
    await p.waitForTimeout(1500)
  }

  // Что именно показал банк вместо интерфейса. Без этого причина неизвестна:
  // «страница не отрисовалась» одинаково выглядит и при блокировке, и при
  // сообщении банка, и при занятой сессии.
  const seen = await p.evaluate(() => ({
    len: (document.body.innerText || '').length,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    url: location.href,
  })).catch(() => ({ len: 0, text: '', url: '' }))
  console.warn(`[browser] Интерфейс не отрисовался за ${timeoutMs / 1000} c (текста: ${seen.len})`)
  console.warn(`[browser] URL: ${seen.url}`)
  console.warn(`[browser] Банк показывает: ${seen.text || '(пусто)'}`)
  return false
}

async function getAccountsData(username, password) {
  const p = await ensureLoggedIn(username, password)
  // Если интерфейс банка не отрисовался, читать нечего: лучше вернуть ошибку,
  // чем пустой список — «счетов 0» выглядит как достоверный ответ.
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился — банк не отдал содержимое страницы')
  const currentUrl = p.url()
  console.log('[browser] Getting accounts from:', currentUrl)

  if (currentUrl.includes('/api-ui')) {
    return getAccountsViaResponseListener(p)
  } else {
    return getAccountsClassicZK(p)
  }
}

// New interface: listen to ALL REST API responses during full navigation
// This function is authoritative — it also populates cachedApiResponses for payments
async function getAccountsViaResponseListener(p) {
  console.log('[browser] Full navigation with response capture, URL:', p.url())
  const apiData = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!url.includes('centrinvest.ru')) return
    if (response.status() !== 200) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await response.text()
      if (body.length > 10) {
        console.log('[api]', response.request().method(), url.replace('https://dbo.centrinvest.ru', ''), body.length + 'b')
        if (body.length < 5000) console.log('[api] body:', body.substring(0, 600))
        apiData.push({ url, body })
      }
    } catch {}
  }

  p.on('response', onResponse)

  // Окно обязательного письма только прячем. Нажимать в нём кнопку нельзя:
  // это подтверждение ознакомления от имени клиента, а такое решение
  // принимает человек — сервис лишь показывает письмо в приложении.
  const dismissed = await p.evaluate(() => {
    const modal = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
    if (!modal) return false
    modal.setAttribute('data-pva-hidden', '1')
    modal.style.display = 'none'
    return 'hidden'
  })
  if (dismissed) { console.log('[browser] Dismissed modal:', dismissed); await p.waitForTimeout(1000) }
  else { await p.keyboard.press('Escape'); await p.waitForTimeout(500) }

  // Navigate to statement section
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(3000) } catch {}
  try { await p.click('text=Выписка', { timeout: 3000 }); await p.waitForTimeout(2000) } catch {}

  // Try clicking the account number to open account switcher and reveal all accounts
  const switcherOpened = await p.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'))
    for (const el of allEls) {
      const t = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
        ? (el.textContent || '').trim() : ''
      if (/^\d{20}$/.test(t) || /^\d{5}\.\d{3}\.\d\.\d{11}$/.test(t)) {
        el.click(); return t
      }
    }
    return null
  })
  if (switcherOpened) { console.log('[browser] Clicked account number:', switcherOpened); await p.waitForTimeout(2000) }

  p.off('response', onResponse)
  console.log('[browser] Captured', apiData.length, 'API responses total')

  // Save for payments endpoint to reuse
  cachedApiResponses = apiData

  // Parse from DOM text — balance is in page header, account num in transaction rows
  const pageBodyText = await p.evaluate(() => document.body.innerText)

  // Balance: look for "СОБСТВЕННЫЕ СРЕДСТВА ... {amount} ₽" in page header
  const ownFundsM = pageBodyText.match(/СОБСТВЕННЫЕ СРЕДСТВА[\s\S]{0,30}?([\d\s]+[.,]\d{2})\s*₽/)
  const currentBalance = ownFundsM
    ? parseFloat(ownFundsM[1].replace(/[\s ]/g, '').replace(',', '.')) : 0
  console.log('[browser] Balance from header:', currentBalance)

  // Account numbers: only valid Russian bank account prefixes
  const accountPrefix = /^(407|408|423|301|455|454|426|427|428|429|430|431)/
  const allNums = [...new Set((pageBodyText.match(/\b\d{20}\b/g) || []).filter(n => accountPrefix.test(n)))]
  console.log('[browser] Account numbers in DOM:', allNums)

  // Настоящие остатки и валюты берём из ответов банка: в шапке страницы есть
  // сумма только по текущему счёту, и раньше она приписывалась первому счёту,
  // а всем остальным ставился ноль — на экране четыре счёта из пяти были «0,00».
  const fromApi = new Map()
  const numberKeys  = /^(accountNumber|account|number|acc|nomer)$/i
  const balanceKeys = /^(balance|rest|remain|ostatok|currentBalance|availableBalance|saldo|sum)$/i
  const currencyKeys = /^(currency|currencyCode|curr|iso)$/i

  const scanForAccounts = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(scanForAccounts); return }

    let num = '', bal = null, cur = ''
    for (const [k, v] of Object.entries(node)) {
      const val = (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
      if (numberKeys.test(k)) {
        const digits = String(val ?? '').replace(/\D/g, '')
        if (/^\d{20}$/.test(digits) && accountPrefix.test(digits)) num = digits
      } else if (balanceKeys.test(k)) {
        const n = parseFloat(String(val ?? '').replace(/\s/g, '').replace(',', '.'))
        if (Number.isFinite(n)) bal = n
      } else if (currencyKeys.test(k)) {
        const s = String(val ?? '').trim().toUpperCase()
        if (/^[A-Z]{3}$/.test(s)) cur = s
      }
    }
    if (num && bal !== null && !fromApi.has(num)) {
      fromApi.set(num, { balance: bal, currency: cur })
    }

    Object.values(node).forEach(scanForAccounts)
  }

  for (const { body } of apiData) {
    try { scanForAccounts(JSON.parse(body)) } catch {}
  }
  console.log('[browser] Остатки из ответов банка:', fromApi.size)

  const accounts = []
  const seen = new Set()
  const addAccount = (num) => {
    if (seen.has(num)) return
    seen.add(num)
    const api = fromApi.get(num)
    accounts.push({
      number: num,
      currency: api?.currency || 'RUR',
      // Сумма «СОБСТВЕННЫЕ СРЕДСТВА» в шапке — это ИТОГ по всем счетам,
      // а не остаток одного из них. Раньше она приписывалась первому счёту
      // и потом складывалась с остальными: итог выходил вдвое больше.
      balance: api ? api.balance : 0,
      status: 'Открыт',
      // Видно, откуда взялась сумма и есть ли она вообще
      balanceSource: api ? 'api' : 'unknown',
    })
  }

  // Источник истины — список счетов, который банк отдал явно. Текст страницы
  // для этого не годится: в назначениях платежей встречаются чужие счета
  // («перевод на ЛС 40817…»), и они попадали в список как свои.
  if (fromApi.size > 0) {
    for (const num of fromApi.keys()) addAccount(num)
  } else {
    // Явного списка нет — тогда только номера со страницы, лучше чем ничего
    allNums.forEach(addAccount)
    for (const { body } of apiData) {
      try {
        const nums = (body.match(/\b\d{20}\b/g) || []).filter(n => accountPrefix.test(n))
        nums.forEach(addAccount)
      } catch {}
    }
  }

  // Аресты по счетам. Банк пишет это на странице красным: «АРЕСТОВАНО —
  // по 3 счетам в размере всех средств». Деньги на таких счетах недоступны,
  // и не показать это в приложении опаснее, чем ошибиться в копейках.
  const seizureMatch = pageBodyText.match(/АРЕСТОВАНО\s*\n?\s*([^\n]{3,200})/i)
  const seizureNotice = seizureMatch ? seizureMatch[1].trim() : ''
  const seizureCount = seizureNotice.match(/по\s+(\d+)\s+счет/i)
  if (seizureNotice) {
    console.log('[browser] Аресты:', seizureNotice)
    accounts.forEach(a => {
      a.seizureNotice = seizureNotice
      a.seizureAccounts = seizureCount ? parseInt(seizureCount[1], 10) : null
    })
  }

  console.log('[browser] Parsed accounts:', accounts.map(a => `${a.number}=${a.balance}(${a.balanceSource})`))

  console.log('[browser] Found accounts:', accounts.length, accounts.map(a => a.number))
  if (accounts.length > 0) cachedAccounts = accounts
  return accounts
}

// Classic ZK interface: scrape DOM
async function getAccountsClassicZK(p) {
  console.log('[browser] Classic ZK interface')
  try {
    await p.click('text=СЧЕТА', { timeout: 5000 })
  } catch (e) {
    console.log('[browser] СЧЕТА click failed:', e.message)
  }

  let accounts = []
  for (let attempt = 0; attempt < 8; attempt++) {
    await p.waitForTimeout(2500)
    accounts = await p.evaluate(() => {
      const results = []
      const seen = new Set()
      document.querySelectorAll('td, span, div').forEach(el => {
        const text = el.textContent.trim()
        const stripped = text.replace(/\./g, '')
        if (stripped.match(/^\d{20}$/) && !seen.has(stripped)) {
          seen.add(stripped)
          const row = el.closest('tr') || el.parentElement
          if (row) {
            const cells = Array.from(row.querySelectorAll('td, span')).map(c => c.textContent.trim())
            results.push({ number: stripped, raw: text, cells: cells.filter(c => c.length > 0).slice(0, 10) })
          }
        }
      })
      return results
    })
    if (accounts.length > 0) break
    console.log(`[browser] Attempt ${attempt + 1}: no accounts yet`)
  }

  console.log('[browser] Found accounts:', accounts.length, accounts.map(a => a.number))
  return accounts.map(a => {
    const balCell = a.cells.find(c => c.match(/^\d[\d\s]*[,\.]\d{2}$/))
    const balance = balCell ? parseFloat(balCell.replace(/\s/g, '').replace(',', '.')) : 0
    const currency = a.cells.find(c => c.match(/^(RUR|USD|EUR|CNY|GBP)$/)) || 'RUR'
    const status = a.cells.find(c => c.match(/^(Открыт|Закрыт|Заблокирован)$/)) || ''
    return { number: a.number, currency, balance, status }
  })
}

// Parse transactions from the new API-UI interface page text.
// The new interface renders transactions as plain text in this pattern:
//   dd.mm.yyyy
//   № docnum,
//   [optional: счет списания / status lines]
//   ГО (status)
//   COUNTERPARTY NAME
//   description text
//   +/-amount.xx ₽
function parsePaymentLines(text) {
  const payments = []
  const seen = new Set()
  // Start parsing from after "РАСШИРЕННЫЙ ПОИСК" marker to skip nav/header dates
  const markerIdx = text.indexOf('РАСШИРЕННЫЙ ПОИСК')
  const txText = markerIdx >= 0 ? text.substring(markerIdx + 17) : text
  const lines = txText.split('\n').map(l => l.trim()).filter(Boolean)
  const dateRe = /^\d{2}\.\d{2}\.\d{4}$/
  const amtRe = /^([+\-]?\d[\d\s]*[,.]\d{2})\s*₽?$/

  let i = 0
  while (i < lines.length) {
    if (!dateRe.test(lines[i])) { i++; continue }
    const date = lines[i]; i++

    let docNum = '', counterparty = '', desc = '', amount = 0, amountStr = '', status = ''
    const chunk = []
    while (i < lines.length && !dateRe.test(lines[i]) && !amtRe.test(lines[i])) {
      chunk.push(lines[i]); i++
    }
    if (i < lines.length && amtRe.test(lines[i])) {
      const m = lines[i].match(amtRe)
      amountStr = (m[1] || '0').trim()
      amount = parseFloat(amountStr.replace(/\s/g, '').replace(',', '.')) || 0
      i++
    }

    for (const line of chunk) {
      if (/^№\s*[\d\/\-]+,?$/.test(line)) {
        docNum = line.replace(/^№\s*/, '').replace(/,$/, '').trim()
      } else if (/^(ГО|ИСПОЛНЕН|ВЫПОЛНЕН|ОТКЛОНЕН|ОТКЛОНЁН|ЧЕРНОВИК|НА ПОДПИСЬ|В ОБРАБОТКЕ)$/i.test(line)) {
        // Статус документа: раньше строка отбрасывалась и всем операциям
        // жёстко ставился 'executed' — из-за этого фильтры ДБО (черновики,
        // на подпись, в обработке, отклонённые) были неработоспособны.
        status = line.toUpperCase()
      } else if (/^счет /i.test(line) || line === ' ') {
        // skip
      } else if (!counterparty) {
        counterparty = line
      } else {
        desc += (desc ? ' ' : '') + line
      }
    }

    // Направление операции. Если выписка сама дала знак суммы («+2.00 ₽»), он и есть
    // истина: эвристика по префиксу «От:» в новом интерфейсе есть далеко не всегда,
    // и поступления помечались списаниями.
    const byPrefix = /^От:/i.test(counterparty)
    counterparty = counterparty.replace(/^(От|Кому)\s*:\s*/i, '').trim()
    const hadSign = /^[+\-]/.test(amountStr)
    const isIncoming = hadSign ? amount > 0 : byPrefix
    if (!hadSign && amount !== 0) {
      amount = isIncoming ? Math.abs(amount) : -Math.abs(amount)
    }

    if (amount !== 0 && counterparty) {
      const key = `${date}|${docNum}|${amount}`
      if (!seen.has(key)) {
        seen.add(key)
        payments.push({
          // Устойчивый идентификатор операции: банк не отдаёт id документа
          // в выписке, поэтому собираем ключ из даты, номера и суммы.
          id: key,
          date,
          number: docNum,
          recipient: counterparty,
          amount,
          direction: isIncoming ? 'in' : 'out',
          // 'ГО' в выписке = «исполнен банком»; если статус не нашёлся, операция
          // уже в выписке, значит проведена.
          status: status || 'ИСПОЛНЕН',
          purpose: desc,
        })
      }
    }
  }
  return payments
}

function extractPaymentsFromApiData(apiData) {
  const payments = []
  const seen = new Set()
  const getField = (o, ...names) => {
    for (const n of names) {
      for (const k of Object.keys(o)) {
        if (k.toLowerCase().includes(n.toLowerCase())) return o[k]
      }
    }
    return ''
  }
  const scan = (obj) => {
    if (Array.isArray(obj) && obj.length > 0 && obj.length < 2000) {
      for (const item of obj) {
        if (item && typeof item === 'object') {
          const keys = Object.keys(item).map(k => k.toLowerCase())
          const hasDate = keys.some(k => k.includes('date') || k.includes('дата') || k.includes('time'))
          const hasAmount = keys.some(k =>
            k.includes('amount') || k.includes('sum') || k.includes('сумм') ||
            k.includes('debit') || k.includes('credit')
          )
          if (hasDate && hasAmount) {
            const key = JSON.stringify(item).substring(0, 120)
            if (!seen.has(key)) {
              seen.add(key)
              payments.push({
                date: String(getField(item, 'date', 'дата', 'ddate', 'valueDate', 'operDate', 'docDate', 'createDate') || ''),
                number: String(getField(item, 'number', 'num', 'docNum', 'номер', 'id', 'docId', 'docNumber') || ''),
                recipient: String(getField(item, 'recipient', 'payee', 'beneficiary', 'контрагент', 'получатель', 'name', 'payeeName', 'counterparty') || ''),
                amount: parseFloat(String(getField(item, 'amount', 'sum', 'summa', 'сумма', 'debit', 'credit', 'debitAmount') || '0').replace(/\s/g, '').replace(',', '.')) || 0,
                status: String(getField(item, 'status', 'state', 'статус', 'состояние', 'docStatus') || ''),
              })
            }
          }
        }
      }
    } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const v of Object.values(obj)) scan(v)
    }
  }
  for (const { body } of apiData) {
    try { scan(JSON.parse(body)) } catch {}
  }
  return payments
}

async function getPaymentsData(username, password) {
  const p = await ensureLoggedIn(username, password)
  const currentUrl = p.url()
  if (currentUrl.includes('/api-ui')) {
    return getPaymentsViaResponseListener(p)
  } else {
    return getPaymentsClassicZK(p)
  }
}

async function getPaymentsViaResponseListener(p) {
  console.log('[browser] Collecting payment data, URL:', p.url(), 'cached responses:', cachedApiResponses.length)

  // Fast path: scroll to load all transactions, then parse from DOM text.
  const scrollAndParse = async () => {
    let prevCount = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      // Dismiss any modal that might have appeared
      await p.evaluate((() => {
        // Окно обязательного письма НЕ подтверждаем: нажатие кнопки в нём
        // означает «ознакомлен» от имени клиента. Просто убираем его с экрана,
        // чтобы не мешало навигации; подтверждение делает человек в приложении.
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) { m.setAttribute('data-pva-hidden', '1'); m.style.display = 'none' }
      }))
      // Scroll to bottom to trigger infinite load
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await p.waitForTimeout(1500)
      const text = await p.evaluate(() => document.body.innerText)
      const payments = parsePaymentLines(text)
      console.log('[browser] Scroll attempt', attempt + 1, ':', payments.length, 'payments')
      if (payments.length === prevCount && attempt > 0) break  // no new items loaded
      prevCount = payments.length
    }
    const finalText = await p.evaluate(() => document.body.innerText)
    return parsePaymentLines(finalText)
  }
  const domPayments = await scrollAndParse()
  if (domPayments.length > 0) {
    // Тегируем операции счётом выписки (20-значный номер из DOM)
    const acct = await p.evaluate(() => {
      const m = document.body.innerText.match(/\b(4\d{19})\b/)
      return m ? m[1] : ''
    })
    if (acct) domPayments.forEach(pm => { if (!pm.account) pm.account = acct })
    console.log('[browser] Got', domPayments.length, 'payments from DOM text (new interface), account', acct)
    return domPayments
  }

  // Payments can reuse the captured responses from the accounts navigation.
  // Attempt extraction from cached data first.
  if (cachedApiResponses.length > 0) {
    const fast = extractPaymentsFromApiData(cachedApiResponses)
    if (fast.length > 0) {
      console.log('[browser] Got', fast.length, 'payments from cached API responses')
      return fast
    }
    console.log('[browser] Cached responses had no payment data, doing fresh navigation')
  }
  const apiData = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!url.includes('centrinvest.ru')) return
    if (response.status() !== 200) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await response.text()
      if (body.length > 10) {
        console.log('[api tx]', response.request().method(), url.replace('https://dbo.centrinvest.ru', ''), body.length + 'b')
        if (body.length < 5000) console.log('[api tx] body:', body.substring(0, 800))
        apiData.push({ url, body })
      }
    } catch {}
  }

  p.on('response', onResponse)

  // Step 1: log all clickable nav elements so we can see the real structure in logs
  const navLinks = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('a, button, [role="menuitem"], [role="tab"], [role="button"]').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
      const href = el.getAttribute('href') || ''
      if (t.length > 1 && t.length < 60) out.push({ text: t, href })
    })
    return out.slice(0, 60)
  })
  console.log('[browser] Nav items found:', JSON.stringify(navLinks))

  // Step 2: navigate same path that works for accounts
  try { await p.click('text=Счета и платежи', { timeout: 4000 }); await p.waitForTimeout(2500) } catch {}
  try { await p.click('text=Выписка', { timeout: 3000 }); await p.waitForTimeout(3000) } catch {}

  // Step 3: click on the first listed account to load its transactions
  const firstAccountClicked = await p.evaluate(() => {
    const rows = document.querySelectorAll('tr, [class*="account-row"], [class*="AccountRow"], [class*="list-item"]')
    for (const row of rows) {
      const t = row.textContent || ''
      if (t.match(/\d{20}|\d{5}\.\d{3}/)) {
        row.click()
        return (row.textContent || '').trim().substring(0, 80)
      }
    }
    return null
  })
  if (firstAccountClicked) {
    console.log('[browser] Clicked account row:', firstAccountClicked)
    await p.waitForTimeout(3000)
  }

  // Step 4: try payment-keyword nav items
  const payKeywords = ['Платеж', 'платеж', 'Документ', 'История', 'Операци', 'Исходящи', 'Входящи', 'Перевод', 'Транзакци']
  for (const { text } of navLinks) {
    if (payKeywords.some(kw => text.includes(kw))) {
      try {
        console.log('[browser] Clicking:', text)
        await p.click(`text="${text}"`, { timeout: 2000 })
        await p.waitForTimeout(2500)
      } catch {}
    }
  }

  // Step 5: try direct REST API calls from page context (uses browser session/cookies)
  const origin = 'https://dbo.centrinvest.ru'
  const today = new Date().toISOString().split('T')[0]
  const ago90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]

  // Generic paths + account-specific transaction paths
  const accounts4Api = cachedAccounts.length > 0 ? cachedAccounts : [{ number: '' }]
  const tryPaths = [
    '/api/v1/payments', '/api/v1/transactions', '/api/v1/documents',
    '/api/v1/history', '/api/v1/operations', '/api/v1/statements',
    '/api/payments', '/api/documents', '/api/transactions', '/api/operations',
    '/rest/v1/payments', '/rest/v1/transactions',
    // Account-specific paths with known account numbers
    ...accounts4Api.flatMap(a => a.number ? [
      `/api/v1/accounts/${a.number}/transactions`,
      `/api/v1/accounts/${a.number}/statements`,
      `/api/v1/accounts/${a.number}/history`,
      `/api/v1/statements?accountNumber=${a.number}&dateFrom=${ago90}&dateTo=${today}`,
    ] : []),
  ]
  for (const path of tryPaths) {
    try {
      const result = await p.evaluate(async ({ origin, path }) => {
        const r = await fetch(origin + path, { credentials: 'include' })
        if (!r.ok) return null
        const ct = r.headers.get('content-type') || ''
        if (!ct.includes('json')) return null
        const text = await r.text()
        return { url: origin + path, body: text }
      }, { origin, path })
      if (result && result.body.length > 10) {
        console.log('[browser] Direct API hit:', path, result.body.length + 'b', result.body.substring(0, 400))
        apiData.push(result)
      }
    } catch {}
  }

  p.off('response', onResponse)
  console.log('[browser] Total tx API responses captured:', apiData.length)

  const payments = extractPaymentsFromApiData(apiData)

  if (payments.length === 0) {
    const bodyText = await p.evaluate(() => document.body.innerText)
    console.log('[browser] No payments. Page text:', bodyText.substring(0, 600))
    for (const { url, body } of apiData) {
      console.log('[browser] Had response', url.replace('https://dbo.centrinvest.ru', ''), ':', body.substring(0, 200))
    }
  }
  console.log('[browser] Found payments:', payments.length)
  return payments
}

async function getPaymentsClassicZK(p) {
  console.log('[zk] Starting payments navigation')

  // ZK submenus are hidden via CSS until parent menu item is hovered.
  // Use 4 methods in order: standard click → hover-parent+click → force click → JS DOM click.
  const zkClickMenu = async (label) => {
    const subSel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content, td.z-menuitemwrap-content, a.z-menuitem-content'

    // 1. Standard Playwright click (works if item is already visible)
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ timeout: 3000 })
      await p.waitForTimeout(7000)
      console.log(`[zk] std-clicked: ${label}`)
      return true
    } catch {}

    // 2. Hover over each top-level nav item to open its submenu, then click
    const parents = ['ПЛАТЕЖНЫЕ ДОКУМЕНТЫ', 'ПИСЬМА', 'АНАЛИТИКА', 'ВАЛЮТНЫЕ ОПЕРАЦИИ', 'ПРОДУКТЫ И УСЛУГИ', 'СЧЕТА']
    for (const parent of parents) {
      try {
        await p.locator(`text="${parent}"`).first().hover({ timeout: 2000 })
        await p.waitForTimeout(600)
        const el = p.locator(subSel).filter({ hasText: label }).first()
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 2000 })
          await p.waitForTimeout(7000)
          console.log(`[zk] hover(${parent})->clicked: ${label}`)
          return true
        }
      } catch {}
    }

    // 3. Playwright force click (bypasses actionability checks, fires pointer events)
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ force: true, timeout: 3000 })
      await p.waitForTimeout(7000)
      console.log(`[zk] force-clicked: ${label}`)
      return true
    } catch {}

    // 4. Unhide hidden ancestors then click — DOM inspection shows elements exist but
    //    are inside display:none popup containers. Must unhide chain first so ZK
    //    doesn't ignore the click as "element not visible".
    const clicked = await p.evaluate((label) => {
      // Target span.z-menuitemwrap-text (leaf element with exact own text)
      for (const span of document.querySelectorAll('span.z-menuitemwrap-text')) {
        if (span.textContent.trim() !== label) continue
        // Walk ancestors and unhide any display:none containers
        let el = span
        let unhid = 0
        while (el && el !== document.body) {
          if (window.getComputedStyle(el).display === 'none') {
            el.style.display = 'block'
            unhid++
          }
          el = el.parentElement
        }
        // Click the anchor parent which has the ZK event handler
        const a = span.closest('a') || span
        a.click()
        return `unhid-${unhid} cls=${a.className.substring(0, 40)}`
      }
      return null
    }, label)
    if (clicked) {
      console.log(`[zk] js-unhide-click: ${label} => ${clicked}`)
      await p.waitForTimeout(7000)
      return true
    }

    return false
  }

  // "Выписки" (Statement) shows ALL account operations as a flat table with date filter.
  // Fall back to "Исходящие документы" (outgoing only) if "Выписки" isn't found.
  let navigated = await zkClickMenu('Выписки')
  if (!navigated) navigated = await zkClickMenu('Исходящие документы')
  if (!navigated) navigated = await zkClickMenu('История операций')
  console.log('[zk] navigated:', navigated)

  const afterText = await p.evaluate(() => document.body.innerText.substring(0, 800))
  console.log('[zk] Page after nav:', afterText)

  // Switch to "Выписки за период" tab which shows individual transactions with amounts,
  // rather than statement summaries ("Все выписки" tab has no amount column).
  const tabSwitched = await p.evaluate(() => {
    for (const el of document.querySelectorAll('button, td.z-button, a.z-button, .z-button, .z-toolbarbutton, .z-tab, [class*="tab"]')) {
      const t = (el.textContent || '').trim().toUpperCase()
      if (t === 'ВЫПИСКИ ЗА ПЕРИОД') { el.click(); return el.textContent.trim() }
    }
    return null
  })
  if (tabSwitched) {
    console.log('[zk] Switched to tab:', tabSwitched)
    await p.waitForTimeout(5000)
  } else {
    console.log('[zk] ВЫПИСКИ ЗА ПЕРИОД tab not found, staying on current view')
  }

  const today = new Date()
  const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
  const dateFrom = fmt(new Date(today - 90 * 86400000))
  const dateTo   = fmt(today)
  let filterSubmitted = 'no date inputs found'

  try {
    const dateInputs = p.locator('input.z-dateboxwrap-input')
    const count = await dateInputs.count()
    console.log('[zk] z-dateboxwrap-input count:', count)
    if (count >= 2) {
      await dateInputs.first().click({ force: true, timeout: 3000 }).catch(() => {})
      await dateInputs.first().fill(dateFrom).catch(() => {})
      await dateInputs.first().press('Tab').catch(() => {})
      await p.waitForTimeout(300)
      await dateInputs.nth(1).click({ force: true, timeout: 3000 }).catch(() => {})
      await dateInputs.nth(1).fill(dateTo).catch(() => {})
      await dateInputs.nth(1).press('Enter').catch(() => {})
      filterSubmitted = `playwright-fill: ${dateFrom} -> ${dateTo}`
      console.log('[zk] Date inputs filled')
    }
  } catch {}

  const jsResult = await p.evaluate(({ dateFrom, dateTo }) => {
    const inputs = [...document.querySelectorAll('input.z-dateboxwrap-input, input[class*="z-datebox"]')]
    if (inputs.length < 2) return 'no-inputs'
    const set = (el, val) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, val)
      el.dispatchEvent(new Event('input',{bubbles:true}))
      el.dispatchEvent(new Event('change',{bubbles:true}))
      el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',keyCode:13}))
    }
    set(inputs[0], dateFrom); set(inputs[1], dateTo)
    return `js-set-ok`
  }, { dateFrom, dateTo })
  filterSubmitted = `${filterSubmitted || 'no-click'}+${jsResult}`
  await p.waitForTimeout(3000)

  const btnClicked = await p.evaluate(() => {
    const btnTexts = ['Показать', 'Найти', 'Применить', 'Поиск', 'Искать']
    for (const btn of document.querySelectorAll('button, .z-button, a.z-button, td.z-button, .z-toolbarbutton')) {
      const t = btn.textContent.trim()
      if (btnTexts.some(b => t.includes(b))) { btn.click(); return `clicked: ${t}` }
    }
    return null
  })
  console.log('[zk] filter result:', filterSubmitted, '| btn:', btnClicked)
  await p.waitForTimeout(6000)

  const extractPaymentRows = () => {
    const results = []
    const seen = new Set()

    const processRows = (selector, useChildren) => {
      document.querySelectorAll(selector).forEach(row => {
        const cellEls = useChildren
          ? Array.from(row.querySelectorAll('td, .z-listcell, .z-cell, .z-detailtd'))
          : Array.from(row.querySelectorAll('td'))
        const cells = cellEls.map(td => td.textContent.trim()).filter(Boolean)
        if (cells.length < 3) return
        // Accept dates with or without time: 19.05.2026 or 19.05.2026 02:25
        const dateIdx = cells.findIndex(c => /^\d{2}\.\d{2}\.\d{4}/.test(c))
        if (dateIdx === -1) return
        if (cells.some(c =>
          c.includes('за прошлый день') || c.includes('за сегодня') ||
          c.includes('за период') || c === 'Дата' || c === 'Дата операции' ||
          c === 'Номер' || c === 'Сумма' || c === 'Получатель'
        )) return
        // Amount: digits/spaces + comma/dot + 1-2 digits (handles "221,10" and "1 234,56")
        const amtCell = cells.find(c => /^[\d\s]+[,\.]\d{1,2}$/.test(c.trim()) && c.trim() !== '0,00')
        if (!amtCell) return
        const key = cells.slice(0, 4).join('|')
        if (seen.has(key)) return
        seen.add(key)
        const recipientCell = cells.find((c, i) =>
          i !== dateIdx && c.length > 3 &&
          !/^\d{1,}$/.test(c) &&
          !/^\d{2}\.\d{2}\.\d{4}/.test(c) &&
          !/^\d{5}\.\d{3}/.test(c) &&
          !c.includes('за ')
        ) || ''
        const dateRaw = cells[dateIdx]
        const dateOnly = (dateRaw.match(/\d{2}\.\d{2}\.\d{4}/) || [dateRaw])[0]
        results.push({
          date: dateOnly,
          number: cells.find((c, i) => i > dateIdx && /^\d{4,}$/.test(c)) || '',
          recipient: recipientCell,
          amount: parseFloat(amtCell.replace(/\s/g, '').replace(',', '.')) || 0,
          status: cells[cells.length - 1] || '',
        })
      })
    }

    processRows('tr.z-listitem, tr.z-row, tr[class*="listitem"], tr[class*="z-list"]', false)
    if (results.length === 0) processRows('tr', false)
    // Also try ZK detail/grid rows that use non-tr containers
    if (results.length === 0) processRows('[class*="z-detail"], [class*="z-row"], [class*="listitem"]', true)
    return results
  }

  let payments = await p.evaluate(extractPaymentRows)

  // If still empty, try waiting longer and re-extract
  if (payments.length === 0) {
    console.log('[zk] No payments yet, waiting 5s more...')
    await p.waitForTimeout(5000)
    const afterText2 = await p.evaluate(() => document.body.innerText.substring(0, 800))
    console.log('[zk] Page after extra wait:', afterText2)
    payments = await p.evaluate(extractPaymentRows)
  }

  console.log('[zk] Payments found:', payments.length, payments.slice(0, 3))
  return payments
}

async function getWhoAmI(username, password) {
  const p = await ensureLoggedIn(username, password)
  const name = await p.evaluate(() => {
    // Check common profile selectors first
    for (const sel of ['.user-name', '.profile-name', '[data-testid="user-name"]', '.header-user', '.navbar-user']) {
      const el = document.querySelector(sel)
      if (el) { const t = el.textContent.trim(); if (t.length > 5) return t }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim()
      // All-caps: ПОПЕНКОВ СЕРГЕЙ ВАСИЛЬЕВИЧ
      if (t.match(/^[А-ЯЁ][А-ЯЁ\s]{10,}[А-ЯЁ]$/) && t.split(' ').length === 3) return t
      // Mixed-case: Попенков Сергей Васильевич
      if (t.match(/^[А-ЯЁ][а-яё]{2,}\s[А-ЯЁ][а-яё]{2,}\s[А-ЯЁ][а-яё]{2,}$/) && t.split(' ').length === 3) return t
    }
    return null
  })
  return name
}

/**
 * Письмо банка, обязательное к прочтению.
 *
 * Банк выводит его поверх интерфейса при входе или при первом же обращении
 * к серверу и ждёт подтверждения ознакомления (Руководство пользователя БСС,
 * разд. 2.4.3). Подтверждение — юридически значимое действие клиента, поэтому
 * сервис его НЕ делает: он только показывает письмо приложению.
 */
function getMustRead() {
  return pendingMustRead
}

/**
 * Подтвердить прочтение — строго по явной команде человека.
 * Возвращаем окно на экран, жмём кнопку подтверждения и отвечаем «Да»
 * на вопрос банка. Текст письма остаётся в журнале сервиса.
 */
async function confirmMustRead(username, password) {
  if (!pendingMustRead) return { confirmed: false, reason: 'нет письма, ждущего подтверждения' }
  const p = await ensureLoggedIn(username, password)

  const done = await p.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const box = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
    if (!box) return { ok: false, reason: 'окно письма уже закрыто банком' }
    box.style.display = ''
    box.removeAttribute('data-pva-hidden')

    // Кнопка подтверждения в самом окне письма
    const btns = Array.from(box.querySelectorAll('button,[role=button]'))
    const confirm = btns.find(b => /подтверд|прочит|ознакомл/i.test(b.innerText || '')) || btns[btns.length - 1]
    if (!confirm) return { ok: false, reason: 'в окне письма нет кнопки подтверждения' }
    confirm.click()
    await sleep(1200)

    // Банк переспрашивает: «Подтвердить прочтение?» — отвечаем «Да»
    const yes = Array.from(document.querySelectorAll('button,[role=button]'))
      .find(b => /^\s*да\s*$/i.test(b.innerText || ''))
    if (yes) { yes.click(); await sleep(800) }
    return { ok: true }
  }).catch(e => ({ ok: false, reason: e.message }))

  if (done.ok) {
    console.log('[mustread] человек подтвердил прочтение письма банка')
    pendingMustRead = null
  }
  return { confirmed: !!done.ok, reason: done.reason || '' }
}

async function closeBrowser() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    sessionExpiry = 0
  }
}

async function getNavDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  const currentUrl = p.url()

  // Show already-cached API responses
  const cachedUrls = cachedApiResponses.map(r => ({
    url: r.url.replace('https://dbo.centrinvest.ru', ''),
    len: r.body.length,
    preview: r.body.substring(0, 200),
  }))

  // Dump full nav structure + all page text
  const navItems = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('a, button, [role="menuitem"], [role="tab"], [role="button"], li').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
      const href = el.getAttribute('href') || ''
      const cls = el.className || ''
      if (t.length > 1 && t.length < 80) out.push({ text: t, href, cls: cls.substring(0, 60) })
    })
    return out.slice(0, 80)
  })

  const pageText = await p.evaluate(() => document.body.innerText.substring(0, 1000))

  // Try direct API fetch from page context to discover endpoints
  const origin = 'https://dbo.centrinvest.ru'
  const tryPaths = [
    '/api/v1/payments', '/api/v1/transactions', '/api/v1/documents',
    '/api/v1/accounts', '/api/v1/history', '/api/v1/operations',
    '/api-ui/api/v1/accounts', '/api-ui/api/v1/payments',
    '/sbns-web/api/v1/accounts',
  ]
  const directResults = []
  for (const path of tryPaths) {
    try {
      const result = await p.evaluate(async ({ origin, path }) => {
        const r = await fetch(origin + path, { credentials: 'include' })
        const ct = r.headers.get('content-type') || ''
        const body = ct.includes('json') ? await r.text() : '[not json: ' + ct + ']'
        return { path, status: r.status, body: body.substring(0, 300) }
      }, { origin, path })
      directResults.push(result)
    } catch (e) {
      directResults.push({ path, error: e.message })
    }
  }

  return { currentUrl, cachedUrls, navItems, pageText, directResults }
}

async function getTemplatesData(username, password) {
  const p = await ensureLoggedIn(username, password)
  console.log('[zk] Getting templates')

  // "Корреспонденты" is in Справочники submenu — these are payment counterparties/templates
  const sel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content'
  for (const label of ['Корреспонденты', 'Шаблоны', 'Шаблоны платежей']) {
    try {
      const el = p.locator(sel).filter({ hasText: label }).first()
      await el.click({ timeout: 4000 })
      await p.waitForTimeout(6000)
      console.log('[zk] templates nav clicked:', label)
      break
    } catch {}
  }

  const templates = await p.evaluate(() => {
    const results = []
    const seen = new Set()
    document.querySelectorAll('tr.z-listitem, tr.z-row, tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()).filter(Boolean)
      if (cells.length < 2) return
      // A counterparty/template row: has a name (non-numeric, > 3 chars) and account number
      const name = cells.find(c => c.length > 3 && !/^\d+$/.test(c) && !/^\d{2}\.\d{2}/.test(c))
      const account = cells.find(c => /^\d{20}$/.test(c.replace(/\./g, '').replace(/\s/g, '')))
      if (!name || !account) return
      const key = account
      if (seen.has(key)) return
      seen.add(key)
      const bic = cells.find(c => /^\d{9}$/.test(c)) || ''
      results.push({ id: account, name, account: account.replace(/\./g, ''), bank: '', bic, inn: '' })
    })
    return results
  })

  console.log('[zk] Templates found:', templates.length)
  return templates
}

async function getPaymentsDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  console.log('[debug] Current URL:', p.url())

  const subSel = 'a.z-menuitemwrap-content, span.z-menuitemwrap-content, td.z-menuitemwrap-content, a.z-menuitem-content'
  let clickedLabel = null
  for (const label of ['Выписки', 'Исходящие документы', 'История операций']) {
    // Try standard click first, then hover parents, then JS force-click
    let done = false
    try {
      await p.locator(subSel).filter({ hasText: label }).first().click({ timeout: 3000 })
      await p.waitForTimeout(7000); done = true
    } catch {}
    if (!done) {
      for (const parent of ['ПЛАТЕЖНЫЕ ДОКУМЕНТЫ', 'ПИСЬМА', 'АНАЛИТИКА', 'ВАЛЮТНЫЕ ОПЕРАЦИИ', 'ПРОДУКТЫ И УСЛУГИ']) {
        try {
          await p.locator(`text="${parent}"`).first().hover({ timeout: 2000 })
          await p.waitForTimeout(500)
          const el = p.locator(subSel).filter({ hasText: label }).first()
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 2000 })
            await p.waitForTimeout(7000); done = true; break
          }
        } catch {}
      }
    }
    if (!done) {
      const clicked = await p.evaluate((label) => {
        for (const span of document.querySelectorAll('span.z-menuitemwrap-text')) {
          if (span.textContent.trim() !== label) continue
          let el = span; let unhid = 0
          while (el && el !== document.body) {
            if (window.getComputedStyle(el).display === 'none') { el.style.display = 'block'; unhid++ }
            el = el.parentElement
          }
          const a = span.closest('a') || span
          a.click()
          return `unhid-${unhid}`
        }
        return null
      }, label)
      if (clicked) { await p.waitForTimeout(7000); done = true }
    }
    if (done) { clickedLabel = label; break }
  }

  const pageTextBefore = await p.evaluate(() => document.body.innerText.substring(0, 1500))

  // Fill date inputs via Playwright native fill (proper ZK event chain)
  const today2 = new Date()
  const fmt2 = (d) => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
  const dbgDateFrom = fmt2(new Date(today2 - 90*86400000))
  const dbgDateTo = fmt2(today2)
  let filterResult = 'no date inputs'
  try {
    const dbgInputs = p.locator('input.z-dateboxwrap-input')
    const dbgCount = await dbgInputs.count()
    if (dbgCount >= 2) {
      await dbgInputs.first().click({ force: true, timeout: 3000 }).catch(() => {})
      await dbgInputs.first().fill(dbgDateFrom).catch(() => {})
      await dbgInputs.first().press('Tab').catch(() => {})
      await p.waitForTimeout(300)
      await dbgInputs.nth(1).click({ force: true, timeout: 3000 }).catch(() => {})
      await dbgInputs.nth(1).fill(dbgDateTo).catch(() => {})
      await dbgInputs.nth(1).press('Enter').catch(() => {})
      filterResult = `playwright-fill: ${dbgDateFrom}->${dbgDateTo}`
    }
  } catch (e) { filterResult = `error: ${e.message}` }
  // Also try JS setter
  const dbgJs = await p.evaluate(({ df, dt }) => {
    const inputs = [...document.querySelectorAll('input.z-dateboxwrap-input')]
    if (inputs.length < 2) return 'no-inputs'
    const set = (el,v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v)
      el.dispatchEvent(new Event('input',{bubbles:true}))
      el.dispatchEvent(new Event('change',{bubbles:true}))
    }
    set(inputs[0],df); set(inputs[1],dt); return 'js-ok'
  }, { df: dbgDateFrom, dt: dbgDateTo })
  filterResult = `${filterResult}+${dbgJs}`
  // Click Показать if present
  const showClicked = await p.evaluate(() => {
    for (const btn of document.querySelectorAll('button,.z-button,a.z-button,td.z-button')) {
      const t = btn.textContent.trim()
      if (['Показать','Найти','Применить'].some(b => t.includes(b))) { btn.click(); return t }
    }
    return null
  })
  filterResult = `${filterResult}|btn:${showClicked}`
  await p.waitForTimeout(7000)

  // Click the first STATEMENT row (must have 20-digit account number + date).
  // Using this specificity avoids accidentally clicking news/nav z-listitem rows.
  const rowClicked = await p.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.z-listitem'))
    const stmtRow = rows.find(r => {
      const t = r.textContent || ''
      return /\d{20}/.test(t) && /\d{2}\.\d{2}\.\d{4}/.test(t)
    })
    if (!stmtRow) return null
    stmtRow.click()
    return (stmtRow.textContent || '').trim().substring(0, 100)
  })
  filterResult = `${filterResult}|row:${rowClicked ? 'clicked' : 'null'}`
  if (rowClicked) {
    console.log('[dbg] Clicked statement row:', rowClicked)
    await p.waitForTimeout(10000)
  }

  // After row click: look for any popup/detail window that appeared
  const popupText = await p.evaluate(() => {
    const detailSelectors = ['.z-window', '.z-popup', '[class*="z-detail"]', '[class*="z-panel"]']
    for (const sel of detailSelectors) {
      const el = document.querySelector(sel)
      if (el && el.offsetParent !== null) {
        return { sel, text: (el.textContent || '').trim().substring(0, 800) }
      }
    }
    return null
  })

  // Find DOM structure for amount elements (works for new API-UI interface)
  const amountElements = await p.evaluate(() => {
    const out = []
    const amtRe = /[+\-]?\d[\d\s]*[,.]\d{2}\s*[₽$€]|[+\-]\d+\.?\d*\s*₽/
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (!amtRe.test(t)) continue
      const parent = el.parentElement
      const grand = parent?.parentElement
      out.push({
        tag: el.tagName,
        cls: (el.className || '').substring(0, 60),
        text: t.substring(0, 40),
        parentTag: parent?.tagName,
        parentCls: (parent?.className || '').substring(0, 80),
        grandCls: (grand?.className || '').substring(0, 80),
        rowHtml: (grand?.outerHTML || parent?.outerHTML || '').substring(0, 500),
      })
      if (out.length >= 5) break
    }
    return out
  })

  const pageTextAfter = await p.evaluate(() => document.body.innerText.substring(0, 2000))
  const allInputs = await p.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, value: i.value, placeholder: i.placeholder, cls: i.className.substring(0,40) })).slice(0, 20)
  )
  const allButtons = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button, .z-button')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 20)
  )
  const rows = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()).filter(Boolean)
      if (cells.length >= 2) out.push({ cls: row.className.substring(0,50), cells: cells.slice(0, 8) })
    })
    return out.slice(0, 60)
  })

  // Dump structure around rows containing date-like text (dd.mm.yyyy) to understand DOM
  const dateRowsHtml = await p.evaluate(() => {
    const out = []
    const dateRe = /\d{2}\.\d{2}\.\d{4}/
    // Check non-tr rows too (ZK grid/detail rows use div)
    for (const el of document.querySelectorAll('tr, [class*="z-row"], [class*="z-listitem"], [class*="z-detail"]')) {
      if (dateRe.test(el.textContent || '')) {
        out.push({
          tag: el.tagName,
          cls: (el.className || '').substring(0, 60),
          text: (el.textContent || '').trim().substring(0, 120),
          html: el.outerHTML.substring(0, 400),
        })
        if (out.length >= 10) break
      }
    }
    return out
  })

  // Inspect DOM for target labels — help diagnose why click fails
  const domSearch = await p.evaluate(() => {
    const targets = ['История операций', 'Исходящие документы']
    const results = {}
    for (const label of targets) {
      const found = []
      document.querySelectorAll('*').forEach(el => {
        const t = (el.textContent || '').trim()
        const own = [...(el.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('')
        if (own.includes(label) || t === label) {
          found.push({
            tag: el.tagName,
            cls: (el.className || '').substring(0, 60),
            text: t.substring(0, 60),
            ownText: own.substring(0, 60),
            vis: el.offsetParent !== null,
            display: (window.getComputedStyle(el).display || '').substring(0, 20),
          })
        }
      })
      results[label] = found.slice(0, 6)
    }
    return results
  })

  return { version: 'v14', clickedLabel, filterResult, pageTextBefore: pageTextBefore.substring(0,600), pageTextAfter: pageTextAfter.substring(0,3000), popupText, amountElements, allInputs, allButtons, rows, dateRowsHtml, domSearch }
}

function getApiResponsesDebug() {
  return cachedApiResponses.map(r => ({
    url: r.url.replace('https://dbo.centrinvest.ru', ''),
    length: r.body.length,
    preview: r.body.substring(0, 500)
  }))
}

async function getAccountsDomDebug(username, password) {
  const p = await ensureLoggedIn(username, password)
  const before = { url: p.url() }
  const apiCapture = []
  const onResp = async (resp) => {
    if (!resp.url().includes('centrinvest.ru')) return
    if (resp.status() !== 200) return
    try {
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const body = await resp.text()
      if (body.length > 10) apiCapture.push({ url: resp.url().replace('https://dbo.centrinvest.ru', ''), body: body.substring(0, 800) })
    } catch {}
  }
  p.on('response', onResp)
  try { await p.click('text=Счета и платежи', { timeout: 5000 }); await p.waitForTimeout(3000) } catch (e) { before.clickErr = e.message }
  p.off('response', onResp)
  const domText = await p.evaluate(() => document.body.innerText)
  return {
    urlBefore: before.url,
    urlAfter: p.url(),
    clickErr: before.clickErr,
    apiCapture,
    domTextLength: domText.length,
    domTextPreview: domText.substring(0, 2000),
    accountNumbers: (domText.match(/\b\d{20}\b/g) || []).slice(0, 30)
  }
}



async function getContractorsFromHistory(username, password) {
  // Get full payment list (already handles scrolling and loading)
  const payments = await getPaymentsData(username, password)
  console.log('[contractors] Using', payments.length, 'payments to extract contractors')

  // Self-transfer names to exclude
  const selfNames = /ПОПЕНКОВ|ПАО КБ|ЦЕНТР-ИНВЕСТ|корп\.карта|р\/с Ставрополь/i

  // Aggregate by recipient name — include both directions (incoming = client, outgoing = supplier)
  const byName = {}
  for (const pay of payments) {
    const name = (pay.recipient || '').trim()
    if (!name || selfNames.test(name)) continue
    if (!byName[name]) byName[name] = { name, count: 0 }
    byName[name].count++
  }

  const targets = Object.values(byName).sort((a, b) => b.count - a.count)
  console.log('[contractors] Unique external counterparties:', targets.length, targets.map(t => t.name))

  if (targets.length === 0) return []

  // Return without account/BIC — user fills in or we scrape details later
  return targets.map(t => ({
    id: t.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '_').substring(0, 40) + '_' + Date.now(),
    name: t.name,
    account: '',
    bic: '',
    bank: '',
    inn: '',
  }))
}




async function submitPayment(username, password, paymentData) {
  const p = await ensureLoggedIn(username, password)

  console.log('[browser] Submitting payment:', JSON.stringify(paymentData).substring(0, 200))

  // Dismiss modal if present
  await p.evaluate((() => {
        // Окно обязательного письма НЕ подтверждаем: нажатие кнопки в нём
        // означает «ознакомлен» от имени клиента. Просто убираем его с экрана,
        // чтобы не мешало навигации; подтверждение делает человек в приложении.
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) { m.setAttribute('data-pva-hidden', '1'); m.style.display = 'none' }
      }))
  await p.waitForTimeout(500)

  // Click "Оплатить" (Pay) in the nav to open payment form
  try {
    await p.click('text=Оплатить', { timeout: 5000 })
    await p.waitForTimeout(2000)
  } catch {
    // Try "Создать" button
    try {
      await p.click('text=Создать', { timeout: 3000 })
      await p.waitForTimeout(2000)
    } catch (e) {
      throw new Error('Не удалось открыть форму платежа: ' + e.message)
    }
  }

  // If multiple options appear, click "Платёж" or "Платежное поручение"
  try {
    const optionClicked = await p.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a'))
      for (const el of items) {
        const t = (el.textContent || '').trim()
        if (/^(Платёж|Платежное поручение|Платеж)$/i.test(t)) {
          el.click(); return t
        }
      }
      return null
    })
    if (optionClicked) {
      console.log('[browser] Clicked option:', optionClicked)
      await p.waitForTimeout(2000)
    }
  } catch {}

  // Fill recipient account
  const rec = paymentData.recipient || {}
  const fillField = async (labelText, value) => {
    if (!value) return
    try {
      // Try label-based targeting
      const filled = await p.evaluate((args) => {
        const [label, val] = args
        const labels = Array.from(document.querySelectorAll('label, [placeholder]'))
        for (const el of labels) {
          if ((el.textContent || el.getAttribute('placeholder') || '').toLowerCase().includes(label.toLowerCase())) {
            const input = el.tagName === 'LABEL'
              ? document.getElementById(el.htmlFor) || el.nextElementSibling
              : el
            if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
              input.focus()
              input.value = val
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
          }
        }
        return false
      }, [labelText, value])
      if (filled) console.log('[browser] Filled field:', labelText)
    } catch (e) {
      console.log('[browser] Could not fill', labelText, ':', e.message)
    }
  }

  await fillField('счёт получателя', rec.account || '')
  await fillField('расчётный счёт', rec.account || '')
  await p.waitForTimeout(500)
  await fillField('бик', rec.bic || '')
  await fillField('БИК', rec.bic || '')
  await p.waitForTimeout(800)
  await fillField('получател', rec.name || '')
  await fillField('наименование', rec.name || '')
  await fillField('сумм', String(paymentData.amount || ''))
  await fillField('назначение', paymentData.purpose || '')

  // Capture the form state for debugging
  const formState = await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
    return inputs.map(el => ({
      name: el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '',
      value: el.value,
      type: el.tagName
    })).filter(f => f.name || f.value)
  })
  console.log('[browser] Form state after fill:', JSON.stringify(formState).substring(0, 600))

  // Submit the form
  try {
    // Try clicking submit button
    const submitted = await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], button'))
      const submitBtn = btns.find(b => /отправ|подпис|сохран|создат|ok|далее|продолж/i.test(b.textContent || ''))
      if (submitBtn) { submitBtn.click(); return (submitBtn.textContent || '').trim() }
      return null
    })
    if (submitted) {
      console.log('[browser] Clicked submit:', submitted)
      await p.waitForTimeout(3000)
    } else {
      throw new Error('Кнопка отправки не найдена')
    }
  } catch (e) {
    throw new Error('Ошибка отправки формы: ' + e.message)
  }

  // Check result
  const resultText = await p.evaluate(() => document.body.innerText)
  const success = /исполнен|отправлен|принят|сохранён|черновик|создан/i.test(resultText.substring(0, 500))
  const docNum = (resultText.match(/№\s*([\d\/]+)/) || [])[1] || `local-${Date.now()}`

  return {
    ...paymentData,
    id: docNum,
    status: success ? 'created' : 'draft',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  }
}

// Выписка за период — через REST банка, тот же путь, что у веб-версии.
//
// Раньше файл добывался разбором старого интерфейса: искалась кнопка по тексту
// среди `button, a` и ожидалось событие загрузки. Банк рисует эту кнопку иначе,
// клик не происходил, и всё падало по «Timeout 25000ms waiting for download».
//
// Настоящий порядок (сверено с исходниками d2sme, app/forms/StatementPrint):
//   1) menu/click «Счета и платежи» → форма ui/account с гридом счетов;
//   2) doAction statement_accounts (или partnerStatement_accounts — выписка
//      по контрагенту) → открывается форма ui/ui/statements/print;
//   3) счета задаются НЕ строкой, а выбором в отдельном окне: doAction
//      selectAccounts → в ui/account/accountsSelector ставим value самого
//      поля-грида массивом id (так BSS отмечает строки) → doAction select.
//      Без этого банк отвечает «Счета не заданы»;
//   4) поля отправляются ПО ОДНОМУ, каждое своим submitField: смена
//      datePeriod пересчитывает даты на сервере и затирает переданные вместе
//      с ней fromDate/toDate;
//   5) doAction print_report → команда fileDownload с fileId;
//   6) файл забирается GET /api/v1/fileDownload?fileId=…
//
// Всё это только чтение: печать выписки ничего в банке не создаёт.

// Формы отчёта: наши коды → коды банка
const STMT_FORMS = { '1': 'form1', '1a': 'form11', '2': 'form2', '3': 'form3', '4': 'form4' }
const STMT_FORMATS = { pdf: 'pdf', xls: 'xls', xlsx: 'xls' }

/**
 * Двоичный ответ банка (файлы, картинки) по произвольному пути /api/v1/….
 * JSON-мост тут не годится: он разбирает ответ как JSON и портит байты.
 */
async function bankBinary(p, path) {
  if (!sessionAuthToken) throw new Error('токен сессии банка не пойман')
  const res = await p.evaluate(async ([u, t]) => {
    const r = await fetch('https://dbo.centrinvest.ru' + u, {
      credentials: 'include',
      headers: { authToken: t, Accept: '*/*' },
    })
    const buf = await r.arrayBuffer()
    // Переводим в base64 кусками: длинные массивы в apply не помещаются
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return {
      status: r.status,
      type: r.headers.get('content-type') || '',
      disposition: r.headers.get('content-disposition') || '',
      b64: btoa(bin),
    }
  }, [path, sessionAuthToken])

  if (res.status !== 200) throw new Error(`банк не отдал файл (код ${res.status})`)
  const buffer = Buffer.from(res.b64, 'base64')
  if (!buffer.length) throw new Error('банк вернул пустой файл')
  // Имя файла: сначала RFC 5987 (filename*=UTF-8''…), затем обычное
  const m = /filename\*=UTF-8''([^;]+)/i.exec(res.disposition) || /filename="?([^";]+)"?/i.exec(res.disposition)
  const name = m ? decodeURIComponent(m[1].trim()) : ''
  return { buffer, name, contentType: res.type }
}

/** Файл банка по fileId — та же ручка, что у веб-версии при скачивании. */
const bankFile = (p, fileId) =>
  bankBinary(p, '/api/v1/fileDownload?fileId=' + encodeURIComponent(fileId))

/**
 * Баннеры главной страницы — те самые плашки «Депозиты», «АУСН» и прочие,
 * которые банк показывает в веб-версии. Список приходит обычным REST,
 * а картинки лежат отдельными файлами и тянутся по fileId.
 *
 * Приложение не может взять их с хоста банка напрямую: оно живёт на другом
 * домене, а контур закрыт ГОСТ-TLS — поэтому картинки отдаём через себя.
 */
async function getBanners(username, password) {
  const p = await ensureLoggedIn(username, password)
  await waitForAppReady(p, 45000)
  const r = await bankApi(p, 'GET', '/api/v1/banner/list?_offset=0&_limit=50')
  const list = Array.isArray(r.json) ? r.json : (r.json?.list || r.json?.items || [])
  return list
    .map(b => ({
      id: String(b.id || ''),
      title: String(b.title || b.name || '').trim(),
      text: String(b.text || b.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      // Куда ведёт «Подробнее». Внутренние переходы банка мы не повторяем —
      // отдаём только внешние ссылки, остальное просто показываем картинкой.
      link: b.offerType === 'EXTERNAL_LINK' ? String(b.externalLink || '') : '',
      linkLabel: String(b.moreInfoActionName || '').trim(),
      bgColor: String(b.bgColor || ''),
      priority: Number(b.priority) || 0,
      // fileId картинки: в веб-версии её тянут по image.id
      imageId: String(b.image?.id || b.image?.fileId || ''),
      contentType: String(b.image?.contentType || ''),
    }))
    .filter(b => b.imageId)
    .sort((a, b) => a.priority - b.priority)
}

/** Картинка баннера. Отдаём байты как есть — приложение покажет их сразу. */
async function getBannerImage(username, password, imageId) {
  if (!imageId) throw new Error('не указан идентификатор картинки')
  const p = await ensureLoggedIn(username, password)
  await waitForAppReady(p, 45000)
  const got = await bankBinary(p, `/api/v1/filesDownload?fileId=${encodeURIComponent(imageId)}&saved=true`)
  return { buffer: got.buffer, contentType: got.contentType || 'image/png' }
}

async function downloadStatement(username, password, { account = '', dateFrom, dateTo, format = 'pdf', reportForm = '1', by = 'account', partner = '' }) {
  const p = await ensureLoggedIn(username, password)
  await waitForAppReady(p, 45000)
  const log = (...a) => console.log('[statement]', ...a)

  const cmdsOf = (r) => r?.json?.commands || []
  const lastForm = (cmds, name) => [...cmds].reverse()
    .find(c => c.command === 'formInit' && c.instanceName === name)
  const tokenOf = (cmds, name, fallback) => {
    let t = fallback
    for (const c of cmds) if (c.instanceName === name && c.instanceToken) t = c.instanceToken
    return t
  }
  const dialogOf = (cmds) => cmds.find(c => /confirmDialog/.test(c.instanceName || ''))
  const errorOf = (cmds) => cmds.find(c => /errorDialog/.test(c.instanceName || ''))
  // Текст банк кладёт по-разному: в `message`, в `text`, а у части окон —
  // списком в `messages`. Читая только `message`, мы получали пустую строку
  // и писали «банк запросил подтверждение, которого мы не ожидали», хотя
  // вопрос был, и человек не понимал, о чём его спросили.
  const msgOf = (c) => {
    const f = c?.fields || {}
    const parts = []
    for (const key of ['message', 'text', 'messages']) {
      const m = f[key]
      const v = m && typeof m === 'object' && !Array.isArray(m) ? m.value : m
      if (Array.isArray(v)) parts.push(...v.map(x => (x && typeof x === 'object' ? x.value ?? x.message ?? '' : x)))
      else if (v) parts.push(v)
    }
    return parts.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  // 1. Форма счетов
  const open = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-accounts-and-payments' })
  const accForm = lastForm(cmdsOf(open), 'ui/account')
  if (!accForm) throw new Error('банк не открыл раздел счетов')

  const rows = accForm.fields?.accounts?.items || []
  const want = String(account || '').replace(/\s/g, '')
  // Пустой account — строка «Все счета»: она идёт первой и без номера
  const row = want
    ? rows.find(r => String(r.account || '').replace(/\s/g, '') === want)
    : rows.find(r => !r.account) || rows[0]
  if (!row) throw new Error(`счёт ${account} не найден в банке`)

  // 2. Открываем окно печати выписки
  const action = by === 'contractor' ? 'partnerStatement_accounts' : 'statement_accounts'
  const opened = await bankApi(p, 'PUT', '/api/v1/ui/account/doAction', {
    instanceToken: accForm.instanceToken, actionId: action, rowId: row.id, ids: [row.id],
  })
  const openedCmds = cmdsOf(opened)
  const form = lastForm(openedCmds, 'ui/ui/statements/print')
    || lastForm(openedCmds, 'ui/ui/statements/print/partner')
    || [...openedCmds].reverse().find(c => c.command === 'formInit' && /statements\/print/.test(c.instanceName || ''))
  if (!form) {
    const e = errorOf(openedCmds)
    throw new Error(e ? msgOf(e) : 'банк не открыл окно печати выписки')
  }
  const FORM = form.instanceName
  let token = form.instanceToken

  // 3. Счета — через окно выбора, иначе «Счета не заданы»
  if (row.account) {
    const sel = await bankApi(p, 'PUT', `/api/v1/${FORM}/doAction`, { instanceToken: token, actionId: 'selectAccounts' })
    const selCmds = cmdsOf(sel)
    const selForm = lastForm(selCmds, 'ui/account/accountsSelector')
    if (selForm) {
      const pick = (selForm.fields?.accounts?.items || [])
        .find(x => String(x.account || '').replace(/\s/g, '') === String(row.account).replace(/\s/g, ''))
      if (pick) {
        const marked = await bankApi(p, 'PUT', '/api/v1/ui/account/accountsSelector/stateUpdate', {
          instanceToken: selForm.instanceToken, submitField: 'accounts', fields: { accounts: { value: [pick.id] } },
        })
        const stok = tokenOf(cmdsOf(marked), 'ui/account/accountsSelector', selForm.instanceToken)
        const done = await bankApi(p, 'PUT', '/api/v1/ui/account/accountsSelector/doAction', {
          instanceToken: stok, actionId: 'select',
        })
        token = tokenOf(cmdsOf(done), FORM, token)
      } else {
        log('счёт не найден в окне выбора:', row.account)
      }
    }
  }

  // 3а. Контрагент — обязателен для выписки по контрагенту: без него банк
  // строит пустой отчёт и файла не отдаёт вовсе. Ищем по ИНН, счёту или
  // части названия — приложение передаёт то, что у него есть.
  if (by === 'contractor') {
    if (!partner) throw new Error('для выписки по контрагенту нужно выбрать контрагента')
    const sp = await bankApi(p, 'PUT', `/api/v1/${FORM}/doAction`, { instanceToken: token, actionId: 'selectPartner' })
    const picker = lastForm(cmdsOf(sp), 'ui/partner/selector')
    if (!picker) throw new Error('банк не открыл список контрагентов')
    const norm = (s) => String(s || '').replace(/\s/g, '').toLowerCase()
    const key = norm(partner)
    const list = picker.fields?.partners?.items || []
    const hit = list.find(x => norm(x.inn) === key || norm(x.account) === key)
      || list.find(x => norm(x.name).includes(key))
    if (!hit) throw new Error(`контрагент «${partner}» не найден в справочнике банка`)
    const marked = await bankApi(p, 'PUT', '/api/v1/ui/partner/selector/stateUpdate', {
      instanceToken: picker.instanceToken, submitField: 'partners', fields: { partners: { value: [hit.id] } },
    })
    const ptok = tokenOf(cmdsOf(marked), 'ui/partner/selector', picker.instanceToken)
    const done = await bankApi(p, 'PUT', '/api/v1/ui/partner/selector/doAction', { instanceToken: ptok, actionId: 'ok' })
    token = tokenOf(cmdsOf(done), FORM, token)
    log('контрагент:', hit.name, hit.inn)
  }

  // 4. Параметры отчёта — по одному полю за запрос
  const setField = async (id, value) => {
    const r = await bankApi(p, 'PUT', `/api/v1/${FORM}/stateUpdate`, {
      instanceToken: token, submitField: id, fields: { [id]: { value } },
    })
    token = tokenOf(cmdsOf(r), FORM, token)
  }
  if (dateFrom || dateTo) {
    await setField('datePeriod', 'period')
    if (dateFrom) await setField('fromDate', dateFrom)
    if (dateTo) await setField('toDate', dateTo)
  }
  const bankForm = STMT_FORMS[String(reportForm)] || 'form1'
  await setField('reportForm', bankForm)
  await setField('reportFormat', STMT_FORMATS[String(format).toLowerCase()] || 'pdf')

  // 5. Построение отчёта
  let cmds = cmdsOf(await bankApi(p, 'PUT', `/api/v1/${FORM}/doAction`, { instanceToken: token, actionId: 'print_report' }))

  // Банк может спросить, строить ли отчёт при неполных данных за период.
  // Отвечаем «да» только на этот вопрос — он про построение отчёта, а не про
  // заказ выписок, и печать ничего в банке не создаёт. Текст пишем в журнал.
  for (let i = 0; i < 2; i++) {
    const dlg = dialogOf(cmds)
    if (!dlg) break
    const question = msgOf(dlg)
    if (!/продолжить построение/i.test(question)) {
      log('банк задал неожиданный вопрос, не отвечаю:', question)
      throw new Error(question || 'банк запросил подтверждение, которого мы не ожидали')
    }
    log('банк:', question)
    cmds = cmdsOf(await bankApi(p, 'PUT', `/api/v1/${dlg.instanceName}/doAction`, {
      instanceToken: dlg.instanceToken, actionId: '_yes',
    }))
  }

  const err = errorOf(cmds)
  if (err) throw new Error(msgOf(err) || 'банк не построил выписку')

  const file = cmds.find(c => c.command === 'fileDownload' && c.fileId)
  if (!file) {
    // Банк объясняет отказ информационным окном (например, «выписок за часть
    // периода не найдено, запросите выписки и повторите печать»). Показываем
    // его текст: он говорит человеку, что делать, а «файла нет» — не говорит.
    const inform = cmds.find(c => /informDialog/.test(c.instanceName || ''))
    if (inform && msgOf(inform)) throw new Error(msgOf(inform))
    throw new Error('банк не вернул файл выписки')
  }

  // 6. Забираем файл
  const got = await bankFile(p, file.fileId)
  const fallbackName = `Выписка_${dateFrom || ''}_${dateTo || ''}.${format === 'xls' ? 'xls' : 'pdf'}`
  const filename = file.fileName || got.name || fallbackName
  log('файл получен:', filename, got.buffer.length, 'байт')

  const mimeTypes = {
    pdf: 'application/pdf',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return {
    buffer: got.buffer,
    filename,
    mimeType: got.contentType || mimeTypes[String(format).toLowerCase()] || 'application/octet-stream',
  }
}

// Реальные тарифы/лимиты: открываем экран «Продукты → Тарифы» и вынимаем поля label→value.
// Перевод между своими счетами. sign=false → только черновик (деньги не уходят);
// sign=true → «Подписать и отправить» (PayControl-пуш, деньги уходят после подтверждения на телефоне).
// Реальный маппинг прозвище↔номер (счета ИП Попенкова)
const OWN_ACCOUNTS = {
  '40802810600000018205': 'ГО',
  '40802810520000018686': 'корп.карта',
  '40802810309500000228': 'р/с Ставрополь',
}
async function transferOwn(username, password, { fromAccount, toAccount, amount, purpose = '', sign = false }) {
  const p = await ensureLoggedIn(username, password)
  const log = (...a) => console.log('[transfer]', ...a)
  // счёт может прийти номером ИЛИ прозвищем — нормализуем к прозвищу (форма показывает прозвища)
  const toAlias = (x) => OWN_ACCOUNTS[x] || x
  const fromAliasName = toAlias(fromAccount)
  const toAliasName = toAlias(toAccount)
  // Окно обязательного письма прячем, а не подтверждаем: подтверждение
  // ознакомления — действие клиента, а не сервиса.
  const dismiss = async () => { try { await p.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){ m.setAttribute('data-pva-hidden','1'); m.style.display='none' } }) } catch {} }

  await p.waitForTimeout(500); await dismiss()

  // 1) навигация к форме перевода между своими счетами
  for (const label of ['Оплатить', 'Создать', 'Перевод между своими счетами', 'Между своими счетами', 'Перевод между счетами']) {
    try { await dismiss(); await p.click(`text=${label}`, { timeout: 2500 }); await p.waitForTimeout(2000); log('clicked', label) } catch {}
  }
  await p.waitForTimeout(1500); await dismiss()

  const title = await p.title().catch(()=> '')
  log('form title:', title)

  // 2) выбрать счёт по ПРОЗВИЩУ (форма показывает «ГО – 151.09 ₽» и т.п.).
  //    Открываем дропдаун JS-кликом (в обход перехвата span'ом), опцию тоже кликаем JS.
  const pickAccount = async (fieldName, alias) => {
    try {
      // force-клик открывает дропдаун (в обход перехвата наложенным span'ом)
      await p.click(`[name="${fieldName}"]`, { force: true, timeout: 5000 })
      await p.waitForTimeout(1300)
      const res = await p.evaluate((al) => {
        const els = Array.from(document.querySelectorAll('[role="option"],li,[class*="option"],[class*="item"],div,span'))
        const norm = e => (e.textContent || '').replace(/\s+/g, ' ').trim()
        const el = els.find(e => { const t = norm(e); return t.length < 120 && t.startsWith(al) })
        if (el) { el.click(); return { picked: norm(el).slice(0, 60) } }
        // debug: собрать похожие на счета опции
        const opts = [...new Set(els.map(norm).filter(t => t && t.length < 120 && /₽|р\/с|ГО|корп|счет|ЦЕНТР/i.test(t)))].slice(0, 12)
        return { picked: null, opts }
      }, alias)
      const ok = !!res.picked
      log('pick', fieldName, alias, '->', res.picked || ('NULL; opts=' + JSON.stringify(res.opts)))
      if (!ok) { await p.keyboard.press('Escape').catch(() => {}) }
      await p.waitForTimeout(900)
      return !!ok
    } catch (e) { log('pick fail', fieldName, e.message); return false }
  }

  await pickAccount('payerAccount', fromAliasName)
  await pickAccount('receiverAccount', toAliasName)

  // 3) сумма + назначение (обычные инпуты)
  const fill = async (name, val) => {
    try { await p.fill(`[name="${name}"]`, String(val), { timeout: 4000 }); log('filled', name, val) }
    catch (e) { log('fill fail', name, e.message) }
  }
  await fill('documentSum', amount)
  if (purpose) await fill('paymentPurpose', purpose)
  await p.waitForTimeout(800)

  // 4) снять состояние формы
  const formState = await p.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s))
    const val = (n) => { const e=document.querySelector(`[name="${n}"]`); return e ? (e.value || e.textContent || '') : null }
    return { payer: val('payerAccount'), receiver: val('receiverAccount'), sum: val('documentSum'), purpose: val('paymentPurpose') }
  })
  log('form state:', JSON.stringify(formState))

  // 5) сохранить черновик или подписать+отправить
  const btnLabel = sign ? 'Подписать и отправить' : 'Сохранить'
  let clicked = null
  try {
    clicked = await p.evaluate((lbl) => {
      const bs = Array.from(document.querySelectorAll('button,[role="button"],a'))
      const b = bs.find(x => (x.textContent||'').trim().toLowerCase() === lbl.toLowerCase())
        || bs.find(x => (x.textContent||'').trim().toLowerCase().includes(lbl.toLowerCase()))
      if (b) { b.click(); return (b.textContent||'').trim() }
      return null
    }, btnLabel)
    log('action button:', clicked)
  } catch (e) { log('action fail', e.message) }
  await p.waitForTimeout(sign ? 6000 : 3000)
  await dismiss()

  // 6) результат (текст экрана — статус/ошибка/запрос PayControl)
  const result = await p.evaluate(() => (document.body.innerText || '').replace(/\s+/g,' ').slice(0, 1200))

  // Честная оценка успеха. Форма-кликер иногда не выбирает счёт получателя
  // (receiver пустой), и банк показывает «Результаты проверки / Не указан счёт» —
  // раньше это уходило в приложение как успех. Теперь такое считаем провалом.
  const receiverEmpty = !formState.receiver
  const validationScreen = /результаты проверки|не указан счёт|не указан счет|не заполн|исправьте|обнаружены ошибки/i.test(result)
  const ok = !!clicked && !receiverEmpty && !validationScreen

  let error = ''
  if (!clicked) error = 'Не удалось найти кнопку подтверждения в форме банка'
  else if (receiverEmpty) error = 'Банк не принял счёт зачисления — перевод не отправлен'
  else if (validationScreen) error = 'Банк вернул ошибки проверки — перевод не отправлен'

  return { ok, error, formState, actionClicked: clicked, signed: !!sign, screen: result }
}

let cachedTariffs = []
async function getTariffs(username, password) {
  const p = await ensureLoggedIn(username, password)
  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!(u.includes('/api/v1/execution') || u.includes('/api/v1/menu/click')) || r.status() !== 200) return
      const ct = r.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const b = await r.text()
      if (b.length > 100) bodies.push(b)
    } catch {}
  }
  p.on('response', onResp)   // слушатель ДО навигации

  const dismiss = async () => {
    try {
      await p.evaluate((() => {
        // Окно обязательного письма НЕ подтверждаем: нажатие кнопки в нём
        // означает «ознакомлен» от имени клиента. Просто убираем его с экрана,
        // чтобы не мешало навигации; подтверждение делает человек в приложении.
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) { m.setAttribute('data-pva-hidden', '1'); m.style.display = 'none' }
      }))
    } catch {}
  }

  await p.waitForTimeout(1500)
  await dismiss()

  // Пройти к экрану тарифов прямо с текущего (post-login) экрана
  for (const label of ['Продукты и услуги', 'Продукты', 'Тарифы и лимиты', 'Тарифы',
    'Посмотреть подключенный тариф', 'Перейти в тарифы', 'Установка/Изменение лимитов', 'Ещё']) {
    try {
      await dismiss()
      await p.click(`text=${label}`, { timeout: 2500 })
      await p.waitForTimeout(2500)
      console.log('[tariffs] clicked', label)
    } catch {}
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  // Извлечь тарифные поля
  const re = /(плата за|тариф|овердрафт|лимит|комисс|СБП)/i
  const items = []
  const seen = new Set()
  const walk = (n) => {
    if (n && typeof n === 'object') {
      if (!Array.isArray(n)) {
        const l = n.label, v = n.value
        if (typeof l === 'string' && typeof v === 'string' && v.trim() && re.test(l) && !seen.has(l.trim())) {
          seen.add(l.trim())
          items.push({ label: l.trim(), value: v.trim() })
        }
        for (const k of Object.keys(n)) walk(n[k])
      } else {
        for (const x of n) walk(x)
      }
    }
  }
  for (const b of bodies) { try { walk(JSON.parse(b)) } catch {} }
  console.log('[tariffs] parsed', items.length, 'fields from', bodies.length, 'execution responses')
  // кэшируем последний удачный (тарифы стабильны); при слабом результате отдаём кэш
  if (items.length >= 3) { cachedTariffs = items; return items }
  return cachedTariffs.length ? cachedTariffs : items
}

// ─── Разделы ДБО ────────────────────────────────────────────────────────────
// Обобщение приёма, на котором работают тарифы: слушаем JSON банка, проходим
// по пунктам меню раздела и вытаскиваем пары «подпись — значение» + строки таблиц.
// Так один механизм закрывает кредиты, депозиты, эквайринг, АУСН и т.п.
// Разделы, которые в новом интерфейсе банка реально открываются и отдают данные.
// Проверено на живом ДБО 07.08.2026: остальные пункты меню (АУСН, бонус за
// партнёра, сервисы, прочие продукты, массовые платежи, счета на оплату,
// запросы выписок) не открываются вовсе — банк уводит их в стандартный
// интерфейс, и приложение показывало пустые экраны. Держать их в списке
// значит обещать то, чего нет.
const DBO_SECTIONS = {
  credits:    { title: 'Мои кредиты',        labels: ['Мои кредиты', 'Кредиты'] },
  deposits:   { title: 'Мои депозиты',       labels: ['Мои депозиты', 'Депозиты'] },
  acquiring:  { title: 'Эквайринг',          labels: ['Эквайринг'] },
  salary:     { title: 'Зарплатный проект',  labels: ['Зарплатный проект', 'Зарплатный'] },
  documents:  { title: 'Мои документы',      labels: ['Мои документы', 'Документы'] },
}

const sectionCache = {}

async function getSectionData(username, password, key) {
  const section = DBO_SECTIONS[key]
  if (!section) throw new Error('Неизвестный раздел: ' + key)

  const p = await ensureLoggedIn(username, password)
  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!(u.includes('/api/v1/execution') || u.includes('/api/v1/menu/click')) || r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const b = await r.text()
      if (b.length > 100) bodies.push(b)
    } catch {}
  }
  p.on('response', onResp)

  const dismiss = async () => {
    try {
      await p.evaluate((() => {
        // Окно обязательного письма НЕ подтверждаем: нажатие кнопки в нём
        // означает «ознакомлен» от имени клиента. Просто убираем его с экрана,
        // чтобы не мешало навигации; подтверждение делает человек в приложении.
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) { m.setAttribute('data-pva-hidden', '1'); m.style.display = 'none' }
      }))
    } catch {}
  }

  await p.waitForTimeout(1200)
  await dismiss()

  let navigated = false
  for (const label of section.labels) {
    try {
      await dismiss()
      // .first(): «Платежи» встречается и в меню, и во вкладках — строгий режим
      // Playwright отказывался кликать по нескольким совпадениям, и переход не шёл
      await p.locator(`text=${label}`).first().click({ timeout: 6000 })
      await p.waitForTimeout(2500)
      navigated = true
      console.log(`[section:${key}] clicked`, label)
      break
    } catch {}
  }
  await p.waitForTimeout(1200)
  p.off('response', onResp)

  // Собираем все пары label/value — какие именно поля отдаёт раздел, заранее неизвестно
  const fields = []
  const seen = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const l = n.label, v = n.value
    if (typeof l === 'string' && l.trim() && (typeof v === 'string' || typeof v === 'number')) {
      const val = String(v).trim()
      const kk = l.trim() + '=' + val
      if (val && !seen.has(kk)) { seen.add(kk); fields.push({ label: l.trim(), value: val }) }
    }
    Object.keys(n).forEach(k => walk(n[k]))
  }
  for (const b of bodies) { try { walk(JSON.parse(b)) } catch {} }

  // Содержимое раздела лежит в таблицах, а не в парах «подпись — значение»:
  // без этого кредиты и депозиты возвращали только фильтры вроде «Статус = all».
  const rows = []
  const collectRows = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collectRows); return }

    if (Array.isArray(node.items) && node.items.length > 0 && rows.length < 60) {
      for (const it of node.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) continue
        // Оставляем только простые значения: вложенные структуры не нужны
        const row = {}
        for (const [k, v] of Object.entries(it)) {
          const val = (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
          if (val === null || val === undefined) continue
          if (typeof val === 'object') continue
          if (String(val).trim() === '') continue
          row[k] = val
        }
        // Пункты меню приходят такими же массивами items, как и данные.
        // Отличаем по набору полей: у навигации кроме id/label/parentId
        // ничего нет — показывать её как содержимое раздела нельзя.
        const keys = Object.keys(row)
        const MENU_KEYS = new Set(['id', 'label', 'visible', 'parentId', 'icon', 'selected', 'expanded'])
        const isMenuEntry = keys.every(k => MENU_KEYS.has(k))
        if (isMenuEntry) continue

        if (keys.length >= 2 && rows.length < 60) rows.push(row)
      }
    }
    Object.values(node).forEach(collectRows)
  }
  for (const b of bodies) { try { collectRows(JSON.parse(b)) } catch {} }

  // Текст экрана — чтобы показать раздел, даже если структурных полей банк не дал
  const screenText = await p.evaluate(() => (document.body.innerText || '').slice(0, 4000)).catch(() => '')

  const result = {
    key,
    title: section.title,
    navigated,
    fields,
    rows,
    screenText,
    responses: bodies.length,
  }

  // Кэшируем последний непустой результат: разделы меняются редко,
  // а навигация по DOM банка иногда не срабатывает с первого раза
  if (fields.length > 0 || rows.length > 0 || screenText.length > 200) sectionCache[key] = result
  return sectionCache[key] || result
}

/** Запрос к API банка из уже открытой сессии — без повторного входа. */
/**
 * ─── УНИВЕРСАЛЬНЫЙ СЛОЙ ДОКУМЕНТОВ ─────────────────────────────────────────
 *
 * У банка около 30 типов документов (рублёвые платёжки, валютные переводы,
 * СБП, письма, заявки) и все они живут по ОДНОМУ контракту — так устроен его
 * собственный фронт: useCreateOrEditDoc, useServerValidate, useSignWithConfirmation,
 * useSendWithConfirmation работают с любым модулем через параметр `module`.
 *
 * Значит и нам не нужно писать реализацию под каждый тип. Один набор функций
 * с параметром модуля закрывает их все:
 *
 *   GET  {module}/list?_offset=&_limit=   — список документов
 *   GET  {module}/{id}                    — один документ
 *   POST {module}                         — создать (вернёт id)
 *   PUT  {module}/{id}                    — изменить
 *   POST {module}/validate/tree           — серверные контроли
 *   POST {module}/getUserCryptoProfiles   — средства подписи
 *   POST {module}/prepareSign             — начать подпись
 *   POST {module}/continueSign            — завершить подпись
 *   POST {module}/send                    — отправить в банк
 *   GET  {module}/canDoAction/{id}?...    — доступно ли действие
 *
 * Дальше остаётся только знать МОДЕЛЬ каждого документа — набор полей.
 */

/**
 * Печатная форма документа с отметкой банка.
 *
 * GET {module}/{id}/print?disposition=&format= — банк отдаёт готовый файл.
 * Именно такую платёжку просят контрагенты и налоговая, и сделать её самим
 * нельзя: отметку об исполнении ставит банк.
 *
 * Файл двоичный, а обычный bankApi разбирает ответ как JSON. Поэтому читаем
 * содержимое внутри страницы и переносим наружу строкой base64 — иначе байты
 * портятся при переходе из браузера в Node.
 */
async function getDocumentPrint(username, password, { id, module = SIGN_MODULE, format = 'PDF' }) {
  if (!id) throw new Error('не передан id документа')
  const p = await ensureLoggedIn(username, password)
  if (!sessionAuthToken) throw new Error('токен сессии банка не пойман')

  const path = `/api/v1/${module}/${encodeURIComponent(id)}/print`
    + `?disposition=download&format=${encodeURIComponent(format)}`

  const res = await p.evaluate(async ([u, t]) => {
    const r = await fetch('https://dbo.centrinvest.ru' + u, {
      method: 'GET',
      headers: { authToken: t, 'Cache-Control': 'private, max-age=0' },
      credentials: 'include',
    })
    if (!r.ok) return { ok: false, status: r.status }
    const buf = new Uint8Array(await r.arrayBuffer())
    // Побайтно в строку и base64: так двоичные данные переживут переход
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    return {
      ok: true,
      status: r.status,
      type: r.headers.get('content-type') || 'application/pdf',
      disposition: r.headers.get('content-disposition') || '',
      base64: btoa(bin),
    }
  }, [path, sessionAuthToken])

  if (!res.ok) throw new Error(`банк не отдал печатную форму (код ${res.status})`)
  console.log('[print] документ', String(id).slice(0, 12) + '…', '|', res.type)
  return res
}

/**
 * Поиск по списку: POST {module}/list/search.
 * Правильнее простого GET list — банк сам фильтрует и сортирует, а не мы
 * перебираем сотни записей у себя. Сортировка задаётся строками вида
 * 'docDate-' (минус в конце = по убыванию).
 *
 * Банк отдаёт на одну запись больше запрошенного — так фронт понимает, что
 * есть следующая страница. Лишнюю отрезаем.
 */
async function docSearch(p, module, { filters = {}, limit = 50, offset = 0, sort = [], postfix = '/list' } = {}) {
  const r = await bankApi(p, 'POST', `/api/v1/${module}${postfix}/search`, {
    simpleFilters: filters,
    limit: limit === -1 ? -1 : limit + 1,
    offset,
    sort,
    scrollToId: null,
  })
  const list = r.json?.list || r.json?.data?.list || []
  const hasMore = limit !== -1 && list.length > limit
  return { list: hasMore ? list.slice(0, limit) : list, hasMore }
}

/**
 * Номера счетов → идентификаторы счетов в банке.
 *
 * Список счетов за сессию не меняется, поэтому держим его в памяти:
 * лишний запрос к банку на каждую выписку — это и время, и лимит частоты.
 */
let accountIdCache = null
async function accountIds(p, numbers) {
  const want = numbers.map(n => String(n).replace(/\D/g, '')).filter(Boolean)
  if (!want.length) return []
  if (!accountIdCache) {
    const r = await bankApi(p, 'GET', '/api/v1/client/accounts/list?_offset=0&_limit=50', null)
    const list = r.json?.list || r.json || []
    accountIdCache = new Map(
      (Array.isArray(list) ? list : []).map(a => [String(a.accountNumber || a.number || '').replace(/\D/g, ''), a.id])
    )
  }
  return want.map(n => accountIdCache.get(n)).filter(Boolean)
}

/**
 * Операции по выписке ПО ВСЕМ СЧЕТАМ за период.
 * Отдельный модуль statements/operations — не тот, что doc/statements/byPeriod:
 * последний отдаёт только обороты по счёту (дебет/кредит), без самих операций.
 * Именно поэтому история раньше приходила лишь по одному счёту.
 */
async function getOperations(username, password, { dateFrom, dateTo, accounts, orgId, limit = 200 } = {}) {
  const p = await ensureLoggedIn(username, password)
  const filters = { showActual: true }
  if (dateFrom) filters.dateFrom = dateFrom
  if (dateTo) filters.dateTo = dateTo
  if (orgId) filters.orgId = orgId
  // Фильтр банка ждёт ВНУТРЕННИЕ идентификаторы счетов, а не их номера:
  // на двадцатизначный номер он отвечает 500, поиск падает и выписка молча
  // уходила на медленный обход страниц (проверено на живой сессии 12.08.2026).
  if (accounts && accounts.length) {
    const ids = await accountIds(p, accounts)
    if (ids.length) filters.accounts = ids
    else console.warn('[operations] счёт', accounts.join(','), 'у банка не найден — беру все счета')
  }   // не задан — значит все счета

  // Сортировку делает БАНК: минус в конце имени поля — по убыванию, свежие
  // первыми. Это снимает всю возню с угадыванием смещения: раньше операции
  // тянулись страницами с конца, и при большом объёме окно попадало в
  // середину истории — в приложении висел прошлогодний период.
  // Поиск операций выписки лежит прямо по {module}/search, без /list.
  const { list } = await docSearch(p, 'statements/operations', {
    filters, limit, postfix: '',
    sort: ['operationDate-', 'documentNumber-', 'id-'],
  })
  console.log('[operations] получено операций:', list.length)
  if (list[0]) console.log('[operations] поля записи:', Object.keys(list[0]).join(', '))

  // Дебет или кредит определяется наличием суммы — так же считает фронт банка
  return list.map(o => {
    const debit = !!o.debet && Number(o.debet) !== 0
    const party = debit ? o.receiver : o.payer
    return {
      id: o.id,
      date: String(o.operationDate || '').slice(0, 10),
      number: String(o.documentNumber ?? '').trim(),
      account: String(o.accountName ?? '').trim(),
      purpose: String(o.paymentPurpose ?? '').trim(),
      amount: debit ? -Math.abs(Number(o.debet) || 0) : Math.abs(Number(o.credit) || 0),
      direction: debit ? 'out' : 'in',
      currency: o.payerCurrIsoCode || o.receiverCurrIsoCode || 'RUR',
      counterparty: {
        name: String(party?.name ?? '').trim(),
        inn: party?.inn || '',
        account: party?.account || '',
        bank: party?.bankName || '',
        bic: party?.bankBic || '',
      },
      status: 'Исполнен',
    }
  })
}

// ─── ПИСЬМА В БАНК ──────────────────────────────────────────────────────────
// У банка асимметрия в путях, и её легко перепутать: множественное
// `messages/*` — для списков и массовых действий, `doc/messages/*` — для
// операций над одним письмом.
const MAIL_LIST = { in: 'messages/incoming', out: 'messages/outgoing' }
const MAIL_DOC  = { in: 'doc/messages/incoming', out: 'doc/messages/outgoing' }

/** Список писем. box: 'in' — входящие, 'out' — исходящие. */
async function getMail(username, password, { box = 'in', limit = 50, offset = 0, search } = {}) {
  const p = await ensureLoggedIn(username, password)
  const filters = {}
  if (search) filters.textToSearch = search
  if (box === 'out') filters.showOutgoing = true

  const { list, hasMore } = await docSearch(p, MAIL_LIST[box], {
    filters, limit, offset,
    sort: ['docDate-', 'lastChangeStateDate-'],
  })
  console.log(`[mail] ${box === 'in' ? 'входящих' : 'исходящих'} писем:`, list.length)

  return {
    hasMore,
    items: list.map(m => ({
      id: m.id,
      date: String(m.docDate || '').slice(0, 10),
      subject: String(m.title ?? '').trim() || 'Без темы',
      preview: String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      read: !!m.read,
      hasAttaches: !!m.hasAttaches,
      from: String(m.from ?? m.branchName ?? '').trim(),
      status: String(m.clientState ?? '').trim(),
      type: m.type,
    })),
  }
}

/** Одно письмо целиком, вместе с вложениями. */
async function getMailItem(username, password, { box = 'in', id }) {
  const p = await ensureLoggedIn(username, password)
  const m = await docGet(p, MAIL_DOC[box], id)
  return {
    id: m?.id,
    date: String(m?.docDate || '').slice(0, 10),
    subject: String(m?.title ?? '').trim() || 'Без темы',
    text: String(m?.text ?? ''),
    from: String(m?.from ?? m?.branchName ?? '').trim(),
    read: !!m?.read,
    status: String(m?.clientState ?? '').trim(),
    attaches: (m?.attaches || []).map(a => ({ id: a.id, name: a.name, size: a.size })),
    bankInfo: m?.bankInfo || undefined,
  }
}

/** Отметить письмо прочитанным (или снять отметку). */
async function markMailRead(username, password, { box = 'in', id, read = true }) {
  const p = await ensureLoggedIn(username, password)
  await bankApi(p, 'PUT', `/api/v1/${MAIL_DOC[box]}/${encodeURIComponent(id)}/toggleRead`, { read })
  return { ok: true, read }
}

/** Счётчики: непрочитанные входящие и исходящие, ожидающие подписи. */
async function getMailCounters(username, password, { orgId } = {}) {
  const p = await ensureLoggedIn(username, password)
  // Банк отдаёт массив пар «имя счётчика — значение»; сворачиваем в объект
  // Банк отдаёт счётчики в двух видах: массивом пар {name, value} либо ОДНОЙ
  // такой парой. Второй случай я пропустил — и в приложение уходило имя
  // счётчика вместо числа («income» вместо 3).
  const toCount = (json) => {
    const raw = json?.data ?? json
    if (Array.isArray(raw)) {
      return raw.reduce((acc, x) => ({ ...acc, [x.name]: Number(x.value) || 0 }), {})
    }
    if (raw && typeof raw === 'object') {
      if ('name' in raw && 'value' in raw) return { [raw.name]: Number(raw.value) || 0 }
      // Уже готовый объект вида {income: 3} — оставляем только числа
      return Object.fromEntries(
        Object.entries(raw)
          .filter(([, v]) => v !== null && v !== '' && !Number.isNaN(Number(v)))
          .map(([k, v]) => [k, Number(v)]))
    }
    return {}
  }
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}&currControlMessages=false` : '?currControlMessages=false'
  const [inc, out] = await Promise.all([
    bankApi(p, 'GET', `/api/v1/doc/messages/incoming/unreadCount${qs}`, null).catch(() => ({})),
    bankApi(p, 'GET', `/api/v1/doc/messages/outgoing/unreadSignCount${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`, null).catch(() => ({})),
  ])
  const incoming = toCount(inc.json)
  const outgoing = toCount(out.json)
  const unread = incoming.income ?? Object.values(incoming)[0] ?? 0
  const forSign = Object.values(outgoing)[0] ?? 0
  console.log('[mail] непрочитанных:', unread, '| на подпись:', forSign)
  return { unread, forSign, news: incoming.news ?? 0 }
}

/**
 * Удалить документы. Банк принимает список, поэтому годится и для одной
 * платёжки, и для чистки накопившихся черновиков.
 *
 * ПРЕДОХРАНИТЕЛЬ: удаляем только то, что банк сам разрешает удалить
 * (canDoAction '_delete'). Исполненный или отправленный документ так не
 * пропадёт — банк откажет, а мы скажем об этом честно, а не промолчим.
 */
async function deleteDocuments(username, password, { ids, module = SIGN_MODULE }) {
  if (!ids || !ids.length) throw new Error('не переданы документы')
  const p = await ensureLoggedIn(username, password)

  const allowed = []
  const refused = []
  for (const id of ids) {
    try {
      if (await docCanDo(p, module, id, '_delete')) allowed.push(String(id))
      else refused.push(String(id))
    } catch {
      refused.push(String(id))
    }
  }
  if (!allowed.length) {
    return { ok: false, deleted: 0, refused: refused.length,
      error: 'Банк не разрешает удалить эти документы — вероятно, они уже отправлены' }
  }

  const r = await bankApi(p, 'PUT', `/api/v1/${module}/list/delete`, { ids: allowed })
  const d = r.json?.data || r.json
  console.log('[delete] удалено:', allowed.length, '| отказано:', refused.length,
    '| ответ:', JSON.stringify(d).slice(0, 200))
  return { ok: true, deleted: allowed.length, refused: refused.length, raw: d }
}

/**
 * Полные реквизиты счёта — чтобы отправить контрагенту одним сообщением.
 *
 * Сам счёт знает название банка и БИК, но не корсчёт и не ИНН организации.
 * Корсчёт добираем из справочника банков по БИК, ИНН — из данных организации.
 * Без них платёжку не заполнить, а именно за этим реквизиты и просят.
 */
async function getRequisites(username, password, { account } = {}) {
  const p = await ensureLoggedIn(username, password)
  const norm = x => String(x || '').replace(/\D/g, '')

  const r = await bankApi(p, 'GET', '/api/v1/client/accounts/list?_limit=50', null)
  const list = r.json?.list || r.json?.data?.list || []
  const acc = account
    ? list.find(a => norm(a.number) === norm(account))
    : list[0]
  if (!acc) throw new Error('счёт не найден')

  const bic = String(acc.bankRequisites?.bankBic || '')

  // Корсчёт лежит в справочнике банков
  let corrAccount = ''
  try {
    const b = await bankApi(p, 'POST', '/api/v1/client/bics/list/search', {
      filter: { or: [{ op: 'like', column: 'bic', value: `%${bic}%` }] },
      simpleFilters: null, limit: 5,
    })
    const bank = (b.json?.list || []).find(x => String(x.bic) === bic)
    corrAccount = String(bank?.corrAccount || bank?.account || '')
  } catch (e) {
    console.warn('[requisites] корсчёт не получен:', e.message)
  }

  // ИНН организации
  let inn = ''
  try {
    const o = await bankApi(p, 'GET', '/api/v1/sbp/getOrgInfo', null)
    inn = String(o.json?.orgInn || o.json?.data?.orgInn || '')
  } catch { /* без ИНН реквизиты всё равно полезны */ }

  return {
    orgName: String(acc.org?.name || '').trim(),
    inn,
    account: String(acc.number || ''),
    accountName: String(acc.name || '').trim(),
    currency: acc.currIsoCode || 'RUB',
    bankName: String(acc.bankRequisites?.bankName || '').trim(),
    bic,
    corrAccount,
  }
}

/** Справочник контрагентов клиента (client/partners). */
async function getPartners(username, password, { search, limit = 50 } = {}) {
  const p = await ensureLoggedIn(username, password)
  const filters = search ? { filterPartners: search } : {}
  const { list } = await docSearch(p, 'client/partners', { filters, limit, sort: ['name+'] })
  return list.map(x => ({
    id: x.id,
    name: String(x.name ?? '').trim(),
    account: String(x.account ?? '').trim(),
    bic: String(x.bic ?? '').trim(),
    bank: String(x.bankName ?? '').trim(),
    inn: String(x.inn ?? '').trim(),
  }))
}

/**
 * Поиск банка по БИК или названию (client/bics).
 * Банк ищет через фильтр с оператором like сразу по двум колонкам — так же,
 * как это делает подсказка в его собственной форме платежа.
 */
async function getBics(username, password, { query, limit = 10 } = {}) {
  if (!query || String(query).length < 3) return []
  const p = await ensureLoggedIn(username, password)
  const like = `%${query}%`
  const r = await bankApi(p, 'POST', '/api/v1/client/bics/list/search', {
    filter: { or: [
      { op: 'like', column: 'bic', value: like },
      { op: 'like', column: 'name', value: like },
    ] },
    simpleFilters: null,
    limit,
  })
  const list = r.json?.list || r.json?.data?.list || []
  return list.map(x => ({ id: x.id, bic: String(x.bic ?? ''), name: String(x.name ?? '') }))
}

/** Список документов любого типа. */
async function docList(p, module, { offset = 0, limit = 300, params = {} } = {}) {
  const qs = new URLSearchParams({ _offset: String(offset), _limit: String(limit), ...params })
  const r = await bankApi(p, 'GET', `/api/v1/${module}/list?${qs}`, null)
  return r.json?.list || r.json?.data?.list || []
}

/** Один документ целиком. */
async function docGet(p, module, id) {
  const r = await bankApi(p, 'GET', `/api/v1/${module}/${encodeURIComponent(id)}`, null)
  return r.json?.data || r.json
}

/** Серверные контроли. Возвращает список сообщений; пустой — значит чисто. */
async function docValidate(p, module, model) {
  const r = await bankApi(p, 'POST', `/api/v1/${module}/validate/tree`, model)
  const d = r.json?.data || r.json
  const messages = d?.messages || d?.controls || d?.errors || []
  return { ok: !messages.some(m => /error|критич/i.test(m?.type || m?.level || '')), messages, raw: d }
}

/**
 * Создать или изменить документ. Банк отвечает {result:true, id}.
 * Именно так делает его фронт (useCreateOrEditDoc): POST на модуль для
 * создания, PUT на модуль/id для правки.
 */
async function docSave(p, module, model, id) {
  const r = id
    ? await bankApi(p, 'PUT', `/api/v1/${module}/${encodeURIComponent(id)}`, { ...model, docId: id })
    : await bankApi(p, 'POST', `/api/v1/${module}`, model)
  const d = r.json?.data || r.json
  if (!d?.result || !(d.id || id)) {
    const msg = d?.outputMessages?.[0]?.message || d?.message || 'банк не сохранил документ'
    throw new Error(msg)
  }
  return { id: d.id || id, state: d.state, raw: d }
}

/** Отправить документы в банк. */
async function docSend(p, module, ids, confirmTransactionId) {
  const r = await bankApi(p, 'POST', `/api/v1/${module}/send`, {
    ids: ids.map(String), confirmTransactionId, userWorkspace: {},
  })
  const d = r.json?.data || r.json
  const results = d?.results || []
  return {
    ok: results.some(e => e.result === 'success'),
    error: results[0]?.message,
    results,
  }
}

/** Доступно ли действие над документом (_sign, _send, _delete и т.п.). */
async function docCanDo(p, module, id, action) {
  const r = await bankApi(p, 'GET',
    `/api/v1/${module}/canDoAction/${encodeURIComponent(id)}?action=${encodeURIComponent(action)}`, null)
  const d = r.json?.data || r.json
  return !!d?.result
}

async function bankApiRaw(p, method, path, body) {
  if (!sessionAuthToken) throw new Error('токен сессии банка не пойман')
  return p.evaluate(async ([m, u, b, t]) => {
    const res = await fetch('https://dbo.centrinvest.ru' + u, {
      method: m,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', authToken: t, Accept: 'application/json, text/plain, */*' },
      body: b ? JSON.stringify(b) : undefined,
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }, [method, path, body, sessionAuthToken])
}

/**
 * Тот же вызов, но с разбором «залипших» окон банка.
 *
 * Банк — это интерфейс с состоянием: незакрытая форма держит всю сессию.
 * Если человек начал платёж и ушёл, на следующий переход банк отвечает не
 * разделом, а вопросом «Сохранить изменения?» — и так до ответа. В этом
 * состоянии не открывается НИЧЕГО: ни выписка, ни эквайринг, ни разделы,
 * а приложение показывало «банк не открыл раздел» (проверено 11.08.2026).
 *
 * Отвечаем «Не сохранять»: это отказ от брошенного черновика, он ничего
 * не создаёт в банке. «Сохранить» создало бы документ без решения человека —
 * так делать нельзя.
 */
async function bankApi(p, method, path, body) {
  let r = await bankApiRaw(p, method, path, body)
  for (let i = 0; i < 2; i++) {
    const cmds = r.json?.commands || []
    const dlg = cmds.find(c => /yesnocancelDialog/.test(c.instanceName || ''))
    if (!dlg || !dlg.instanceToken) break
    const q = String(dlg.fields?.message?.value || '')
    if (!/сохранить изменения/i.test(q)) break
    console.log('[bank] висело окно «' + q + '» — отвечаю «Не сохранять»')
    await bankApiRaw(p, 'PUT', `/api/v1/${dlg.instanceName}/doAction`, {
      instanceToken: dlg.instanceToken, actionId: '_no',
    })
    r = await bankApiRaw(p, method, path, body)   // повторяем исходный запрос
  }
  return r
}

/**
 * Мост к REST-API банка (/api/v1/...) из открытой сессии.
 *
 * У ДБО есть полноценный API d2sme — тот же, которым пользуется веб-версия.
 * Скрейпинг страниц нужен был только потому, что этот API не был доступен
 * снаружи. Мост открывает его вызывающей стороне: приложение делает те же
 * запросы, что и веб-интерфейс, вместо разбора HTML.
 *
 * Возвращает {status, json} как есть, без интерпретации.
 */
async function callBankApi(username, password, { method = 'GET', path, body = null }) {
  if (!path || !path.startsWith('/api/v1/')) {
    throw new Error('путь должен начинаться с /api/v1/')
  }
  const p = await ensureLoggedIn(username, password)
  await waitForAppReady(p, 45000)
  return bankApi(p, String(method).toUpperCase(), path, body)
}

/**
 * Названия счетов («ГО», «корп.карта») и остатки по каждому счёту.
 *
 * Страница счетов в новом интерфейсе отдаёт только номера. Форма платежа
 * отдаёт список счетов структурно — берём оттуда, переиспользуя открытую
 * сессию, чтобы не входить в банк второй раз.
 * Только чтение: форма открывается, ничего не сохраняется.
 */
async function getAccountNames(username, password) {
  const p = await ensureLoggedIn(username, password)
  const r = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030contragent' })
  const cmd = (r.json?.commands || []).find(c => (c.instanceName || '').endsWith('/r030contragent'))
  const items = cmd?.fields?.payerAccountId?.items || []
  if (items.length === 0) return []

  console.log('[accountNames] поля счёта:', Object.keys(items[0]).join(', '))
  const digits = (x) => String(x ?? '').replace(/\D/g, '')
  const money = (x) => {
    const n = parseFloat(String(x ?? '').replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  // Имена полей у банка: account, accountName, currentRest, isoCode
  return items.map(i => ({
    number: digits(i.account || i.accountNumber || i.number),
    name: String(i.accountName || i.name || '').trim(),
    balance: money(i.currentRest ?? i.balance ?? i.rest ?? i.availableBalance),
    currency: String(i.isoCode || i.currency || i.currencyCode || '').trim().toUpperCase() || '',
  })).filter(a => a.number.length === 20)
}

/**
 * Документы из структурного интерфейса ДБО.
 *
 * В отличие от разбора текста выписки (getPaymentsData) здесь у каждого документа
 * есть идентификатор банка, настоящий статус, номер и назначение — банк отдаёт
 * платежи отдельными формами на каждый статус: ui/payments/draft, partlySigned,
 * inProcess, completed, canceled.
 *
 * Важно: это исходящие документы клиента. Входящие поступления сюда не попадают —
 * они видны только в выписке.
 *
 * Только чтение: переходы по вкладкам статусов, никаких действий над документами.
 */
// Коды статусов документа из REST payorders/list → русские названия ДБО
const DOC_STATE_NAMES = {
  new: 'Создан',
  signed: 'Подписан',
  partlySigned: 'Частично подписан',
  processed: 'Исполнен',
  inProcess: 'В обработке',
  delivered: 'Доставлен',
  accepted: 'Принят',
  // АБС — учётная система банка. Документ принят к исполнению, но ещё
  // не проведён: показывать его «исполненным» рано.
  acceptedByABS: 'Принят банком',
  sentToABS: 'Передан в банк',
  declinedByBank: 'Отклонён банком',
  declinedByABS: 'Отменён банком',
  invalidSign: 'Ошибка подписи',
  invalidProps: 'Ошибка реквизитов',
  invalid: 'Ошибка контроля',
  rejected: 'Отклонён',
}

const PAYMENT_FORMS = {
  'ui/payments/draft':         { status: 'ЧЕРНОВИК',    tab: 'Черновики' },
  'ui/payments/partlySigned':  { status: 'НА ПОДПИСЬ',  tab: 'На подпись' },
  'ui/payments/inProcess':     { status: 'В ОБРАБОТКЕ', tab: 'В обработке' },
  'ui/payments/canceled':      { status: 'ОТКЛОНЕН',    tab: 'Отклоненные' },
  'ui/payments/completed':     { status: 'ИСПОЛНЕН',    tab: 'Выполненные' },
}

/** Поля сетки приходят то простым значением, то обёрткой {value: …}. */
const fieldValue = (x) => {
  if (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) return x.value
  return x
}

const toAmount = (x) => {
  const raw = String(fieldValue(x) ?? '').replace(/\s/g, '').replace(',', '.')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

async function getDocuments(username, password) {
  const p = await ensureLoggedIn(username, password)

  // ВАЖНО: здесь НЕ перезагружаем страницу. Попытка сбрасывать состояние
  // через goto ломала чтение: SPA не успевала отрисовать вкладки, клики
  // уходили в пустоту и документов приходило ноль. Открытый диалог, если он
  // есть, закрывает dismiss() ниже — этого достаточно.
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился — банк не отдал содержимое страницы')

  // Основной путь: чистый REST-список рублёвых платёжек. Точный эндпоинт и поля
  // подтверждены разведкой: GET /api/v1/doc/rur/payorders/list отдаёт массив
  // документов с id, docNumber, sum, payer, receiver, purpose, state, stateCode,
  // showForSign. Никаких кликов по вкладкам, модалок и парсинга форм.
  try {
    const r = await bankApi(p, 'GET', '/api/v1/doc/rur/payorders/list?_offset=0&_limit=300', null)
    // Массив приходит под ключом list (подтверждено ответом банка)
    const arr = Array.isArray(r.json) ? r.json
      : Array.isArray(r.json?.list) ? r.json.list
      : Array.isArray(r.json?.items) ? r.json.items
      : Array.isArray(r.json?.data) ? r.json.data : null
    if (arr && arr.length > 0) {
      console.log('[documents] REST list: получено', arr.length)
      const name = (o) => typeof o === 'string' ? o : (o?.name || o?.shortName || '')
      return arr.map(it => ({
        id: String(it.id ?? ''),
        number: String(it.docNumber ?? '').trim(),
        account: String(it.payer?.accountNumber ?? it.payer?.account ?? '').replace(/\D/g, ''),
        recipient: name(it.receiver).trim(),
        purpose: String(it.purpose ?? '').trim(),
        amount: -Math.abs(toAmount(it.sum)),
        direction: 'out',
        // Дата документа. Без неё список нечем было упорядочить, и платежи
        // шли вперемешку — в том порядке, в каком их отдал банк.
        // stateChangeDate — запасной вариант для документов без даты создания.
        date: String(it.docDate ?? it.stateChangeDate ?? '').slice(0, 10),
        // Статус — код в поле state; переводим в понятное название.
        // showForSign отмечает документы, ожидающие подписи.
        status: DOC_STATE_NAMES[String(it.state ?? '')] || String(it.state ?? '').trim() || 'НЕИЗВЕСТЕН',
        stateCode: String(it.stateCode ?? '').trim(),
        showForSign: !!it.showForSign,
        showInProcess: !!it.showInProcess,
        actions: [],
      })).filter(d => d.id)
    }
    console.log('[documents] REST list пуст, пробую обход по вкладкам. Ответ:', JSON.stringify(r.json).slice(0, 200))
  } catch (e) {
    console.log('[documents] REST list не удался:', e.message)
  }

  const bodies = []
  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!u.includes('/api/v1')) return
      if (r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const body = await r.text()
      if (body.length > 100) bodies.push(body)
    } catch {}
  }
  p.on('response', onResp)

  // Закрытие модального окна банка («обязательно к прочтению»). Оно перекрывает
  // весь интерфейс: вкладок статусов не видно, клики не проходят, документов ноль.
  // Программный .click() в ZK-виджете не срабатывал — нужен настоящий клик
  // Playwright, поэтому сначала находим кнопку, потом кликаем ею.
  const dismiss = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const info = await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (!m) return null
        const bs = [...m.querySelectorAll('button,[role=button],a')]
          .map(b => (b.textContent || '').trim().slice(0, 30))
          .filter(Boolean)
        return { buttons: bs }
      }).catch(() => null)

      if (!info) return true                       // окна нет — всё чисто
      if (attempt === 0) console.log('[documents] модалка, кнопки:', JSON.stringify(info.buttons))

      let clicked = false
      for (const label of ['Ознакомлен', 'Понятно', 'Закрыть', 'ОК', 'Продолжить', 'Прочитано']) {
        try {
          await p.locator(`[data-at="modal-ui/messages/mustRead"] >> text=${label}`).first().click({ timeout: 2000 })
          clicked = true; break
        } catch {}
      }
      if (!clicked) {
        try {
          await p.locator('[data-at="modal-ui/messages/mustRead"] button').last().click({ timeout: 2000 })
          clicked = true
        } catch {}
      }
      if (!clicked) {
        await p.evaluate(() => {
          document.querySelector('[data-at="modal-ui/messages/mustRead"]')?.remove()
        }).catch(() => {})
      }
      await p.waitForTimeout(1200)
    }
    return true
  }

  // Закрываем окно ДО диагностики и кликов, а не только внутри цикла
  await dismiss()

  // Диагностика: что реально на странице в момент кликов. Логи говорили
  // «вкладок пройдено: 0», хотя вкладки на экране есть — смотрим фактами.
  try {
    const diag = await p.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ')
      const hasDraft = /Черновики/.test(txt)
      // Все элементы, чей собственный текст — «Черновики»
      const els = [...document.querySelectorAll('*')].filter(e => {
        const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        return own === 'Черновики'
      })
      return {
        urlPath: location.pathname,
        текстСодержитЧерновики: hasDraft,
        совпаденийЧерновики: els.length,
        первыйЭлемент: els[0] ? { tag: els[0].tagName, cls: String(els[0].className).slice(0, 60) } : null,
        видимость: els[0] ? (els[0].getBoundingClientRect().width > 0) : null,
        модалка: !!document.querySelector('[data-at="modal-ui/messages/mustRead"]'),
      }
    })
    console.log('[documents] диагностика страницы:', JSON.stringify(diag))
  } catch (e) { console.log('[documents] диагностика не удалась:', e.message) }

  // Открываем платежи и проходим по вкладкам статусов — каждая отдаёт свою форму
  const visited = []
  for (const label of ['Платежи', ...Object.values(PAYMENT_FORMS).map(f => f.tab)]) {
    try {
      await dismiss()
      // .first(): «Платежи» встречается и в меню, и во вкладках — строгий режим
      // Playwright отказывался кликать по нескольким совпадениям, и переход не шёл
      // force: обычный клик упирался в таймаут — от закрытой модалки остаётся
      // невидимая подложка, которая перехватывает нажатия. force пропускает
      // проверки перекрытия. Если и он не проходит — кликаем через DOM
      // (интерфейс на React, обычное событие click он принимает).
      try {
        await p.locator(`text=${label}`).first().click({ timeout: 4000, force: true })
      } catch {
        const ok = await p.evaluate((lbl) => {
          const el = [...document.querySelectorAll('*')].find(e => {
            const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
            return own === lbl
          })
          if (!el) return false
          el.click()
          return true
        }, label)
        if (!ok) throw new Error('элемент не найден в разметке')
      }
      await p.waitForTimeout(2500)
      visited.push(label)
    } catch (e) {
      console.log(`[documents] клик «${label}» не удался:`, String(e.message).split('\n')[0].slice(0, 150))
    }
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  const documents = []
  const seen = new Set()
  const keyShapes = new Set()

  // Банк присылает поля формы то объектом, то массивом изменений, а имена полей
  // у разных вкладок отличаются. Поэтому ищем строки документов по признакам,
  // а не по фиксированному пути.
  const looksLikeDocument = (o) =>
    o && typeof o === 'object' && !Array.isArray(o) &&
    ('id' in o) &&
    ('docNumber' in o || 'documentSum' in o || 'stateName' in o || 'receiverName' in o)

  const pick = (o, ...names) => {
    for (const n of names) {
      const v = fieldValue(o[n])
      if (v !== undefined && v !== null && String(v).trim() !== '') return v
    }
    return ''
  }

  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }

    if (looksLikeDocument(node)) {
      const id = String(fieldValue(node.id) ?? '')
      if (id && !seen.has(id)) {
        seen.add(id)
        keyShapes.add(Object.keys(node).sort().join(','))
        documents.push({
          id,
          number:    String(pick(node, 'docNumber', 'number')).trim(),
          date:      String(pick(node, 'date', 'docDate', 'documentDate')).trim(),
          account:   String(pick(node, 'payerAccount', 'account', 'accountNumber')).replace(/\D/g, ''),
          recipient: String(pick(node, 'receiverName', 'receiver', 'correspondentName', 'payeeName')).trim(),
          purpose:   String(pick(node, 'paymentPurpose', 'purpose', 'description')).trim(),
          // Сумма: у вкладок «Платежи» поле называется summ, у массовых — documentSum.
          // Без summ суммы терялись и весь список приходил с нулями.
          // Знак берём из operationType: CREDIT — поступление, остальное — списание.
          amount:   (String(pick(node, 'operationType')).toUpperCase() === 'CREDIT' ? 1 : -1)
                    * Math.abs(toAmount(pick(node, 'summ', 'documentSum', 'sum', 'amount'))),
          direction: String(pick(node, 'operationType')).toUpperCase() === 'CREDIT' ? 'in' : 'out',
          status:    String(pick(node, 'stateName', 'state', 'statusName')).trim() || 'НЕИЗВЕСТЕН',
          stateCode: String(pick(node, 'stateCode', 'statusCode')).trim(),
          actions:   Array.isArray(node.actions) ? node.actions : Object.keys(node.actions || {}),
        })
      }
    }

    for (const v of Object.values(node)) collect(v)
  }

  for (const body of bodies) {
    try { collect(JSON.parse(body)) } catch {}
  }

  console.log(`[documents] вкладок пройдено: ${visited.length}, документов: ${documents.length}`)
  console.log(`[documents] встреченные наборы полей: ${[...keyShapes].length}`)
  ;[...keyShapes].forEach(s => console.log('  ' + s))
  return documents
}

/**
 * Действие над документом ДБО: подпись, удаление, отправка, снятие подписи.
 *
 * Протокол (пойман в _apiflow.json): форма списка приходит по menu/click с
 * instanceToken и actions; выбор строки и действие идут одним запросом —
 * PUT .../{форма}/doAction { actionId, fields: { payments: { value: id } }, instanceToken }.
 *
 * ПРЕДОХРАНИТЕЛИ:
 *  - _sign/_saveAndSign/_send двигают реальные деньги — вызываются только с confirm:true;
 *  - действие применяется строго к документу с переданным id и проверяется, что он
 *    в форме есть, иначе отказ (не подписать «что подвернулось»);
 *  - разрешено действие, только если банк указал его в actions этого документа/формы.
 */
const DOC_FORMS = {
  draft:        'ui/payments/draft',
  partlySigned: 'ui/payments/partlySigned',
  inProcess:    'ui/payments/inProcess',
}
// Действия, реально двигающие деньги: требуют явного подтверждения владельца
const MONEY_ACTIONS = new Set(['_sign', '_saveAndSign', '_send'])

async function documentAction(username, password, { id, action, confirm = false }) {
  if (!id) throw new Error('не передан id документа')
  if (!action) throw new Error('не передано действие')
  if (MONEY_ACTIONS.has(action) && !confirm) {
    throw new Error(`Действие ${action} двигает деньги и требует подтверждения (confirm:true)`)
  }

  const p = await ensureLoggedIn(username, password)
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился')

  // 1) Находим форму, где лежит документ, и её actions/instanceToken
  const forms = ['draft', 'partlySigned', 'inProcess']
  let target = null
  for (const key of forms) {
    const menuItem = 'corporate-api-menu-small-r020statement'  // раздел платежей
    const r = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem })
    const cmd = (r.json?.commands || []).find(c => c.instanceName === DOC_FORMS[key])
    if (!cmd?.instanceToken) continue
    const items = cmd.fields?.payments?.items || []
    const doc = items.find(it => {
      const v = (it.id && typeof it.id === 'object' && 'value' in it.id) ? it.id.value : it.id
      return String(v) === String(id)
    })
    if (doc) {
      target = { key, form: DOC_FORMS[key], token: cmd.instanceToken, actions: Object.keys(cmd.actions || {}) }
      break
    }
  }
  if (!target) throw new Error('документ не найден среди черновиков/на подпись/в обработке — возможно, уже проведён')

  // 2) Проверяем, что банк вообще разрешает это действие в этой форме
  if (!target.actions.includes(action)) {
    throw new Error(`банк не разрешает ${action} для этого документа (доступно: ${target.actions.join(', ') || 'ничего'})`)
  }

  // 3) Выбор строки + действие одним запросом
  const formSeg = target.form.replace(/^ui\//, '')  // ui/payments/draft → payments/draft
  const res = await bankApi(p, 'PUT', `/api/v1/ui/${formSeg}/doAction`, {
    actionId: action,
    fields: { payments: { value: String(id) } },
    instanceToken: target.token,
  })

  // 4) Разбираем ответ: успех, диалог подтверждения или ошибка
  const cmds = res.json?.commands || []
  const errors = cmds.flatMap(c => Object.entries(c.fields || {}))
    .flatMap(([fid, f]) => (f.errors || []).map(e => `${fid}: ${e.message || e}`))
  const dialog = cmds.find(c => /confirmDialog|sign|otp|sms|certificate|payControl/i.test(c.instanceName || ''))

  return {
    ok: errors.length === 0,
    action,
    form: target.key,
    errors,
    // Если банк ждёт подтверждение подписи (PayControl/SMS) — это отдельный шаг,
    // его владелец делает в своём ДБО
    needsBankConfirm: !!dialog,
    commands: cmds.map(c => c.instanceName).filter(Boolean),
  }
}

// ─── Подпись документа (чистый REST API) ──────────────────────────────────────
// Раньше здесь был хрупкий поток через эмуляцию кликов (doAction+stateUpdate по
// формам ZK). Из исходников фронта банка (bss-front-d2sme) вскрылся настоящий
// REST API подписи — signStart/signSubmitKey ниже используют именно его:
//   POST doc/rur/payorders/prepareSign  → transactionId + серийник токена
//   POST doc/rur/payorders/continueSign → ключ в model.code
// Ключ и подтверждение — только у владельца, подписать за него нельзя by design.

const pendingSigns = new Map()  // id документа → { module, transactionId, serial }

// Ищем в ответе банка форму по фрагменту имени и возвращаем её токен и поля
function findForm(res, namePattern) {
  const cmds = res.json?.commands || []
  return cmds.find(c => namePattern.test(c.instanceName || ''))
}

// Достаём строковое значение поля независимо от обёртки {value}
function fieldVal(f) {
  if (f && typeof f === 'object' && !Array.isArray(f) && 'value' in f) return f.value
  return f
}

/**
 * Перевод между своими счетами через СТРУКТУРНЫЙ API (форма r030accounts).
 * Счета выбираются по идентификатору из списка формы, а не кликом — надёжно.
 * sign=false → черновик (_save, денег не двигает); sign=true → подпись+отправка
 * (_saveAndSign, дальше банк запросит ключ токена и PayControl).
 */
/**
 * ПЛАТЁЖ КОНТРАГЕНТУ.
 *
 * В реальном ДБО это НЕ REST-документ: разведка исходников банка показала, что
 * POST doc/rur/payorders там не вызывается вовсе. Форма живёт на серверном UI
 * (`ui/rur/payment/r030contragent`) и работает так же, как перевод между
 * своими счетами: значения полей уходят отдельными stateUpdate, действие —
 * doAction. Поэтому механика здесь та же, что в transferOwnStructured.
 *
 * Поля получателя ПЛОСКИЕ (receiverName, receiverINN, ...), а не вложенный
 * объект — это отличается от того, как документ выглядит при чтении.
 *
 * Важная особенность: банк сам дозаполняет форму. По БИК он подставляет
 * наименование банка и корсчёт, по ИНН — наименование и КПП получателя.
 * Поэтому эти поля отправляются первыми, отдельными stateUpdate, и только
 * потом сохраняется документ.
 *
 * Всегда сохраняем черновиком (_save). Подпись — отдельным шагом, где человек
 * вводит ключ с токена и подтверждает в PayControl.
 */
async function payContragent(username, password, {
  fromAccount, amount, purpose = '',
  receiverName, receiverInn, receiverKpp = '', receiverAccount, receiverBic,
  vatRule, docNumber = '', docDate = '',
  priority = '', urgent = false, uin = '', reserveField = '',
  saveAsTemplate = false, templateName = '',
}) {
  const p = await ensureLoggedIn(username, password)
  if (!await waitForAppReady(p, 45000)) throw new Error('Интерфейс ДБО не загрузился')

  const norm = x => String(x || '').replace(/\D/g, '')
  const missing = []
  if (!fromAccount) missing.push('счёт списания')
  if (!receiverName) missing.push('наименование получателя')
  if (!receiverAccount) missing.push('счёт получателя')
  if (!receiverBic) missing.push('БИК банка получателя')
  if (!purpose) missing.push('назначение платежа')
  if (!(Number(amount) > 0)) missing.push('сумма')
  if (missing.length) return { ok: false, error: 'Не заполнено: ' + missing.join(', ') }

  // Сбрасываем возможную открытую форму от прошлой попытки
  try {
    await p.goto('https://dbo.centrinvest.ru/api-ui/', { waitUntil: 'commit', timeout: 30000 })
    await waitForAppReady(p, 30000)
  } catch {}

  const r = await bankApi(p, 'POST', '/api/v1/menu/click',
    { menuItem: 'corporate-api-menu-small-r030contragent' })
  let form = (r.json?.commands || []).find(c => /r030contragent/.test(c.instanceName || '') && c.instanceToken)
  if (!form?.instanceToken) throw new Error('форма платежа контрагенту не открылась')
  form = await reopenIfStale(p, 'corporate-api-menu-small-r030contragent', /r030contragent/, form)

  const token = form.instanceToken
  const FORM_PATH = '/api/v1/ui/rur/payment/r030contragent'

  // Счёт списания выбирается по идентификатору из списка формы
  const payerItems = form.fields?.payerAccountId?.items || []
  const payer = payerItems.find(i => norm(i.accountNumber || i.account) === norm(fromAccount))
  if (!payer) {
    return { ok: false, error: 'счёт списания не найден среди ваших счетов' }
  }

  /** Отправить значение поля и дать банку дозаполнить связанные. */
  const setField = async (name, value) => {
    const resp = await bankApi(p, 'PUT', `${FORM_PATH}/stateUpdate`, {
      instanceToken: token,
      rowId: null,
      submitField: name,
      fields: { [name]: { value: String(value) } },
    })
    return resp.json?.commands || []
  }

  await setField('payerAccountId', payer.id)
  // Номер и дата: в форме банка они есть и редактируются. Пустые не трогаем —
  // тогда номер присвоит банк, как и в веб-версии.
  // ВРЕМЕННО: номер, дата и очерёдность не отправляются. Банк отвечал на
  // сохранение отказом формы (500), и пока не доказано, какое именно поле он
  // не принимает, безопаснее оставить его умолчания. Приложение может слать
  // эти значения (старая копия в кэше телефона) — сервис их игнорирует.
  if (docNumber || docDate) console.log('[contragent] номер и дату не отправляю: банк отвечал отказом')
  // Сначала БИК: по нему банк подставит наименование банка и корсчёт
  await setField('receiverBankBic', norm(receiverBic))
  if (receiverInn) await setField('receiverINN', norm(receiverInn))
  await setField('receiverAccount', norm(receiverAccount))
  await setField('receiverName', receiverName)
  if (receiverKpp) await setField('receiverKPP', norm(receiverKpp))
  if (uin) await setField('uip', String(uin))

  // Поля, которые есть в форме банка и раньше терялись: очерёдность (банк по
  // умолчанию ставит 5), срочный платёж, УИН, резервное поле и сохранение
  // платежа в шаблоны. Пустые не трогаем, чтобы не переписывать умолчания банка.
  // Необязательные поля ставим осторожно: банк отвечает на неудачное значение
  // отказом всей формы (500 errorCode), и человек теряет платёж из-за галочки.
  const trySet = async (name, value) => {
    try { await setField(name, value) } catch (e) { console.warn('[поле]', name, 'не принято:', e.message) }
  }
  if (priority) console.log('[contragent] очерёдность не отправляю:', priority)
  if (urgent) await trySet('paymentCodeCheck', true)
  if (reserveField) await trySet('reserv23', String(reserveField))
  if (saveAsTemplate) {
    await trySet('addToTemplates', true)
    if (templateName) await trySet('templateName', String(templateName))
  }

  const fields = {
    documentSum: { value: Number(amount).toFixed(2) },
    paymentPurpose: { value: purpose },
  }
  // Номер и дату банк проставляет сам, но человек вправе их задать — в его
  // форме эти поля есть и редактируются. Пустые не отправляем: банк тогда
  // оставит свою нумерацию.
  if (docNumber) fields.docNumber = { value: String(docNumber) }
  if (docDate) fields.docDate = { value: bankDate(docDate) }
  if (vatRule) fields.vatCalculationRule = { value: vatRule }

  let resp = await bankApi(p, 'PUT', `${FORM_PATH}/doAction`, {
    actionId: '_save', fields, instanceToken: token,
  })
  console.log('[contragent] после _save →',
    (resp.json?.commands || []).map(c => c.instanceName).join(', '))
  // Пустой ответ банка ничего не объясняет — печатаем, что он реально прислал.
  if (!(resp.json?.commands || []).length) {
    console.log('[contragent] пустой ответ: статус', resp.status,
      '| тело:', JSON.stringify(resp.json).slice(0, 500))
  }

  // Разбор ответа — тот же, что у перевода между своими счетами
  let lastComplaint = ''
  for (let step = 0; step < 8; step++) {
    const cmds = resp.json?.commands || []

    const hard = cmds.flatMap(c => Object.entries(c.fields || {}))
      .flatMap(([id, f]) => (f.errors || []).map(e => id + ': ' + (e.message || e)))
    if (hard.length) return { ok: false, error: hard.join('; ') }

    const es = cmds.find(c => /errorsSave/.test(c.instanceName || ''))
    if (es?.instanceToken) {
      const said = collectMessages(es)
      if (said) { lastComplaint = said; console.log('[contragent] банк предупреждает:', said.slice(0, 200)) }
      const chosen = pickConfirmAction(es)
      console.log('[contragent] окно проверки: кнопки', JSON.stringify(Object.keys(es.actions || {})),
        '| нажимаю', chosen)
      resp = await bankApi(p, 'PUT', '/api/v1/ui/messages/errorsSave/doAction',
        { actionId: chosen, fields: {}, instanceToken: es.instanceToken })
      console.log('[contragent] после подтверждения →',
        (resp.json?.commands || []).map(c => `${c.command}:${c.instanceName}`).join(', ') || 'пусто, статус ' + resp.status)
      continue
    }

    const ok = cmds.find(c => /confirmDialog/.test(c.instanceName || ''))
    const closed = cmds.some(c => c.command === 'formClose' && /r030contragent/.test(c.instanceName || ''))
    if (ok || closed) {
      return { ok: true, saved: true, id: await findCreatedDoc(p, { amount, purpose }) }
    }
    break
  }

  // Прежде чем сказать «не сохранилось», спрашиваем банк, есть ли документ:
  // предупреждение могло быть информационным, а платёж — уже созданным.
  // Ложное «не вышло» опаснее всего: человек повторяет платёж и создаёт дубль.
  const created = await findCreatedDoc(p, { amount, purpose }).catch(() => null)
  if (created) {
    console.log('[contragent] банк ворчал, но документ создан:', created)
    return { ok: true, saved: true, id: created, warning: lastComplaint || undefined }
  }

  const said = lastComplaint
    || (resp.json?.commands || []).map(collectMessages).filter(Boolean).join('; ')
  return {
    ok: false,
    error: said || 'Банк не подтвердил сохранение платежа. Проверьте реквизиты получателя и назначение',
  }
}


/**
 * Какое действие нажать в предупреждении банка.
 *
 * Банк отвечает на сохранение окном «Результаты проверки» — это ПРЕДУПРЕЖДЕНИЕ
 * (проверка контрагента), а не отказ. Раньше мы всегда слали `_save`, и если у
 * окна такой кнопки не было, документ повисал: сервис отвечал «Результаты
 * проверки», хотя банк ждал обычного «Продолжить».
 */
function pickConfirmAction(cmd) {
  const acts = Object.entries(cmd?.actions || {})
    .filter(([, a]) => a && a.visible !== false)
    .map(([id, a]) => ({ id, label: String(a.label || '') }))

  // Выбираем по ПОДПИСИ, а не по идентификатору: у окна «Результаты проверки»
  // две кнопки — «Вернуться к редактированию» и «Продолжить». Идентификаторы
  // у них непредсказуемые, и выбор «первой попавшейся» возвращал в форму,
  // а платёж не сохранялся.
  const back = /верн|отмен|редактир|закр|нет/i
  const go = /продолж|сохран|подтверд|^да$|^ок$/i

  const byLabel = acts.find(a => go.test(a.label) && !back.test(a.label))
  if (byLabel) return byLabel.id

  const byId = ['_save', '_ok', '_yes', '_continue'].find(id => acts.some(a => a.id === id))
  if (byId) return byId

  // Ничего похожего на «продолжить» — берём любую, кроме возврата к правке.
  const safe = acts.find(a => !back.test(a.label))
  return (safe || acts[0] || { id: '_save' }).id
}


/**
 * Открыть форму платежа заново, если банк отдал её «пустой».
 *
 * После неудачной попытки форма остаётся открытой на стороне банка, и на
 * следующий menu/click он присылает оболочку без счетов и без панели шаблонов.
 * Дальше всё разваливается: счёт списания «не найден», а сохранение возвращает
 * пустой ответ. Лечится закрытием формы (_close) и повторным открытием.
 */
async function reopenIfStale(p, menuItem, instanceRe, form) {
  if ((form?.fields?.payerAccountId?.items || []).length) return form
  if (!form?.instanceToken) return form
  console.log('[форма] банк отдал пустую форму — закрываю и открываю заново')
  await bankApi(p, 'PUT', `/api/v1/${form.instanceName}/doAction`,
    { actionId: '_close', instanceToken: form.instanceToken }).catch(() => null)
  const again = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem })
  return (again.json?.commands || []).find(c => instanceRe.test(c.instanceName || '') && c.instanceToken) || form
}

/**
 * ПЛАТЁЖ В БЮДЖЕТ — налоги, взносы, пошлины.
 *
 * Отдельная форма банка (`ui/rur/payment/r030budget`) с налоговыми полями.
 * Имена у них неочевидные, взяты из исходников банка, а не придуманы:
 *   drawerStatus — статус плательщика (поле 101)
 *   cbc          — КБК (104)
 *   ocato        — ОКТМО (105), именно ocato, не oktmo
 *   payReason    — основание платежа (106)
 *   taxDocNumber — номер документа-основания (108)
 *   uip          — УИН (22)
 * Ошибиться в них легко, а банк вернёт отказ уже после отправки.
 *
 * Правила обязательности полей задаёт банк: он проверяет их на сервере и
 * отвечает текстом, который мы показываем как есть.
 */
async function payBudget(username, password, {
  fromAccount, amount, purpose = '',
  receiverName, receiverInn, receiverKpp = '', receiverAccount, receiverBic,
  drawerStatus, cbc, oktmo, payReason, taxPeriod, taxDocNumber, uin,
  docNumber = '', docDate = '',
  priority = '', urgent = false, reserveField = '',
  customsCode = '', reasonDocDate = '',
  saveAsTemplate = false, templateName = '',
}) {
  const p = await ensureLoggedIn(username, password)
  if (!await waitForAppReady(p, 45000)) throw new Error('Интерфейс ДБО не загрузился')

  const norm = x => String(x || '').replace(/\D/g, '')
  const missing = []
  if (!fromAccount) missing.push('счёт списания')
  if (!receiverName) missing.push('получатель')
  if (!receiverAccount) missing.push('счёт получателя')
  if (!receiverBic) missing.push('БИК')
  if (!purpose) missing.push('назначение платежа')
  if (!(Number(amount) > 0)) missing.push('сумма')
  if (!cbc) missing.push('КБК')
  if (missing.length) return { ok: false, error: 'Не заполнено: ' + missing.join(', ') }

  try {
    await p.goto('https://dbo.centrinvest.ru/api-ui/', { waitUntil: 'commit', timeout: 30000 })
    await waitForAppReady(p, 30000)
  } catch {}

  const r = await bankApi(p, 'POST', '/api/v1/menu/click',
    { menuItem: 'corporate-api-menu-small-r030budget' })
  const form = (r.json?.commands || []).find(c => /r030budget/.test(c.instanceName || ''))
  if (!form?.instanceToken) throw new Error('форма платежа в бюджет не открылась')

  const token = form.instanceToken
  const FORM_PATH = '/api/v1/ui/rur/payment/r030budget'

  const payerItems = form.fields?.payerAccountId?.items || []
  const payer = payerItems.find(i => norm(i.accountNumber || i.account) === norm(fromAccount))
  if (!payer) return { ok: false, error: 'счёт списания не найден среди ваших счетов' }

  const setField = async (name, value) => {
    if (value === undefined || value === null || value === '') return
    await bankApi(p, 'PUT', `${FORM_PATH}/stateUpdate`, {
      instanceToken: token,
      rowId: null,
      submitField: name,
      fields: { [name]: { value: String(value) } },
    })
  }

  await setField('payerAccountId', payer.id)
  // Номер и дата: в форме банка они есть и редактируются. Пустые не трогаем —
  // тогда номер присвоит банк, как и в веб-версии.
  if (docNumber) await setField('docNumber', String(docNumber))
  if (docDate) await setField('docDate', bankDate(docDate))
  await setField('receiverBankBic', norm(receiverBic))
  await setField('receiverINN', norm(receiverInn))
  await setField('receiverAccount', norm(receiverAccount))
  await setField('receiverName', receiverName)
  if (receiverKpp) await setField('receiverKPP', norm(receiverKpp))

  // Налоговые реквизиты
  await setField('drawerStatus', drawerStatus)
  await setField('cbc', cbc)
  await setField('ocato', oktmo)
  await setField('payReason', payReason)
  await setField('taxDocNumber', taxDocNumber)
  await setField('uip', uin)
  // Код таможенного органа вместо налогового периода — отдельное поле банка
  if (customsCode) await setField('customCode', String(customsCode))
  // Дата документа-основания у банка разбита на три поля
  if (reasonDocDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(reasonDocDate))
    if (m) {
      await setField('docDateDay', m[3])
      await setField('docDateMonth', m[2])
      await setField('docDateYear', m[1])
    }
  }

  // Поля, которые есть в форме банка и раньше терялись: очерёдность (банк по
  // умолчанию ставит 5), срочный платёж, УИН, резервное поле и сохранение
  // платежа в шаблоны. Пустые не трогаем, чтобы не переписывать умолчания банка.
  // Необязательные поля ставим осторожно: банк отвечает на неудачное значение
  // отказом всей формы (500 errorCode), и человек теряет платёж из-за галочки.
  const trySet = async (name, value) => {
    try { await setField(name, value) } catch (e) { console.warn('[поле]', name, 'не принято:', e.message) }
  }
  if (priority) console.log('[contragent] очерёдность не отправляю:', priority)
  if (urgent) await trySet('paymentCodeCheck', true)
  if (reserveField) await trySet('reserv23', String(reserveField))
  if (saveAsTemplate) {
    await trySet('addToTemplates', true)
    if (templateName) await trySet('templateName', String(templateName))
  }

  const fields = {
    documentSum: { value: Number(amount).toFixed(2) },
    paymentPurpose: { value: purpose },
  }
  if (taxPeriod) fields.taxPeriodDate = { value: taxPeriod }

  let resp = await bankApi(p, 'PUT', `${FORM_PATH}/doAction`, {
    actionId: '_save', fields, instanceToken: token,
  })
  console.log('[budget] после _save →',
    (resp.json?.commands || []).map(c => c.instanceName).join(', '))

  let lastComplaint = ''
  for (let step = 0; step < 8; step++) {
    const cmds = resp.json?.commands || []

    const hard = cmds.flatMap(c => Object.entries(c.fields || {}))
      .flatMap(([id, f]) => (f.errors || []).map(e => id + ': ' + (e.message || e)))
    if (hard.length) return { ok: false, error: hard.join('; ') }

    const es = cmds.find(c => /errorsSave/.test(c.instanceName || ''))
    if (es?.instanceToken) {
      const said = collectMessages(es)
      if (said) { lastComplaint = said; console.log('[budget] банк предупреждает:', said.slice(0, 200)) }
      const chosen = pickConfirmAction(es)
      console.log('[contragent] окно проверки: кнопки', JSON.stringify(Object.keys(es.actions || {})),
        '| нажимаю', chosen)
      resp = await bankApi(p, 'PUT', '/api/v1/ui/messages/errorsSave/doAction',
        { actionId: chosen, fields: {}, instanceToken: es.instanceToken })
      console.log('[contragent] после подтверждения →',
        (resp.json?.commands || []).map(c => `${c.command}:${c.instanceName}`).join(', ') || 'пусто, статус ' + resp.status)
      continue
    }

    const ok = cmds.find(c => /confirmDialog/.test(c.instanceName || ''))
    const closed = cmds.some(c => c.command === 'formClose' && /r030budget/.test(c.instanceName || ''))
    if (ok || closed) {
      return { ok: true, saved: true, id: await findCreatedDoc(p, { amount, purpose }) }
    }
    break
  }

  const said = lastComplaint
    || (resp.json?.commands || []).map(collectMessages).filter(Boolean).join('; ')
  return {
    ok: false,
    error: said || 'Банк не подтвердил сохранение. Проверьте КБК, ОКТМО и статус плательщика',
  }
}

/** Дата документа: приложение шлёт ISO (2026-08-12), банк ждёт 12.08.2026. */
function bankDate(v) {
  const s = String(v || '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s
}

async function transferOwnStructured(username, password, { fromAccount, toAccount, amount, purpose = '', sign = false, docNumber = '', docDate = '' }) {
  const p = await ensureLoggedIn(username, password)
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился')

  const norm = x => String(x || '').replace(/\D/g, '')
  const fromN = norm(fromAccount), toN = norm(toAccount)

  // Сбрасываем состояние: прошлый незавершённый перевод мог оставить форму
  // открытой, и тогда повторный menu/click не отдаёт чистую форму. Перезаходим
  // в новый интерфейс — это закрывает все открытые формы и диалоги.
  try {
    await p.goto('https://dbo.centrinvest.ru/api-ui/', { waitUntil: 'commit', timeout: 30000 })
    await waitForAppReady(p, 30000)
  } catch {}

  // 1) Открываем форму перевода между своими счетами
  const r = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem: 'corporate-api-menu-small-r030accounts' })
  const form = (r.json?.commands || []).find(c => /r030accounts/.test(c.instanceName || ''))
  if (!form?.instanceToken) throw new Error('форма перевода не открылась')

  // Сопоставляем счета с id. Список получателей зависит от выбранного плательщика,
  // поэтому нужный счёт может не оказаться в receiverAccountId.items. Но у счёта
  // ОДИН и тот же id в обоих списках — ищем по обоим (плательщики содержат все счета).
  const allItems = [
    ...(form.fields?.payerAccountId?.items || []),
    ...(form.fields?.receiverAccountId?.items || []),
  ]
  const matchItem = (accN) =>
    allItems.find(i => norm(i.accountNumber || i.account) === accN)
    || allItems.find(i => JSON.stringify(i).includes(accN))
  const payer = matchItem(fromN)
  const receiver = matchItem(toN)
  if (!payer) throw new Error('счёт списания не найден в форме: ' + fromAccount)
  if (!receiver) throw new Error('счёт зачисления не найден в форме: ' + toAccount)

  // 2) Заполняем поля и СОХРАНЯЕМ как документ.
  // Всегда _save (создать документ), даже если запросили подпись: подпись
  // требует интерактивного ввода ключа eToken + PayControl, а это отдельный шаг
  // через окно подписи в разделе «Платежи». _saveAndSign здесь оставлял бы
  // документ в подвешенном состоянии «ожидает подписи» и врал «отправлено».
  const action = '_save'
  const fields = {
    payerAccountId: { value: payer.id },
    receiverAccountId: { value: receiver.id },
    documentSum: { value: Number(amount).toFixed(2) },
    paymentPurpose: { value: purpose },
  }
  let resp = await bankApi(p, 'PUT', '/api/v1/ui/rur/payment/r030accounts/doAction', {
    actionId: action, fields, instanceToken: form.instanceToken,
  })
  console.log('[transfer2] после', action, '→', (resp.json?.commands || []).map(c => c.instanceName).join(', '))

  // 3) Разбираем диалоги/ошибки до успеха
  let lastComplaint = ''          // последнее, что банк сказал про документ
  for (let step = 0; step < 8; step++) {
    const cmds = resp.json?.commands || []

    // Жёсткие ошибки полей
    const hard = cmds.flatMap(c => Object.entries(c.fields || {}))
      .flatMap(([id, f]) => (f.errors || []).map(e => id + ': ' + (e.message || e)))
    if (hard.length) return { ok: false, error: hard.join('; ') }

    // Диалог предупреждений (WARN) — продолжаем нашим действием.
    // Текст запоминаем: если дальше упрёмся, человеку нужно знать причину,
    // а не «неожиданный ответ банка».
    const es = cmds.find(c => /errorsSave/.test(c.instanceName || ''))
    if (es?.instanceToken) {
      const said = collectMessages(es)
      if (said) { lastComplaint = said; console.log('[transfer2] банк предупреждает:', said.slice(0, 200)) }
      resp = await bankApi(p, 'PUT', '/api/v1/ui/messages/errorsSave/doAction',
        { actionId: pickConfirmAction(es) === '_save' ? action : pickConfirmAction(es), fields: {}, instanceToken: es.instanceToken })
      continue
    }

    // Подтверждение создания документа — успех
    const ok = cmds.find(c => /confirmDialog/.test(c.instanceName || ''))
    if (ok) return { ok: true, saved: true, id: await findCreatedDoc(p, { amount, purpose }) }

    // Форма закрылась без ошибок — документ сохранён
    const closed = cmds.some(c => c.command === 'formClose' && /r030accounts/.test(c.instanceName || ''))
    if (closed) return { ok: true, saved: true, id: await findCreatedDoc(p, { amount, purpose }) }

    break
  }

  // Сюда попадаем, когда банк не подтвердил сохранение. Раньше отдавалось
  // бессмысленное «неожиданный ответ банка» — человек не понимал ни что
  // случилось, ни что делать. Показываем то, что банк сказал на самом деле.
  const said = lastComplaint
    || (resp.json?.commands || []).map(collectMessages).filter(Boolean).join('; ')
  console.log('[transfer2] документ не сохранён.',
    'Команды:', (resp.json?.commands || []).map(c => c.instanceName).join(', '),
    '| Текст:', said || '—')
  return {
    ok: false,
    error: said || 'Банк не подтвердил сохранение документа. Проверьте счета, сумму и назначение — и попробуйте ещё раз',
    commands: (resp.json?.commands || []).map(c => c.instanceName).filter(Boolean),
  }
}

/**
 * Собрать читаемый текст из ответа банка: он раскладывает сообщения по разным
 * местам — отдельные тексты, подписи полей, ошибки полей.
 */
function collectMessages(cmd) {
  if (!cmd) return ''
  const out = []
  const push = v => { const s = String(v ?? '').trim(); if (s && !out.includes(s)) out.push(s) }

  for (const key of ['message', 'text', 'title', 'description']) push(cmd[key])
  for (const f of Object.values(cmd.fields || {})) {
    push(f?.value); push(f?.label)
    for (const e of (f?.errors || [])) push(e?.message || e)
  }
  for (const m of (cmd.messages || cmd.outputMessages || [])) push(m?.message || m)

  // Служебные подписи кнопок в текст ошибки не нужны
  return out.filter(s => !/^(ок|отмена|продолжить|закрыть|распечатать)$/i.test(s)).join('. ')
}

/**
 * Найти только что созданный черновик, чтобы сразу предложить его подписать.
 * Форма сохранения id документа не отдаёт, поэтому ищем в списке свежий
 * документ в статусе «new» с той же суммой и назначением. Если совпадений
 * несколько — берём последний по номеру: это и есть только что созданный.
 */
async function findCreatedDoc(p, { amount, purpose }) {
  try {
    const r = await bankApi(p, 'GET', `/api/v1/${SIGN_MODULE}/list?_offset=0&_limit=300`, null)
    const list = r.json?.list || r.json?.data?.list || []
    const sum = Number(amount).toFixed(2)
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const hits = list.filter(x =>
      x.state === 'new' &&
      Number(x.sum).toFixed(2) === sum &&
      (!purpose || norm(x.purpose) === norm(purpose)))
    if (!hits.length) return undefined
    const last = hits.sort((a, b) => Number(a.docNumber || 0) - Number(b.docNumber || 0)).pop()
    console.log('[transfer2] созданный документ №' + last.docNumber, '| id:', String(last.id).slice(0, 16) + '…')
    return last.id
  } catch (e) {
    console.warn('[transfer2] не удалось найти созданный документ:', e.message)
    return undefined
  }
}

/**
 * Разведка модели документа: GET {module}/{id} отдаёт документ целиком.
 * Нужна, чтобы собрать создание платежа чистым REST (POST {module}),
 * как это делает фронт банка (useCreateOrEditDoc), а не кликами по форме.
 * Только чтение.
 */
async function reconDocModel(username, password, { id }) {
  const p = await ensureLoggedIn(username, password)
  const r = await bankApi(p, 'GET', `/api/v1/${SIGN_MODULE}/${encodeURIComponent(id)}`, null)
  return { status: r.status, model: r.json }
}

/**
 * Разведка формы перевода между своими счетами (r030accounts).
 * Только открывает форму и возвращает её поля — чтобы реализовать перевод
 * по структурному API с верными именами полей, а не кликами. Ничего не сохраняет.
 */
async function reconTransferForm(username, password) {
  const p = await ensureLoggedIn(username, password)
  const ready = await waitForAppReady(p, 45000)
  if (!ready) throw new Error('Интерфейс ДБО не загрузился')

  // Пробуем открыть форму перевода между своими счетами разными пунктами меню
  const candidates = [
    'corporate-api-menu-small-r030accounts',
    'corporate-api-menu-small-r030base',
    'corporate-api-menu-small-r030contragent',
  ]
  let form = null, via = null
  for (const menuItem of candidates) {
    const r = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem })
    const cmds = r.json?.commands || []
    // Прямо форма accounts?
    form = cmds.find(c => /r030accounts/.test(c.instanceName || ''))
    if (form) { via = menuItem; break }
    // Либо базовая форма с переключателем — переключаемся на «Между своими счетами»
    const base = cmds.find(c => /r030base/.test(c.instanceName || ''))
    const sw = base?.fields?.r030FormSwitcher
    if (base?.instanceToken && sw) {
      const acc = (sw.items || []).find(i => /account|своими/i.test(i.id + ' ' + i.label))
      if (acc) {
        const r2 = await bankApi(p, 'PUT', '/api/v1/ui/rur/payment/r030base/doAction', {
          actionId: '_switchForm_r030FormSwitcher',
          fields: { r030FormSwitcher: { value: acc.id } },
          instanceToken: base.instanceToken,
        })
        form = (r2.json?.commands || []).find(c => /r030accounts|accounts/.test(c.instanceName || ''))
        if (form) { via = menuItem + ' → switch ' + acc.id; break }
      }
    }
  }

  if (!form) throw new Error('форма r030accounts не открылась ни одним способом')

  // Скелет полей: имя → тип, у грид/select — состав элементов (без чувствительных значений)
  const fields = {}
  for (const [name, f] of Object.entries(form.fields || {})) {
    const info = { type: f.type }
    if (Array.isArray(f.items)) {
      info.items = f.items.slice(0, 8).map(i => ({
        id: String(i.id ?? '').slice(0, 40),
        // подпись счёта / прозвище — по ней сопоставим номер
        label: i.accountName || i.label || i.code || i.accountNumber || '',
      }))
    }
    fields[name] = info
  }

  return {
    via,
    instanceName: form.instanceName,
    actions: Object.keys(form.actions || {}),
    fields,
  }
}

/** Шаг 1: отправить документ на подпись и дойти до окна ввода ключа eToken. */
// Сценарий подписи ровно как во фронте банка (bss-front-d2sme, useSignAndSend):
//   контроли -> сохранение -> ПОДПИСЬ -> ОТПРАВКА.
// Подпись, в свою очередь (useSignWithConfirmation):
//   1) getUserCryptoProfiles — какие средства подписи есть у пользователя;
//   2) если среди них есть ПОДТВЕРЖДАЮЩИЕ (signAuthorityTypeCode === 'CONFIRM'
//      и signConfirm) — сперва подписываем ими и получаем confirmTransactionId;
//   3) затем основная подпись (eToken PASS) уже с этим confirmTransactionId;
//   4) отдельным шагом POST {module}/send — без него документ остаётся
//      подписанным, но в банк не уходит.
// Тип документа по умолчанию — рублёвая платёжка. Подпись у банка одинакова
// для всех типов, поэтому модуль стал параметром: тем же кодом подписывается
// валютный перевод, письмо в банк или заявка.
const SIGN_MODULE = 'doc/rur/payorders'
const PAYCONTROL_MODULE = 'client/paycontrol'
const SIGN_OK = 'OK'                      // successSignResult из utils/sign.js

// Название типа средства подписи у банка человекочитаемое: 'SmsCrypto',
// 'устройство eTokenPass', 'приложение PayControl' и т.п.
const isEToken    = t => /etoken.?pass/i.test(t || '')
const isPayControl = t => /paycontrol/i.test(t || '')

async function getCryptoProfiles(p, ids, module = SIGN_MODULE) {
  const r = await bankApi(p, 'POST', `/api/v1/${module}/getUserCryptoProfiles`, { ids })
  const list = r.json?.cryptoProfiles || r.json?.data?.cryptoProfiles || []
  console.log('[sign] средства подписи:', list.map(x =>
    `${x.typeName}${x.signAuthorityTypeCode === 'CONFIRM' && x.signConfirm ? ' (подтверждающая)' : ''}`).join(', ') || '—')
  return list
}

async function prepareSignCall(p, { cryptoProfileId, ids, confirmTransactionId, module = SIGN_MODULE }) {
  const r = await bankApi(p, 'POST', `/api/v1/${module}/prepareSign`, {
    cryptoProfileId, ids, confirmTransactionId,
  })
  const d = r.json?.data || r.json
  if (!d?.transactionId) {
    throw new Error(d?.outputMessages?.[0]?.message || d?.result?.errorMessage || 'банк не начал подпись')
  }
  if (d.result?.hasErrors) throw new Error(d.result.errorMessage || 'ошибка подготовки подписи')
  return d
}

// Итог подписи считается успешным, только если КАЖДЫЙ результат равен 'OK'
// (checkSignResults во фронте банка). Раньше здесь была слишком мягкая проверка,
// из-за неё неуспешная подпись выглядела успешной.
const signResultsOk = d => {
  const rs = d?.signResults || d?.result?.signResults
  return Array.isArray(rs) && rs.length > 0 && rs.every(s => s.result === SIGN_OK)
}

// Человекочитаемый вид средства подписи и способ, которым оно спросит человека.
// `kind` нужен приложению, чтобы заранее сказать, что готовить: токен, телефон
// или ожидание СМС.
function describeMean(x) {
  const t = String(x.typeName || '')
  // Имена банк пишет по-разному: в списке средств у клиента видно
  // «OneTimePassword» и «PayControl», а в константах его фронта —
  // «SmsCrypto» и «приложение PayControl». Опознаём по подстроке.
  const kind = isEToken(t) ? 'etoken'
    : isPayControl(t) ? 'payControl'
      : /sms|onetimepassword|otp/i.test(t) ? 'otp' : 'other'
  return {
    id: x.id,
    typeName: t,
    kind,
    label: kind === 'etoken' ? 'Ключ с токена eToken'
      : kind === 'payControl' ? 'Подтверждение в PayControl'
        : kind === 'otp' ? 'Одноразовый пароль (СМС)' : t || 'Средство подписи',
    confirming: x.signAuthorityTypeCode === 'CONFIRM' && !!x.signConfirm,
  }
}

/**
 * Какими средствами можно подписать документ.
 *
 * Отдельный вызов нужен, чтобы приложение могло показать выбор ДО начала
 * подписи: `getUserCryptoProfiles` попытку ввода ключа не расходует, в отличие
 * от `prepareSign`. Поэтому список можно запрашивать спокойно.
 *
 * Возвращает подтверждающие и основные средства раздельно и подсказывает
 * рекомендуемые: подтверждающая — eToken, основная — PayControl (её
 * подтверждают на телефоне, тогда как СМС потребовала бы ещё и код).
 */
async function signMeans(username, password, { id, module = SIGN_MODULE }) {
  if (!id) throw new Error('не передан id документа')
  const p = await ensureLoggedIn(username, password)
  const list = await getCryptoProfiles(p, [String(id)], module)
  if (!list.length) throw new Error('у пользователя нет прав подписи этого документа')

  const confirming = list.filter(x => x.signAuthorityTypeCode === 'CONFIRM' && x.signConfirm).map(describeMean)
  const main = list.filter(x => x.signAuthorityTypeCode !== 'CONFIRM' || !x.signConfirm).map(describeMean)

  return {
    confirming,
    main,
    recommended: {
      confirmProfileId: (confirming.find(m => m.kind === 'etoken') || confirming[0])?.id || null,
      mainProfileId: (main.find(m => m.kind === 'payControl') || main[0])?.id || null,
    },
  }
}

async function signStart(username, password, { id, module = SIGN_MODULE, confirmProfileId = '', mainProfileId = '' }) {
  if (!id) throw new Error('не передан id документа')
  const p = await ensureLoggedIn(username, password)
  const ids = [String(id)]

  const list = await getCryptoProfiles(p, ids, module)
  if (!list.length) throw new Error('у пользователя нет прав подписи этого документа')

  const forConfirm = list.filter(x => x.signAuthorityTypeCode === 'CONFIRM' && x.signConfirm)
  const forSign    = list.filter(x => x.signAuthorityTypeCode !== 'CONFIRM' || !x.signConfirm)
  if (!forSign.length) throw new Error('есть только подтверждающая подпись — подписать документ нечем')

  // Средства подписи выбирает человек, если у него их несколько. Когда выбор
  // не передан, берём привычный порядок этого клиента: подтверждающая — eToken,
  // основная — PayControl (подтверждение приходит на телефон, тогда как
  // SmsCrypto потребовал бы ещё и код из СМС).
  const main = (mainProfileId && forSign.find(x => x.id === mainProfileId))
    || forSign.find(x => isPayControl(x.typeName)) || forSign[0]

  if (forConfirm.length) {
    const confirmProfile = (confirmProfileId && forConfirm.find(x => x.id === confirmProfileId))
      || forConfirm.find(x => isEToken(x.typeName)) || forConfirm[0]
    const cd = await prepareSignCall(p, { cryptoProfileId: confirmProfile.id, ids, module })
    const serial = cd.result?.serialNumber || ''
    pendingSigns.set(String(id), {
      stage: 'needKey',                    // подтверждающая подпись ключом с токена
      phase: 'confirm',                    // код закрывает подтверждающую транзакцию
      module,
      confirmTransactionId: cd.transactionId,
      mainProfileId: main.id,
      mainTypeName: main.typeName,
      serial,
      // Счётчик попыток и признак автосинхронизации: когда попытки кончаются,
      // банк не блокирует токен сразу, а предлагает синхронизацию двумя ключами.
      attemptsLeft: cd.result?.cryptoParamsModel?.maxAttempts ?? 3,
      autoSyncEnabled: cd.result?.cryptoParamsModel?.autoSyncEnabled !== false,
      startedAt: Date.now(),
    })
    console.log('[sign] подтверждающая подпись:', confirmProfile.typeName, '| серийник:', serial)
    // Возвращаем и то, чем подписываем сейчас, и то, что попросят следующим:
    // человек должен заранее понимать, что после кода с токена придётся
    // подтвердить операцию на телефоне.
    return {
      stage: 'needKey',
      serial,
      attempts: cd.result?.cryptoParamsModel?.maxAttempts,
      mean: describeMean(confirmProfile),
      next: describeMean(main),
    }
  }

  // Подтверждающей подписи нет — сразу основная.
  return signPrepareMain(p, id, main, undefined, module)
}

// Основная подпись. Для PayControl подтверждение приходит в приложение на
// телефоне, поэтому дальше клиента опрашиваем через signStatus.
async function signPrepareMain(p, id, main, confirmTransactionId, module = SIGN_MODULE) {
  const d = await prepareSignCall(p, {
    cryptoProfileId: main.id,
    ids: [String(id)],
    confirmTransactionId,
    module,
  })
  const viaPayControl = isPayControl(main.typeName)
  pendingSigns.set(String(id), {
    stage: viaPayControl ? 'payControl' : 'needKey',
    // Метка шага: дальше код от человека закрывает ОСНОВНУЮ транзакцию,
    // а не подтверждающую. Без неё код из СМС уходил в уже закрытую
    // транзакцию eToken, и банк его не принимал.
    phase: 'main',
    module,
    transactionId: d.transactionId,
    pcOperationId: d.result?.pcOperationId,
    confirmTransactionId,
    serial: d.result?.serialNumber || '',
    attemptsLeft: d.result?.cryptoParamsModel?.maxAttempts ?? 3,
    startedAt: Date.now(),
  })
  console.log('[sign] основная подпись:', main.typeName, '| txId:', d.transactionId)
  if (viaPayControl) {
    return { stage: 'confirm', confirmType: 'payControl',
      // Банк даёт QR: его можно отсканировать в «Центр-инвест Бизнес»,
      // если подтверждение не пришло в приложение само.
      qrCode: d.qrCode || d.result?.qrCode || undefined,
      mean: describeMean(main),
      // Сколько раз можно ввести код подтверждения. У банка это
      // cryptoParamsModel.confirmAttempts в диалоге PayControl.
      attempts: d.result?.cryptoParamsModel?.confirmAttempts,
      message: 'Подтвердите операцию в приложении PayControl на телефоне' }
  }
  return { stage: 'needKey', serial: d.result?.serialNumber || '',
    attempts: d.result?.cryptoParamsModel?.maxAttempts,
    mean: describeMean(main) }
}

// Опрос подтверждения в PayControl. Пока клиент не нажал в приложении —
// банк держит подпись неподтверждённой.
async function signStatus(username, password, { id }) {
  const pend = pendingSigns.get(String(id))
  if (!pend) throw new Error('подпись не начата или истекла — начните заново')
  if (pend.stage !== 'payControl') {
    return { stage: pend.stage === 'needKey' ? 'needKey' : pend.stage, serial: pend.serial }
  }

  const p = await ensureLoggedIn(username, password)

  // Банк узнаёт о подтверждении PayControl НЕ опросом, а push-подпиской по
  // вебсокету (useOmniSubscription 'PayControlEvent:<pcTransactionId>' в его
  // фронте). Метод paycontrol/signresult используется у них только при отмене
  // и до подтверждения всегда отдаёт пустой signResults — опрос по нему висел
  // вечно. Через прокси вебсокет не поймать, поэтому смотрим самый надёжный
  // признак: состояние самого документа. Пока он «new» — подписи нет.
  const state = await getDocState(p, id, pend.module)
  console.log('[sign] состояние документа:', state || '—')

  if (state && state !== 'new') {
    pendingSigns.delete(String(id))
    // Документ уже ушёл дальше по конвейеру банка — отправлять нечего.
    if (['delivered', 'accepted', 'inProcess', 'processed'].includes(state)) {
      return { stage: 'done', message: 'Документ подписан и отправлен в банк' }
    }
    if (state === 'signed' || state === 'partlySigned') {
      const sent = await sendDocument(p, id, pend.confirmTransactionId)
      return sent.ok
        ? { stage: 'done', message: 'Документ подписан и отправлен в банк' }
        : { stage: 'signed', message: 'Документ подписан, но не отправлен: ' + sent.error }
    }
    // Банк отклонил документ — честно говорим, а не выдаём за успех
    return { stage: 'error', errors: ['Банк не принял документ: ' + (DOC_STATE_NAMES[state] || state)] }
  }

  // Ждём слишком долго — подтверждение в приложении, видимо, не сделали
  if (Date.now() - (pend.startedAt || 0) > 10 * 60 * 1000) {
    pendingSigns.delete(String(id))
    return { stage: 'error', errors: ['Подтверждение в PayControl не пришло за 10 минут — начните подпись заново'] }
  }

  return { stage: 'confirm', confirmType: 'payControl', message: 'Ждём подтверждения в PayControl' }
}

/** Текущее состояние документа по списку банка: самый надёжный признак подписи. */
async function getDocState(p, id, module = SIGN_MODULE) {
  try {
    const r = await bankApi(p, 'GET', `/api/v1/${module}/list?_offset=0&_limit=300`, null)
    const list = r.json?.list || r.json?.data?.list || []
    return list.find(x => String(x.id) === String(id))?.state
  } catch (e) {
    console.warn('[sign] не удалось прочитать состояние документа:', e.message)
    return undefined
  }
}

async function signSubmitKey(username, password, { id, key }) {
  // continueSign {model:{code}, transactionId} — ключ токена идёт в model.code
  if (!key) throw new Error('не передан ключ токена')
  const pend = pendingSigns.get(String(id))
  if (!pend || !['needKey', 'payControl'].includes(pend.stage)) {
    throw new Error('подпись не начата или истекла — начните заново')
  }
  const p = await ensureLoggedIn(username, password)

  // Куда слать код — зависит от того, какой шаг сейчас ждёт ввода:
  //   needKey    — ключ с eToken закрывает ПОДТВЕРЖДАЮЩУЮ транзакцию;
  //   payControl — код из PayControl закрывает ОСНОВНУЮ.
  // Раньше здесь всегда бралась подтверждающая, и код PayControl уходил не туда.
  // На шаге основной подписи (СМС или PayControl) код закрывает ОСНОВНУЮ
  // транзакцию, на шаге подтверждающей — подтверждающую.
  const txId = pend.phase === 'main'
    ? (pend.transactionId || pend.confirmTransactionId)
    : (pend.confirmTransactionId || pend.transactionId)
  const r = await bankApi(p, 'POST', `/api/v1/${pend.module || SIGN_MODULE}/continueSign`, {
    model: { code: String(key) },
    transactionId: txId,
  })
  const d = r.json?.data || r.json
  console.log('[sign] continueSign ответ:', JSON.stringify(d).slice(0, 400))

  if (!signResultsOk(d)) {
    const msg = d?.outputMessages?.[0]?.message
      || (d?.signResults || []).map(s => s.message).filter(Boolean)[0]
      || 'ключ не принят'

    // Код «-1» у банка означает не отказ, а «операция ещё не подтверждена»:
    // человек нажал «Подтвердить» раньше, чем подтвердил в приложении
    // PayControl. Фронт банка в этом случае просто продолжает ждать события.
    if ((d?.outputMessages || []).some(m => String(m?.code) === '-1')) {
      pendingSigns.set(String(id), pend)
      return { stage: 'confirm', confirmType: 'payControl', waiting: true,
        message: msg || 'Операция ещё не подтверждена в PayControl' }
    }
    // Попытки конечны. Когда они исчерпаны, банк не блокирует токен сразу:
    // при включённой автосинхронизации он просит ввести ДВА ключа подряд,
    // чтобы заново совпасть со счётчиком устройства. Это про eToken —
    // к подтверждению PayControl синхронизация отношения не имеет.
    pend.attemptsLeft = (pend.attemptsLeft ?? 1) - 1
    if (pend.stage === 'payControl') {
      pendingSigns.set(String(id), pend)
      return { stage: 'confirm', confirmType: 'payControl',
        attemptsLeft: pend.attemptsLeft, errors: [msg] }
    }
    if (pend.attemptsLeft <= 0 && pend.autoSyncEnabled) {
      pend.stage = 'sync'
      pendingSigns.set(String(id), pend)
      console.log('[sign] попытки исчерпаны — нужна синхронизация токена')
      return { stage: 'sync', serial: pend.serial, errors: [msg] }
    }
    pendingSigns.set(String(id), pend)
    return { stage: 'error', attemptsLeft: pend.attemptsLeft, errors: [msg] }
  }

  // Ключ приняли. Если это была подтверждающая подпись — переходим к основной
  // (PayControl), и только после неё документ уходит в банк.
  if (pend.mainProfileId) {
    const list = await getCryptoProfiles(p, [String(id)], pend.module)
    const main = list.find(x => x.id === pend.mainProfileId) || list.find(x => isPayControl(x.typeName))
    if (!main) throw new Error('средство основной подписи пропало из списка')
    return signPrepareMain(p, id, main, pend.confirmTransactionId, pend.module)
  }

  pendingSigns.delete(String(id))
  const sent = await sendDocument(p, id, pend.confirmTransactionId, pend.module)
  return sent.ok
    ? { stage: 'done', message: 'Документ подписан и отправлен в банк' }
    : { stage: 'signed', message: 'Документ подписан, но не отправлен: ' + sent.error }
}

/**
 * Синхронизация токена eToken PASS. Когда попытки ввода ключа исчерпаны,
 * банк просит ДВА ключа подряд, чтобы заново совпасть со счётчиком устройства
 * (форма ETokenPassSynchronization во фронте банка). Это тот же continueSign,
 * но с моделью {firstKey, secondKey} вместо {code}.
 * Если и здесь ключи неверны — банк блокирует пользователя.
 */
async function signSyncToken(username, password, { id, firstKey, secondKey }) {
  if (!firstKey || !secondKey) throw new Error('нужны оба ключа с токена')
  const pend = pendingSigns.get(String(id))
  if (!pend || pend.stage !== 'sync') throw new Error('синхронизация не запрошена — начните подпись заново')
  const p = await ensureLoggedIn(username, password)

  const txId = pend.confirmTransactionId || pend.transactionId
  const r = await bankApi(p, 'POST', `/api/v1/${pend.module || SIGN_MODULE}/continueSign`, {
    model: { firstKey: String(firstKey), secondKey: String(secondKey) },
    transactionId: txId,
  })
  const d = r.json?.data || r.json
  console.log('[sign] синхронизация ответ:', JSON.stringify(d).slice(0, 300))

  if (!signResultsOk(d)) {
    pendingSigns.delete(String(id))
    const msg = d?.outputMessages?.[0]?.message || 'ключи не подошли'
    return { stage: 'error', errors: [msg + '. Банк мог заблокировать доступ — обратитесь в банк'] }
  }

  // Синхронизация удалась и заодно закрыла подтверждающую подпись —
  // дальше обычный путь: основная подпись, затем отправка.
  if (pend.mainProfileId) {
    const list = await getCryptoProfiles(p, [String(id)], pend.module)
    const main = list.find(x => x.id === pend.mainProfileId) || list.find(x => isPayControl(x.typeName))
    if (!main) throw new Error('средство основной подписи пропало из списка')
    return signPrepareMain(p, id, main, pend.confirmTransactionId, pend.module)
  }

  pendingSigns.delete(String(id))
  const sent = await sendDocument(p, id, pend.confirmTransactionId, pend.module)
  return sent.ok
    ? { stage: 'done', message: 'Документ подписан и отправлен в банк' }
    : { stage: 'signed', message: 'Документ подписан, но не отправлен: ' + sent.error }
}

// Отмена начатой подписи. Если человек закрыл окно на шаге подтверждения,
// в банке остаётся висящая операция PayControl — фронт банка её тоже гасит
// (usePreparePayContolSignLoop → paycontrol/cancel).
async function signCancel(username, password, { id }) {
  const pend = pendingSigns.get(String(id))
  if (!pend) return { cancelled: false }
  pendingSigns.delete(String(id))
  if (pend.stage !== 'payControl' || !pend.transactionId) return { cancelled: true }
  try {
    const p = await ensureLoggedIn(username, password)
    await bankApi(p, 'POST', `/api/v1/${PAYCONTROL_MODULE}/cancel`, {
      transactionId: pend.transactionId,
      pcOperationId: pend.pcOperationId,
    })
    console.log('[sign] подпись отменена, операция PayControl погашена')
  } catch (e) {
    console.warn('[sign] отмена в банке не прошла:', e.message)
  }
  return { cancelled: true }
}

// POST {module}/send {ids, confirmTransactionId, userWorkspace}
async function sendDocument(p, id, confirmTransactionId, module = SIGN_MODULE) {
  try {
    const r = await bankApi(p, 'POST', `/api/v1/${module}/send`, {
      ids: [String(id)],
      confirmTransactionId,
      userWorkspace: {},
    })
    const d = r.json?.data || r.json
    console.log('[sign] send ответ:', JSON.stringify(d).slice(0, 300))
    const results = d?.results || []
    if (results.some(e => e.result === 'success')) return { ok: true }
    return { ok: false, error: results[0]?.message || 'банк не принял отправку' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}


/**
 * Разведка документного API: ищем, каким запросом банк отдаёт список документов
 * с идентификаторами и какие действия над ними доступны (подпись, удаление).
 * Сейчас платежи снимаются парсингом текста выписки, где id нет вовсе, —
 * поэтому подпись и удаление документов ДБО невозможны.
 *
 * ТОЛЬКО ЧТЕНИЕ: переходим по разделам документов и записываем трафик /api/v1.
 * Кнопки подписи, отправки и удаления не нажимаются — деньги не двигаются.
 */
// Разведка REST-эндпоинтов банка: пробуем варианты и возвращаем сырые ответы,
// чтобы узнать точный адрес списка документов и профилей подписи без гадания.
async function reconRest(username, password) {
  const p = await ensureLoggedIn(username, password)
  await waitForAppReady(p, 30000)
  const probes = [
    ['GET', '/api/v1/doc/rur/payorders?_offset=0&_limit=5'],
    ['GET', '/api/v1/doc/rur/payorders/list?_offset=0&_limit=5'],
    ['GET', '/api/v1/doc/rur/payorders?_offset=0&_limit=5&_columns=id,docNumber,stateName,documentSum'],
    ['POST', '/api/v1/doc/rur/payorders/list', { offset: 0, limit: 5 }],
    ['GET', '/api/v1/doc/rur/payorders/count'],
  ]
  const out = []
  for (const [method, path, body] of probes) {
    try {
      const r = await bankApi(p, method, path, body || null)
      const j = r.json
      const arr = Array.isArray(j) ? j : (j?.items || j?.data || j?.list || j?.rows)
      out.push({
        method, path, status: r.status,
        тип: Array.isArray(arr) ? `массив(${arr.length})` : typeof j,
        поля: Array.isArray(arr) && arr[0] ? Object.keys(arr[0]) : Object.keys(j || {}),
        образец: JSON.stringify(Array.isArray(arr) ? arr[0] : j).slice(0, 500),
      })
    } catch (e) {
      out.push({ method, path, error: e.message })
    }
  }
  return out
}

async function reconDocuments(username, password) {
  const p = await ensureLoggedIn(username, password)
  const traffic = []

  const onResp = async (r) => {
    try {
      const u = r.url()
      if (!u.includes('/api/v1') && !u.includes('/api-ui')) return
      if (r.status() !== 200) return
      if (!(r.headers()['content-type'] || '').includes('json')) return
      const body = await r.text()
      if (body.length < 50) return
      traffic.push({
        url: u.replace('https://dbo.centrinvest.ru', ''),
        method: r.request().method(),
        size: body.length,
        body,
      })
    } catch {}
  }
  p.on('response', onResp)

  const dismiss = async () => {
    try {
      await p.evaluate(() => {
        const m = document.querySelector('[data-at="modal-ui/messages/mustRead"]')
        if (m) {
          const bs = Array.from(m.querySelectorAll('button,[role=button]'))
          const b = bs[bs.length - 1]; if (b) b.click(); else m.remove()
        }
      })
    } catch {}
  }

  await p.waitForTimeout(1200)
  await dismiss()

  const visited = []
  for (const label of ['Платежи', 'Черновики', 'На подпись', 'В обработке', 'Отклоненные', 'Выполненные']) {
    try {
      await dismiss()
      // .first(): «Платежи» встречается и в меню, и во вкладках — строгий режим
      // Playwright отказывался кликать по нескольким совпадениям, и переход не шёл
      await p.locator(`text=${label}`).first().click({ timeout: 6000 })
      await p.waitForTimeout(2500)
      visited.push(label)
    } catch {}
  }
  await p.waitForTimeout(1500)
  p.off('response', onResp)

  // Что в ответах похоже на идентификаторы документов и действия над ними
  const idKeys = new Set()
  const idSamples = []
  const actions = new Set()
  const instances = new Set()

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    for (const [k, v] of Object.entries(node)) {
      if (/^(id|documentId|docId|uid|guid|instanceToken)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        idKeys.add(k)
        if (idSamples.length < 20) idSamples.push({ key: k, value: String(v).slice(0, 60) })
      }
      if (k === 'actions' && v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(a => actions.add(a))
      }
      if (k === 'instanceName' && typeof v === 'string') instances.add(v)
      walk(v)
    }
  }
  for (const t of traffic) { try { walk(JSON.parse(t.body)) } catch {} }

  // Скелет структуры форм с платежами: только имена полей и типы, без значений.
  // Нужен, чтобы понять, где лежит идентификатор документа и какие действия
  // доступны у конкретной строки — по этому строится подпись и удаление.
  const skeleton = (node, depth = 0) => {
    if (depth > 7) return "…"
    if (node === null) return 'null'
    if (Array.isArray(node)) {
      return node.length ? [`массив(${node.length})`, skeleton(node[0], depth + 1)] : 'массив(0)'
    }
    if (typeof node !== 'object') return typeof node
    const out = {}
    for (const k of Object.keys(node).slice(0, 40)) out[k] = skeleton(node[k], depth + 1)
    return out
  }

  const structures = {}
  for (const t of traffic) {
    let parsed
    try { parsed = JSON.parse(t.body) } catch { continue }
    for (const cmd of (parsed.commands || [])) {
      const name = cmd.instanceName || ''
      if (!/payments|mainForm|account/i.test(name)) continue
      if (structures[name]) continue
      structures[name] = {
        actions: Object.keys(cmd.actions || {}),
        fields: skeleton(cmd.fields, 1),
      }
    }
  }

  return {
    visitedSections: visited,
    responses: traffic.length,
    endpoints: [...new Set(traffic.map(t => `${t.method} ${t.url.split('?')[0]}`))].sort(),
    idKeys: [...idKeys],
    idSamples,
    // Здесь ищем что-то вроде _sign, _delete, _remove — это и есть ключ к подписи
    actions: [...actions].sort(),
    instances: [...instances].sort().slice(0, 150),
    structures,
  }
}

module.exports = { getMustRead, confirmMustRead, getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, downloadStatement, getTariffs, transferOwn, getSectionData, DBO_SECTIONS, reconDocuments, reconRest, getDocuments, getAccountNames, documentAction, signStart, signMeans, signStatus, signSubmitKey, signSyncToken, signCancel, docList, docGet, docSave, docValidate, docSend, docCanDo, docSearch, ensureLoggedIn, getOperations, getMail, getMailItem, markMailRead, getMailCounters, payContragent, payBudget, getDocumentPrint, getRequisites, deleteDocuments, getPartners, getBics, reconTransferForm, reconDocModel, transferOwnStructured, closeBrowser, callBankApi, getBanners, getBannerImage }
