const cheerio = require('cheerio')
const { curlGet, curlPost, BASE } = require('./auth')

function parseAccounts(html) {
  const $ = cheerio.load(html)
  const accounts = []

  // ZK renders account rows with specific patterns
  // Look for 20-digit account numbers
  const text = $.text()
  const rows = html.split('\n')

  // Strategy: find all 20-digit account numbers in the page
  const accountPattern = /\b(\d{20})\b/g
  let match
  const numbers = new Set()
  while ((match = accountPattern.exec(html)) !== null) {
    numbers.add(match[1])
  }

  // For each account number, find its balance context
  numbers.forEach(num => {
    const idx = html.indexOf(num)
    const ctx = html.substring(idx, idx + 500)
    const $ctx = cheerio.load(ctx)
    const balMatch = ctx.match(/(\d[\d\s]{0,10}[,\.]\d{2})\b/)
    const balance = balMatch
      ? parseFloat(balMatch[1].replace(/\s/g, '').replace(',', '.'))
      : 0

    // Determine currency (RUR default)
    const currency = ctx.includes('USD') ? 'USD' : ctx.includes('EUR') ? 'EUR' : 'RUR'

    accounts.push({ number: num, currency, balance })
  })

  // If we found nothing, try table parsing
  if (accounts.length === 0) {
    $('tr').each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length >= 3) {
        const first = $(cells.eq(0)).text().trim()
        if (first.match(/^\d{14,20}/)) {
          const balText = $(cells.eq(4)).text().trim() || $(cells.eq(3)).text().trim()
          accounts.push({
            number: first,
            currency: $(cells.eq(1)).text().trim() || 'RUR',
            type: $(cells.eq(2)).text().trim(),
            status: $(cells.eq(3)).text().trim(),
            balance: parseFloat(balText.replace(/\s/g, '').replace(',', '.')) || 0,
          })
        }
      }
    })
  }

  return accounts
}

async function getAccounts() {
  const html = curlGet(`${BASE}/main.zul`)
  return parseAccounts(html)
}

async function getPayments() {
  // Try the payments page via ZK navigation
  const html = curlGet(`${BASE}/main.zul`)
  const $ = cheerio.load(html)
  const payments = []

  $('tr').each((_, row) => {
    const cells = $(row).find('td')
    if (cells.length >= 4) {
      const date = $(cells.eq(0)).text().trim()
      if (date.match(/\d{2}\.\d{2}\.\d{4}/)) {
        const amount = $(cells.eq(3)).text().trim()
        payments.push({
          date,
          number: $(cells.eq(1)).text().trim(),
          recipient: $(cells.eq(2)).text().trim(),
          amount: parseFloat(amount.replace(/\s/g, '').replace(',', '.')) || 0,
          status: $(cells.eq(4))?.text().trim() || '',
        })
      }
    }
  })

  return payments
}

module.exports = { getAccounts, getPayments, parseAccounts }
