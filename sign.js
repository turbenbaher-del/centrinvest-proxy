// Подпись документов — тем же путём, что и веб-версия банка: ЧЕРЕЗ ЕГО ФОРМЫ.
//
// Почему переписано. Раньше сервис подписывал через REST-конвейер
// prepareSign → continueSign. У этого клиента банк такой конвейер не ведёт:
// весь документооборот живёт на серверных формах (r030contragent, mixedDoc), и
// код, отправленный в continueSign, попадал в чужую транзакцию — банк отвечал
// «Введен неверный пароль» на заведомо верный ключ с токена, а платёж не
// доходил до отправки.
//
// Порядок веб-версии (снят с живого банка 12.08.2026, docs/СВЕРКА-С-ВЕБ-ВЕРСИЕЙ.md,
// имена форм сверены с исходниками фронта bss-front-d2sme, app/forms/*/instanceName.js):
//
//   1) действие подписи на документе          — «Подписать и отправить»
//        список:  PUT ui/mixedDoc/out/<вкладка>/doAction {actionId:'_sign'}
//        форма:   PUT ui/rur/payment/<форма>/doAction   {actionId:'_saveAndSign'}
//   2) PUT ui/messages/errorsSave/doAction     — окно «Результаты проверки»
//   3) client/cryptoProfileSelect              — выбор средства подписи
//        stateUpdate cryptoProfiles → doAction _save
//   4) client/eTokenPassSign[/confirm]         — ключ с токена (подтверждающая)
//        stateUpdate key → doAction ready
//   5) client/smsSign[/confirm]                — одноразовый пароль (основная)
//        stateUpdate password → doAction sign
//      либо client/paycontrol/sign             — подтверждение в PayControl
//        stateUpdate confirmCode → doAction sign
//   6) client/signResult                       — итог: сколько подписано и
//        сколько к отправке; doAction send отправляет документы в банк
//
// Шаги идут не жёсткой лестницей: банк сам решает, что показать следующим —
// поэтому здесь не сценарий, а разбор того, какую форму он прислал (см. drive).
// Так подпись стала общей для ВСЕХ типов документов, а не только для платежей.
//
// Что делает человек, а что сервис: ключ с токена, код из СМС и подтверждение
// в PayControl вводит только владелец. Сервис ничего не подписывает сам —
// он лишь доносит введённое до нужной формы банка.

const {
  ensureLoggedIn, bankApi, bankBinary, pickConfirmAction, collectMessages,
  waitForAppReady, DOC_STATE_NAMES, SIGN_MODULE,
} = require('./browser')

// ─── Куда стучаться ───────────────────────────────────────────────────────────

// Раздел «Мои документы»: в нём лежат документы всех типов, а не только платежи
const MENU_MIXED = 'corporate-api-menu-small-mixed-doc'
const MIXED_FORM = 'ui/mixedDoc'
const MIXED_GRID = 'mixedDocs'
// Вкладки, где документ ещё можно подписать. Идентификаторы вкладок — из живого
// банка (СВЕРКА-С-ВЕБ-ВЕРСИЕЙ.md), имена форм — из исходников веб-версии.
const SIGNABLE_TABS = [
  { key: 'partlySigned', ext: 'mixedDocOutPartlySigned', form: 'ui/mixedDoc/out/partlySigned' },
  { key: 'draft',        ext: 'mixedDocOutDraft',        form: 'ui/mixedDoc/out/draft' },
]

// Формы-диалоги подписи. Имена приходят и с префиксом (ui/…), и без него —
// поэтому сверяем по хвосту, а не на равенство.
const RE = {
  errorsSave:   /errorsSave$/,
  cryptoSelect: /client\/cryptoProfileSelect$/,
  eToken:       /client\/eTokenPassSign(\/confirm)?$/,
  eTokenSync:   /client\/eTokenPassSynchronize$/,
  sms:          /client\/smsSign(\/confirm)?$/,
  payControl:   /client\/paycontrol\/(sign|confirmSign)$/,
  signResult:   /client\/signResult$/,
  confirm:      /confirmDialog$/,
  inform:       /informDialog$/,
  error:        /errorDialog$/,
}

// Окна подписи, которые могли остаться открытыми от брошенной попытки
const STRAY_DIALOGS = [RE.eToken, RE.eTokenSync, RE.sms, RE.payControl, RE.cryptoSelect, RE.signResult]

// Состояния документа, при которых он уже ушёл в банк
const SENT_STATES = ['delivered', 'accepted', 'inProcess', 'processed', 'sentToABS', 'acceptedByABS']

const MAX_CHAIN_STEPS = 12          // защита от кругов в диалогах банка
const MAX_PAGES = 10                // вкладка: 50 строк сразу, дальше по 20
const PAYCONTROL_TIMEOUT_MS = 10 * 60 * 1000
const STALE_MS = 30 * 60 * 1000     // после этого начатая подпись считается брошенной

// Начатые подписи: id документа → что банк спросил и куда слать ответ.
// Состояние живёт в памяти процесса: перезапуск сервиса и так разлогинивает ДБО.
const pending = new Map()

// ─── Мелкие помощники ─────────────────────────────────────────────────────────

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
const text = (f) => {
  const v = plain(f)
  return typeof v === 'string' ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : (v == null ? '' : String(v))
}

/** Последняя подходящая форма в ответе банка: у прежней токен уже мёртв. */
const lastForm = (cmds, re) => [...(cmds || [])].reverse()
  .find(c => c.command !== 'formClose' && re.test(c.instanceName || '') && c.instanceToken)

/** Жёсткие ошибки полей — банк отказал по существу. */
const fieldErrors = (cmds) => (cmds || [])
  .flatMap(c => Object.entries(c.fields || {}))
  .flatMap(([id, f]) => (f?.errors || []).map(e => `${id}: ${e?.message || e}`))

/** Число из параметров формы, как бы банк его ни назвал. */
const numParam = (params, ...names) => {
  for (const n of names) {
    const v = Number(params?.[n])
    if (Number.isFinite(v)) return v
  }
  return undefined
}

/** Опознать средство подписи по человекочитаемому названию банка. */
const kindOf = (t) => /etoken/i.test(t) ? 'etoken'
  : /paycontrol/i.test(t) ? 'payControl'
    : /sms|onetimepassword|otp|одноразов/i.test(t) ? 'otp' : 'other'

const labelOf = (kind, fallback = '') => kind === 'etoken' ? 'Ключ с токена eToken'
  : kind === 'payControl' ? 'Подтверждение в PayControl'
    : kind === 'otp' ? 'Одноразовый пароль (СМС)' : (fallback || 'Средство подписи')

const stateRu = (s) => DOC_STATE_NAMES[s] || s || 'неизвестно'

/**
 * Дождаться, пока у сессии появится токен банка.
 *
 * Дешёвая проверка: спрашиваем банк о чём-то безобидном. Не ответил из-за
 * отсутствия токена — ждём отрисовки интерфейса (тогда страница сама сходит в
 * банк и токен поймается) и пробуем ещё раз.
 */
async function ensureToken(p) {
  try {
    await bankApi(p, 'GET', '/api/v1/client/user', null)
    return
  } catch (e) {
    if (!/токен сессии/i.test(e.message)) return   // другая беда — пусть всплывёт на своём шаге
  }
  console.log('[sign] токен сессии ещё не пойман — жду интерфейс банка')
  await waitForAppReady(p, 45000)
}

/** Забытые подписи не должны копиться в памяти: банк их всё равно уже закрыл. */
function sweepStale() {
  const now = Date.now()
  for (const [key, pend] of pending) {
    if (now - (pend.startedAt || 0) > STALE_MS) pending.delete(key)
  }
}

async function doAction(p, form, actionId, extra = {}) {
  return bankApi(p, 'PUT', `/api/v1/${form.instanceName}/doAction`, {
    instanceToken: form.instanceToken, actionId, ...extra,
  })
}

async function setField(p, form, name, value) {
  return bankApi(p, 'PUT', `/api/v1/${form.instanceName}/stateUpdate`, {
    instanceToken: form.instanceToken,
    rowId: null,
    submitField: name,
    fields: { [name]: { value } },
  })
}

/** Действие формы по идентификатору или по подписи кнопки. */
function actionOf(form, ids = [], labelRe = null) {
  const acts = form?.actions || {}
  for (const id of ids) if (acts[id] && acts[id].disabled !== true) return id
  if (labelRe) {
    const hit = Object.entries(acts).find(([, a]) => a && a.disabled !== true && labelRe.test(String(a.label || '')))
    if (hit) return hit[0]
  }
  return null
}

// ─── Чем можно подписать ──────────────────────────────────────────────────────

/**
 * Средства подписи документа — для показа выбора ДО начала подписи.
 *
 * Список берётся чтением (`getUserCryptoProfiles`) и попытку ввода ключа не
 * расходует. Это подсказка приложению; окончательный выбор всё равно делает
 * форма банка `client/cryptoProfileSelect`, поэтому пустой ответ подпись не
 * ломает — раньше здесь бросалась ошибка «нет прав подписи», и человек не мог
 * даже открыть карточку.
 */
async function signMeans(username, password, { id, module = SIGN_MODULE } = {}) {
  if (!id) throw new Error('не передан id документа')
  const p = await ensureLoggedIn(username, password)

  let list = []
  try {
    const r = await bankApi(p, 'POST', `/api/v1/${module}/getUserCryptoProfiles`, { ids: [String(id)] })
    list = r.json?.cryptoProfiles || r.json?.data?.cryptoProfiles || []
  } catch (e) {
    console.warn('[sign] список средств подписи не получен:', e.message)
  }

  const describe = (x) => {
    const kind = kindOf(String(x.typeName || ''))
    return {
      id: x.id,
      typeName: String(x.typeName || ''),
      kind,
      label: labelOf(kind, String(x.typeName || '')),
      confirming: x.signAuthorityTypeCode === 'CONFIRM' && !!x.signConfirm,
    }
  }
  const confirming = list.filter(x => x.signAuthorityTypeCode === 'CONFIRM' && x.signConfirm).map(describe)
  const main = list.filter(x => x.signAuthorityTypeCode !== 'CONFIRM' || !x.signConfirm).map(describe)
  console.log('[sign] средства подписи:', [...confirming, ...main].map(m => m.typeName).join(', ') || '—')

  return {
    confirming,
    main,
    recommended: {
      confirmProfileId: (confirming.find(m => m.kind === 'etoken') || confirming[0])?.id || null,
      mainProfileId: (main.find(m => m.kind === 'payControl') || main[0])?.id || null,
    },
  }
}

// ─── Начало подписи ───────────────────────────────────────────────────────────

/**
 * Найти документ в «Моих документах» и нажать «Подписать».
 *
 * Вкладку выбирает банк: сперва «На подпись», затем «Черновики» — там лежит
 * всё, что ещё можно подписать. Строка грида отмечается значением самого поля
 * грида (массив id) вместе с действием — так это делает веб-версия
 * (BulkActionStrategy в её исходниках), а не галочкой в строке.
 */
async function openSignAction(p, id) {
  // Незакрытый диалог от прошлой попытки держит всю сессию: банк отвечает на
  // переход не разделом, а тем же окном ввода ключа. Гасим и открываем заново —
  // это отказ от брошенной подписи, ничего в банке он не создаёт.
  let open = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem: MENU_MIXED })
  for (let i = 0; i < 2; i++) {
    const stray = STRAY_DIALOGS.map(re => lastForm(open.json?.commands || [], re)).find(Boolean)
    if (!stray) break
    console.log('[sign] от прошлой попытки висело окно', stray.instanceName, '— закрываю')
    await doAction(p, stray, '_close', { fields: {} }).catch(() => null)
    open = await bankApi(p, 'POST', '/api/v1/menu/click', { menuItem: MENU_MIXED })
  }

  let cmds = open.json?.commands || []
  const root = lastForm(cmds, new RegExp(`${MIXED_FORM}$`))
  if (!root) throw new Error('банк не открыл раздел «Мои документы»')

  for (const tab of SIGNABLE_TABS) {
    let form = lastForm(cmds, new RegExp(`${tab.form}$`))
    if (!form) {
      const sw = await doAction(p, root, '_switchForm_mainFormSwitcher', { extActionId: tab.ext })
      cmds = sw.json?.commands || []
      form = lastForm(cmds, new RegExp(`${tab.form}$`))
    }
    if (!form) continue

    // Банк отдаёт вкладку страницами (первая — 50 строк, дальше по 20), поэтому
    // документ может лежать глубже. Догружаем, пока он не найдётся или пока
    // строки не перестанут прибавляться. Строки копим сами: при «Показать ещё»
    // банк присылает уже показанные одним id, без содержимого.
    const seen = new Map()
    let row = null
    for (let page = 0; page < MAX_PAGES; page++) {
      for (const it of (form.fields?.[MIXED_GRID]?.items || [])) {
        const rid = String(plain(it.id) ?? '')
        if (!rid) continue
        seen.set(rid, { ...(seen.get(rid) || {}), ...it })
      }
      row = seen.get(String(id)) || null
      if (row) break

      const more = actionOf(form, ['loadMore'], /показать ещё|ещё/i)
      if (!more) break
      const before = seen.size
      const res = await doAction(p, form, more, { fields: {} })
      form = lastForm(res.json?.commands || [], new RegExp(`${tab.form}$`)) || form
      const grew = (form.fields?.[MIXED_GRID]?.items || [])
        .some(it => !seen.has(String(plain(it.id) ?? '')))
      if (!grew && seen.size === before) break
    }
    if (!row) continue
    console.log(`[sign] вкладка ${tab.key}: просмотрено строк ${seen.size}`)

    // Банк сам говорит, можно ли подписывать эту строку. Восемь поручений СБП,
    // например, висят «На подпись», но подпись у них запрещена.
    if (row.actions && row.actions.sign === false) {
      throw new Error('банк не даёт подписать этот документ (подпись недоступна)')
    }
    const actionId = actionOf(form, ['_sign'], /^подпис/i)
    if (!actionId) throw new Error(`во вкладке «${tab.key}» нет действия подписи`)

    console.log('[sign] документ найден во вкладке', tab.key, '| нажимаю', actionId)
    const res = await doAction(p, form, actionId, {
      fields: { [MIXED_GRID]: { value: [String(id)] } },
      rowId: String(id),
      ids: [String(id)],
    })
    return { res, tab: tab.key, doc: row }
  }

  throw new Error('документ не найден среди тех, что ещё можно подписать — возможно, он уже подписан или отклонён')
}

/**
 * Шаг 1: отправить документ на подпись и дойти до первого вопроса банка.
 * Дальше банк сам ведёт: ключ токена, код из СМС или подтверждение PayControl.
 */
async function signStart(username, password, { id, confirmProfileId = '', mainProfileId = '' } = {}) {
  if (!id) throw new Error('не передан id документа')
  const p = await ensureLoggedIn(username, password)
  // Токен сессии банка ловится из запросов самой страницы. Если подпись —
  // первое обращение после входа, его может ещё не быть: тогда ждём, пока
  // интерфейс отрисуется, и только после этого начинаем.
  await ensureToken(p)
  sweepStale()

  // Пожелания человека по средствам подписи. Идентификаторы из
  // getUserCryptoProfiles и из выпадающего списка формы могут не совпадать,
  // поэтому запоминаем ещё и ВИД средства — по нему выбор найдётся всегда.
  const prefer = { confirmId: confirmProfileId || '', mainId: mainProfileId || '', confirmKind: '', mainKind: '' }
  if (confirmProfileId || mainProfileId) {
    try {
      const means = await signMeans(username, password, { id })
      const all = [...means.confirming, ...means.main]
      prefer.confirmKind = all.find(m => m.id === confirmProfileId)?.kind || ''
      prefer.mainKind = all.find(m => m.id === mainProfileId)?.kind || ''
    } catch { /* подсказка необязательна */ }
  }

  pending.set(String(id), { prefer, selects: 0, startedAt: Date.now(), messages: [] })

  let started
  try {
    started = await openSignAction(p, id)
  } catch (e) {
    // Не начали — не оставляем висеть запись о начатой подписи: иначе следующий
    // опрос состояния решит, что подпись идёт, и будет ждать несуществующее.
    pending.delete(String(id))
    throw e
  }
  const pend = pending.get(String(id))
  if (pend) pend.docDesc = text(started.doc?.description) || text(started.doc?.name)
  return drive(p, id, started.res)
}

// ─── Разбор того, что прислал банк ────────────────────────────────────────────

/**
 * Пройти по диалогам банка, пока он не спросит человека или не закончит.
 *
 * Возвращает приложению один из шагов: needKey (ключ токена или код из СМС),
 * confirm (подтверждение в PayControl), sync (синхронизация токена), done,
 * signed (подписан, но не отправлен) или error.
 */
async function drive(p, id, response) {
  const key = String(id)
  const pend = pending.get(key) || {}
  let r = response

  for (let step = 0; step < MAX_CHAIN_STEPS; step++) {
    const cmds = r.json?.commands || []
    console.log('[sign] банк прислал:', cmds.map(c => `${c.command}:${c.instanceName}`).join(', ') || '(пусто)')

    // Отказ по существу — дальше идти незачем
    const err = lastForm(cmds, RE.error)
    if (err) {
      pending.delete(key)
      return { stage: 'error', errors: [collectMessages(err) || 'банк отклонил подпись'] }
    }
    const hard = fieldErrors(cmds.filter(c => !RE.sms.test(c.instanceName || '') && !RE.eToken.test(c.instanceName || '')))
    if (hard.length) {
      pending.delete(key)
      return { stage: 'error', errors: hard }
    }

    // Окно «Результаты проверки» (проверка контрагента) — это предупреждение,
    // а не отказ: нажимаем «Продолжить» его же кнопкой.
    const es = lastForm(cmds, RE.errorsSave)
    if (es) {
      const said = collectMessages(es)
      if (said) { pend.messages = [...(pend.messages || []), said]; console.log('[sign] банк предупреждает:', said.slice(0, 200)) }
      r = await doAction(p, es, pickConfirmAction(es), { fields: {} })
      continue
    }

    // Выбор средства подписи
    const sel = lastForm(cmds, RE.cryptoSelect)
    if (sel) { r = await chooseProfile(p, sel, pend); continue }

    // Ключ с токена eToken
    const et = lastForm(cmds, RE.eToken)
    if (et) return askUser(key, pend, et, {
      field: 'key', action: actionOf(et, ['ready'], /^подпис/i) || 'ready',
      kind: 'etoken', stage: 'needKey',
    })

    // Синхронизация токена: попытки кончились, банк просит два ключа подряд
    const sync = lastForm(cmds, RE.eTokenSync)
    if (sync) {
      pend.form = { instanceName: sync.instanceName, instanceToken: sync.instanceToken }
      pend.stage = 'sync'
      pend.action = actionOf(sync, ['ready'], /^подпис|синхрон/i) || 'ready'
      pending.set(key, pend)
      return {
        stage: 'sync',
        serial: text(sync.fields?.serialNumber) || pend.serial || '',
        errors: [errorOf(sync)].filter(Boolean),
      }
    }

    // Одноразовый пароль из СМС
    const sms = lastForm(cmds, RE.sms)
    if (sms) return askUser(key, pend, sms, {
      field: 'password', action: actionOf(sms, ['sign'], /^подпис/i) || 'sign',
      kind: 'otp', stage: 'needKey',
    })

    // Подтверждение в PayControl
    const pc = lastForm(cmds, RE.payControl)
    if (pc) return await askPayControl(p, key, pend, pc)

    // Итог подписи: банк говорит, сколько подписано и сколько готово к отправке
    const sr = lastForm(cmds, RE.signResult)
    if (sr) {
      const failed = Number(text(sr.fields?.failed) || 0)
      const toSend = Number(text(sr.fields?.toSend) || 0)
      const success = Number(text(sr.fields?.success) || 0)
      console.log(`[sign] итог банка: подписано ${success}, не удалось ${failed}, к отправке ${toSend}`)
      const send = actionOf(sr, ['send'], /^отправ/i)
      if (send && toSend > 0) { r = await doAction(p, sr, send, { fields: {} }); continue }
      if (failed > 0 && success === 0) {
        pending.delete(key)
        return { stage: 'error', errors: [collectMessages(sr) || 'банк не подписал документ'] }
      }
      const close = actionOf(sr, ['_close'], /закр/i)
      if (close) { r = await doAction(p, sr, close, { fields: {} }); continue }
      break
    }

    // Итоговое подтверждение и сообщения банка
    const dlg = lastForm(cmds, RE.confirm) || lastForm(cmds, RE.inform)
    if (dlg) {
      const said = collectMessages(dlg)
      if (said) { pend.messages = [...(pend.messages || []), said]; console.log('[sign] банк сообщает:', said.slice(0, 200)) }
      const go = pickConfirmAction(dlg)
      r = await doAction(p, dlg, go, { fields: {} })
      continue
    }

    break
  }

  return finish(p, key, pend)
}

/** Текст ошибки, который форма подписи возвращает при неверном коде. */
function errorOf(form) {
  const fromParams = String(form?.params?.errorMessage || '').trim()
  if (fromParams) return fromParams
  const fromFields = Object.values(form?.fields || {})
    .flatMap(f => (f?.errors || []).map(e => e?.message || e))
    .map(s => String(s || '').trim()).filter(Boolean)
  return fromFields[0] || ''
}

/** Форма ждёт ввода от человека — запоминаем, куда слать ответ. */
function askUser(key, pend, form, { field, action, kind, stage }) {
  const problem = errorOf(form)
  pend.form = { instanceName: form.instanceName, instanceToken: form.instanceToken }
  pend.field = field
  pend.action = action
  pend.kind = kind
  pend.stage = stage
  pend.serial = text(form.fields?.serial) || pend.serial || ''
  pend.docDesc = text(form.fields?.docDesc) || pend.docDesc || ''
  // Сколько попыток осталось — банк кладёт это в параметры формы под разными
  // именами. Не нашлось — не выдумываем, приложение просто не покажет число.
  const attempts = numParam(form.params, 'attemptsLeft', 'remainingAttempts', 'maxAttempts', 'attempts')
  if (attempts !== undefined) pend.attemptsLeft = attempts
  pending.set(key, pend)

  console.log(`[sign] банк ждёт: ${kind === 'otp' ? 'код из СМС' : 'ключ с токена'} (${form.instanceName})`,
    problem ? '| прошлый ответ отклонён: ' + problem : '')

  return {
    stage,
    serial: pend.serial,
    attempts: pend.attemptsLeft,
    docDesc: pend.docDesc || undefined,
    mean: { kind, label: labelOf(kind) },
    // Телефон и срок жизни кода — это слова банка, человеку они помогают
    phone: form.params?.phoneNumber || undefined,
    timeToLive: numParam(form.params, 'timeToLive'),
    errors: problem ? [problem] : [],
  }
}

/** PayControl: подтверждение приходит на телефон, код можно ввести и руками. */
async function askPayControl(p, key, pend, form) {
  pend.form = { instanceName: form.instanceName, instanceToken: form.instanceToken }
  pend.field = 'confirmCode'
  pend.action = actionOf(form, ['sign'], /^подтверд|^подпис/i) || 'sign'
  pend.kind = 'payControl'
  pend.stage = 'payControl'
  pend.docDesc = text(form.fields?.docDesc) || pend.docDesc || ''
  pend.startedAt = pend.startedAt || Date.now()
  pending.set(key, pend)

  const problem = errorOf(form)
  console.log('[sign] банк ждёт подтверждения в PayControl', problem ? '| ' + problem : '')

  return {
    stage: 'confirm',
    confirmType: 'payControl',
    qrCode: await qrOf(p, form),
    attempts: numParam(form.params, 'confirmAttempts', 'attemptsLeft'),
    docDesc: pend.docDesc || undefined,
    errors: problem ? [problem] : [],
    message: 'Подтвердите операцию в приложении PayControl на телефоне',
  }
}

/**
 * QR банка для PayControl. В форме он лежит куском HTML — либо готовой
 * base64-картинкой, либо ссылкой на файл внутри контура. Ссылку приложение
 * открыть не может (чужой домен и ГОСТ-TLS), поэтому забираем байты сами.
 */
async function qrOf(p, form) {
  const raw = String(plain(form.fields?.qrCode) || '')
  if (!raw) return undefined
  const src = (/src="([^"]+)"/i.exec(raw) || [])[1] || raw
  if (/^data:/i.test(src)) return src
  if (/^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 100) return 'data:image/gif;base64,' + src.replace(/\s/g, '')
  try {
    const path = src.startsWith('/') ? src : '/api-ui/' + src.replace(/^\.?\//, '')
    const { buffer, contentType } = await bankBinary(p, path)
    return `data:${contentType || 'image/png'};base64,` + buffer.toString('base64')
  } catch (e) {
    console.warn('[sign] QR PayControl не забрался:', e.message)
    return undefined
  }
}

/** Выбор средства подписи в форме банка. */
async function chooseProfile(p, form, pend) {
  const items = form.fields?.cryptoProfiles?.items || []
  const named = items.map(it => ({
    id: it.id,
    label: String(it.values?.[0] ?? it.label ?? it.name ?? ''),
  }))
  console.log('[sign] банк предлагает средства:', named.map(i => i.label).join(' | ') || '(пусто)')
  if (!named.length) throw new Error('банк не предложил ни одного средства подписи')

  // Первый выбор банк спрашивает под основную подпись, следующий — под
  // подтверждающую. Сначала пробуем то, что выбрал человек: по идентификатору,
  // затем по виду средства. Не совпало — берём первое из предложенных банком.
  const first = (pend.selects || 0) === 0
  const wantId = first ? pend.prefer?.mainId : pend.prefer?.confirmId
  const wantKind = first ? pend.prefer?.mainKind : pend.prefer?.confirmKind
  const chosen = (wantId && named.find(i => i.id === wantId))
    || (wantKind && named.find(i => kindOf(i.label) === wantKind))
    || named[0]
  pend.selects = (pend.selects || 0) + 1

  console.log('[sign] выбираю:', chosen.label)
  await setField(p, form, 'cryptoProfiles', chosen.id)
  const go = actionOf(form, ['_save'], /далее|продолж|подпис|ок/i) || '_save'
  return doAction(p, form, go, { fields: { cryptoProfiles: { value: chosen.id } } })
}

// ─── Ввод от человека ─────────────────────────────────────────────────────────

/**
 * Ключ с токена, код из СМС или код подтверждения PayControl — в ту форму,
 * которая его ждёт. Раньше код уходил в continueSign, и банк отвечал
 * «Введен неверный пароль» даже на верный.
 */
async function signSubmitKey(username, password, { id, key }) {
  if (!key) throw new Error('не передан код подтверждения')
  const pend = pending.get(String(id))
  if (!pend?.form) throw new Error('подпись не начата или истекла — начните заново')
  const p = await ensureLoggedIn(username, password)

  await setField(p, pend.form, pend.field, String(key))
  const r = await doAction(p, pend.form, pend.action, {
    fields: { [pend.field]: { value: String(key) } },
  })
  return drive(p, id, r)
}

/**
 * Синхронизация токена eToken PASS: попытки ввода исчерпаны, и банк просит два
 * ключа подряд, чтобы заново совпасть со счётчиком устройства. Если и они не
 * подойдут — доступ блокируется, поэтому шаг делает только человек.
 */
async function signSyncToken(username, password, { id, firstKey, secondKey }) {
  if (!firstKey || !secondKey) throw new Error('нужны оба ключа с токена')
  const pend = pending.get(String(id))
  if (!pend?.form || pend.stage !== 'sync') throw new Error('синхронизация не запрошена — начните подпись заново')
  const p = await ensureLoggedIn(username, password)

  await setField(p, pend.form, 'first', String(firstKey))
  await setField(p, pend.form, 'second', String(secondKey))
  const r = await doAction(p, pend.form, pend.action || 'ready', {
    fields: { first: { value: String(firstKey) }, second: { value: String(secondKey) } },
  })
  return drive(p, id, r)
}

// ─── Ожидание и завершение ────────────────────────────────────────────────────

/**
 * Опрос подтверждения PayControl.
 *
 * Веб-версия узнаёт о подтверждении событием по вебсокету — через сервис его
 * не поймать. Поэтому смотрим самый надёжный признак: состояние документа в
 * банке. Пока оно не сдвинулось, подтверждения нет.
 */
async function signStatus(username, password, { id }) {
  const key = String(id)
  const pend = pending.get(key)
  if (!pend) throw new Error('подпись не начата или истекла — начните заново')
  if (pend.stage !== 'payControl') {
    return { stage: pend.stage === 'sync' ? 'sync' : 'needKey', serial: pend.serial || '' }
  }

  const p = await ensureLoggedIn(username, password)
  const state = await docState(p, id)
  console.log('[sign] состояние документа:', state || '—')

  if (state && state !== 'new' && state !== 'partlySigned') return finish(p, key, pend, state)

  if (Date.now() - (pend.startedAt || 0) > PAYCONTROL_TIMEOUT_MS) {
    await closeForm(p, pend)
    pending.delete(key)
    return { stage: 'error', errors: ['Подтверждение в PayControl не пришло за 10 минут — начните подпись заново'] }
  }

  return { stage: 'confirm', confirmType: 'payControl', message: 'Ждём подтверждения в PayControl' }
}

/** Отмена начатой подписи: закрываем открытый диалог банка, чтобы не висел. */
async function signCancel(username, password, { id }) {
  const pend = pending.get(String(id))
  if (!pend) return { cancelled: false }
  pending.delete(String(id))
  try {
    const p = await ensureLoggedIn(username, password)
    await closeForm(p, pend)
  } catch (e) {
    console.warn('[sign] отмена в банке не прошла:', e.message)
  }
  return { cancelled: true }
}

async function closeForm(p, pend) {
  if (!pend?.form) return
  await doAction(p, pend.form, '_close', { fields: {} }).catch(() => null)
}

/** Состояние документа по списку банка — правда о том, чем кончилась подпись. */
async function docState(p, id) {
  try {
    const r = await bankApi(p, 'GET', `/api/v1/${SIGN_MODULE}/list?_offset=0&_limit=300`, null)
    const list = r.json?.list || r.json?.data?.list || []
    return list.find(x => String(x.id) === String(id))?.state
  } catch (e) {
    console.warn('[sign] не удалось прочитать состояние документа:', e.message)
    return undefined
  }
}

/**
 * Чем кончилось. Врать здесь опаснее всего: «отправлено» на неотправленном
 * документе человек прочтёт как ушедшие деньги, а «не вышло» на отправленном —
 * повторит платёж. Поэтому итог берём из состояния документа у банка.
 */
async function finish(p, key, pend, known) {
  const state = known || await docState(p, key)
  // Попутные слова банка (предупреждение проверки контрагента, «документы
  // отправлены») — это ПОЯСНЕНИЕ, а не приговор. Смешивать их с итогом нельзя:
  // тогда отказ подписывается фразой «Документы отправлены в банк».
  const said = (pend?.messages || []).filter(Boolean).join('. ')
  const notice = said || undefined
  pending.delete(key)

  if (!state) {
    // Документ не из рублёвых платёжек (письмо, заявка) — его состояния в этом
    // списке нет. Итог берём из слов банка, ничего не додумывая.
    return { stage: 'done', message: 'Банк принял подпись', notice }
  }
  if (SENT_STATES.includes(state)) {
    return { stage: 'done', message: 'Документ подписан и отправлен в банк', notice }
  }
  if (state === 'signed') {
    return { stage: 'signed', message: 'Документ подписан, но не отправлен', notice }
  }
  if (state === 'partlySigned') {
    return { stage: 'signed', message: 'Документ подписан частично — банк ждёт вторую подпись', notice }
  }
  if (state === 'new') {
    return {
      stage: 'error',
      errors: ['Банк не подписал документ — он остался черновиком' + (said ? '. Банк сообщил: ' + said : '')],
    }
  }
  return { stage: 'error', errors: ['Банк не принял документ: ' + stateRu(state) + (said ? '. ' + said : '')] }
}

module.exports = { signMeans, signStart, signSubmitKey, signSyncToken, signStatus, signCancel }
