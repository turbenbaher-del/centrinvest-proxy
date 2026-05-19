const { execSync } = require('child_process')
const { CookieJar } = require('tough-cookie')
const { SRPClientContext } = require('./srp')

const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const COOKIE_FILE = require('path').join(require('os').tmpdir(), 'ci_cookies.txt')

function curlPost(url, body, extraArgs = []) {
  const cmd = [
    'curl.exe', '-s', '-k',
    '-c', `"${COOKIE_FILE}"`,
    '-b', `"${COOKIE_FILE}"`,
    '-X', 'POST',
    '-H', `"Content-Type: application/x-www-form-urlencoded; charset=UTF-8"`,
    '-H', `"Referer: ${BASE}/ru/html/login.html"`,
    '-H', `"User-Agent: Mozilla/5.0"`,
    '--data', `"${body.replace(/"/g, '\\"')}"`,
    ...extraArgs,
    `"${url}"`,
  ].join(' ')
  return execSync(cmd, { encoding: 'utf8', timeout: 15000 })
}

function curlGet(url, extraArgs = []) {
  const cmd = [
    'curl.exe', '-s', '-k', '-L',
    '-c', `"${COOKIE_FILE}"`,
    '-b', `"${COOKIE_FILE}"`,
    '-H', `"User-Agent: Mozilla/5.0"`,
    '-H', `"Referer: ${BASE}/main.zul"`,
    ...extraArgs,
    `"${url}"`,
  ].join(' ')
  return execSync(cmd, { encoding: 'utf8', timeout: 15000 })
}

async function login(username, password) {
  // Clear cookies
  try { require('fs').unlinkSync(COOKIE_FILE) } catch {}

  // Step 1: PreLogin
  const preText = curlPost(`${BASE}/service/prelogin`,
    `userName=${encodeURIComponent(username.toLowerCase())}`)

  if (!preText || preText.includes('\n') || preText.includes('<')) {
    throw new Error('PreLogin failed: ' + preText.substring(0, 150))
  }

  const parts = preText.trim().split(';')
  if (parts.length < 3) {
    throw new Error('Unexpected prelogin response: ' + preText.substring(0, 150))
  }

  const vS        = parts[0]
  const vBbs      = parts[1]
  const salt      = parts[2]
  const d         = parts[3] || ''
  const preloginId = parts[4] || ''

  const is2048 = vBbs.length > 66
  const srp = new SRPClientContext(vS, vBbs, is2048)

  let authBody
  if (is2048) {
    const passwordDataExt  = srp.makeAuthorizationData(salt, password)
    const extPasswordDataExt = srp.getAbytes()
    authBody = `passwordDataExt=${passwordDataExt}&extPasswordDataExt=${extPasswordDataExt}`
  } else {
    const crypto = require('crypto')
    const sha1    = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex')
    const sha1hex = s => crypto.createHash('sha1').update(Buffer.from(s, 'hex')).digest('hex')
    const hexToBase64 = h => Buffer.from(h, 'hex').toString('base64')
    const passwordData         = srp.makeAuthorizationData(salt, password)
    const f                    = sha1(password)
    const passwordDataSHA      = srp.makeAuthorizationData(salt, f)
    const passwordDataSHASalt  = srp.makeAuthorizationData(salt, sha1(hexToBase64(f) + d))
    const extPasswordData      = srp.getAbytes()
    authBody = `passwordData=${passwordData}&passwordDataSHA=${passwordDataSHA}&passwordDataSHASalt=${passwordDataSHASalt}&extPasswordData=${extPasswordData}`
  }

  // Step 2: Get CSRF token
  const loginHtml = curlGet(`${BASE}/ru/html/login.html`)
  const csrfToken     = (loginHtml.match(/id="CSRFToken"[^>]*value="([^"]+)"/) || [])[1] || ''
  const csrfCookieId  = (loginHtml.match(/id="CSRFTokenCookieId"[^>]*value="([^"]+)"/) || [])[1] || ''

  // Step 3: Login
  const loginBody = [
    `userName=${encodeURIComponent(username.toLowerCase())}`,
    authBody,
    `language=ru`,
    `CSRFToken=${csrfToken}`,
    `CSRFTokenCookieId=${csrfCookieId}`,
    `OAUTHToken=`,
    `preloginId=${preloginId}`,
  ].join('&')

  curlPost(`${BASE}/service/login`, loginBody, ['-L'])

  // Step 4: Get main page and extract auth token
  const mainHtml = curlGet(`${BASE}/main.zul`)

  if (mainHtml.includes('login.html') || mainHtml.includes('Вход в клиент-банк')) {
    throw new Error('Login failed — wrong credentials or captcha required')
  }

  const authToken = (mainHtml.match(/__authToken__\s*=\s*["']([^"']+)["']/) || [])[1] || null

  return { mainHtml, authToken }
}

module.exports = { login, curlGet, curlPost, BASE, COOKIE_FILE }
