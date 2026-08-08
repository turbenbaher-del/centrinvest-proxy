/**
 * Журнал действий.
 *
 * Нужен, чтобы по инциденту можно было ответить на вопросы «что произошло»,
 * «когда» и «чем закончилось». Без него единственным свидетельством остаётся
 * выписка банка, где видно только результат.
 *
 * Два места назначения одновременно:
 *  1) stdout строками JSON — попадает в логи хостинга и переживает перезапуск;
 *  2) кольцевой буфер в памяти — чтобы владелец видел журнал прямо в приложении.
 *
 * ЧЕГО В ЖУРНАЛЕ НЕТ И НЕ ДОЛЖНО БЫТЬ: пароля ДБО, ключей с токена, кодов
 * подтверждения, токена доступа к прокси. Журнал, куда утекают секреты, сам
 * становится уязвимостью. Номера счетов пишутся в маскированном виде.
 */

const fs = require('fs')
const path = require('path')

const MAX_ENTRIES = 500
const entries = []

// ─── Постоянное хранение ────────────────────────────────────────────────────
// Логи хостинга живут недолго и обнуляются при перезапуске, а разбирать сбои
// приходится позже — когда картинка уже стёрлась. Поэтому дублируем журнал в
// файл на диске: он переживает и перезапуск, и повторное развёртывание, если
// каталог смонтирован как постоянный (AUDIT_DIR).
const AUDIT_DIR = process.env.AUDIT_DIR || path.join(__dirname, 'data')
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl')
const MAX_FILE_BYTES = 5 * 1024 * 1024      // дальше подрезаем, чтобы не рос бесконечно
let fileReady = false

try {
  fs.mkdirSync(AUDIT_DIR, { recursive: true })
  fileReady = true
} catch (e) {
  console.warn('[audit] постоянный журнал недоступен:', e.message)
}

/** Подрезать файл, оставив свежую половину: журнал не должен съедать диск. */
function rotateIfNeeded() {
  try {
    if (!fileReady || !fs.existsSync(AUDIT_FILE)) return
    const { size } = fs.statSync(AUDIT_FILE)
    if (size < MAX_FILE_BYTES) return
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(AUDIT_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8')
    console.log('[audit] файл журнала подрезан')
  } catch (e) {
    console.warn('[audit] не удалось подрезать журнал:', e.message)
  }
}

/** При старте поднимаем в память хвост прошлых запусков. */
function loadFromFile() {
  try {
    if (!fileReady || !fs.existsSync(AUDIT_FILE)) return
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    for (const line of lines.slice(-MAX_ENTRIES)) {
      try { entries.push(JSON.parse(line)) } catch { /* битая строка — пропускаем */ }
    }
    if (entries.length) console.log(`[audit] поднято из файла записей: ${entries.length}`)
  } catch (e) {
    console.warn('[audit] не удалось прочитать журнал:', e.message)
  }
}
loadFromFile()

/** Оставляем только последние 4 цифры: «…8205». */
const maskAccount = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? '…' + digits.slice(-4) : ''
}

// Поля, которые нельзя записывать ни при каких условиях
const FORBIDDEN = /^(password|pass|key|firstkey|secondkey|code|token|secret|authorization)$/i

/** Убрать из подробностей всё чувствительное, счета — замаскировать. */
function sanitize(details) {
  if (!details || typeof details !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN.test(k)) continue
    if (/account/i.test(k)) { out[k] = maskAccount(v); continue }
    if (v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v
  }
  return out
}

/**
 * Записать событие.
 * @param {string} event  что произошло, например 'sign.key' или 'transfer.create'
 * @param {'ok'|'error'|'info'} result чем закончилось
 * @param {object} details подробности без секретов
 */
function audit(event, result = 'info', details = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    result,
    ...sanitize(details),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()

  // Одной строкой JSON: так запись легко найти и разобрать в логах хостинга
  const line = JSON.stringify(entry)
  console.log('[audit] ' + line)

  // И в файл — чтобы журнал пережил перезапуск сервиса
  if (fileReady) {
    try {
      fs.appendFileSync(AUDIT_FILE, line + '\n', 'utf8')
      rotateIfNeeded()
    } catch (e) {
      fileReady = false
      console.warn('[audit] запись в файл отключена:', e.message)
    }
  }
  return entry
}

/** Последние события, свежие сверху. */
function auditTail(limit = 200) {
  return entries.slice(-limit).reverse()
}

module.exports = { audit, auditTail, maskAccount }
