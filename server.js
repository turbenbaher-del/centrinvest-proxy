const express = require('express')
const cors = require('cors')
const { getAccountsData, getPaymentsData, getTemplatesData, getWhoAmI, getNavDebug, getPaymentsDebug, getApiResponsesDebug, getAccountsDomDebug, submitPayment, getContractorsFromHistory, closeBrowser } = require('./browser')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

const USERNAME = process.env.DBO_LOGIN    || '24cmvKy8'
const PASSWORD = process.env.DBO_PASSWORD || 'dbocib14Z'

app.get('/health', (_, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {}
  if (login !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ success: false, error: 'Неверные учетные данные' })
  }
  try {
    const name = await getWhoAmI(USERNAME, PASSWORD)
    res.json({ success: true, name: name || login })
  } catch (err) {
    console.error('[login]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/accounts', async (req, res) => {
  try {
    const data = await getAccountsData(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[accounts]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments', async (req, res) => {
  try {
    const data = await getPaymentsData(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[payments]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/payments', async (req, res) => {
  const body = req.body || {}
  try {
    const result = await submitPayment(USERNAME, PASSWORD, body)
    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[payments POST]', err.message)
    // Fall back to draft so UI doesn't break
    res.json({
      success: false,
      error: err.message,
      data: {
        ...body,
        id: `draft-${Date.now()}`,
        status: 'draft',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      }
    })
  }
})

app.get('/api/contractors', async (req, res) => {
  try {
    const data = await getContractorsFromHistory(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[contractors]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/templates', async (req, res) => {
  try {
    const data = await getTemplatesData(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[templates]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/payments-debug', async (req, res) => {
  try {
    const data = await getPaymentsDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[payments-debug]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/nav-debug', async (req, res) => {
  try {
    const data = await getNavDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[nav-debug]', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/debug/api-responses', (req, res) => {
  res.json({ success: true, data: getApiResponsesDebug() })
})

app.get('/debug/accounts-dom', async (req, res) => {
  try {
    const data = await getAccountsDomDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/logout', async (_, res) => {
  await closeBrowser()
  res.json({ success: true })
})

app.listen(PORT, () => {
  console.log(`Centrinvest proxy on http://localhost:${PORT}`)
})
