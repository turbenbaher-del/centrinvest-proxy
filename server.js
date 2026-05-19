const express = require('express')
const cors = require('cors')
const { getAccountsData, getPaymentsData, getWhoAmI, getNavDebug, closeBrowser } = require('./browser')

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

app.get('/api/nav-debug', async (req, res) => {
  try {
    const data = await getNavDebug(USERNAME, PASSWORD)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[nav-debug]', err.message)
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
