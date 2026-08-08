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

const MAX_ENTRIES = 500
const entries = []

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
  console.log('[audit] ' + JSON.stringify(entry))
  return entry
}

/** Последние события, свежие сверху. */
function auditTail(limit = 200) {
  return entries.slice(-limit).reverse()
}

module.exports = { audit, auditTail, maskAccount }
