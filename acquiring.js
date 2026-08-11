// Эквайринг: терминалы, отчёты и документы.
//
// Раздел живёт не в REST-списках, а в форменном протоколе банка. Порядок такой,
// каким его делает веб-версия:
//   1) POST /api/v1/menu/click            — открывает раздел, приходит форма
//      ui/acquiringMainForm со свитчером на 26 вкладок и форма вкладки по умолчанию;
//   2) PUT  /api/v1/ui/acquiringMainForm/doAction
//      { actionId: '_switchForm_acquiringMainFormSwitcher', extActionId: <вкладка> }
//      — именно doAction с extActionId, а НЕ stateUpdate по полю свитчера:
//      stateUpdate банк принимает молча и формы вкладки не присылает;
//   3) PUT  /api/v1/<форма вкладки>/doAction { actionId: 'applyFilter', fields }
//      — без этого отчёты пусты: банк по умолчанию ставит период «сегодня»;
//   4) PUT  … { actionId: 'loadMore' } — следующая страница; банк возвращает
//      весь накопленный грид целиком, а не только добавку.
const { callBankApi } = require('./browser')

const MENU_ITEM = 'corporate-api-menu-small-acquiring-docs'
const MAIN_FORM = 'ui/acquiringMainForm'
const SWITCHER = 'acquiringMainFormSwitcher'

// Вкладки, которые показывает приложение. `tab` — идентификатор в свитчере
// банка, `grid` — поле формы со строками. Названия форм банк выбирает сам,
// поэтому опираемся только на имя грида.
const TABS = {
  terminals:    { tab: 'terminals',              title: 'Терминалы',              grid: 'acquiringTerminals',   dated: false },
  payments:     { tab: 'reportPayments',         title: 'Платежи',                grid: 'acquiringPayments',    dated: true },
  transactions: { tab: 'reportTransactions',     title: 'Операции',               grid: 'acquiringTransactions', dated: true },
  sbp:          { tab: 'reportDocSBPOperations', title: 'Переводы по СБП',        grid: 'acquiringSBPOperations', dated: true },
  refunds:      { tab: 'refundsTransactions',    title: 'Возвраты',               grid: 'acqRefTran',           dated: true },
  acts:         { tab: 'acts',                   title: 'Счета и акты',           grid: 'messages',             dated: true },
  services:     { tab: 'addServiceCompleted',    title: 'Дополнительные услуги',  grid: 'acqAppServOneTimeReq', dated: true },
  termreq:      { tab: 'addTermReq',             title: 'Заявки на терминал',     grid: 'acqAddTermReq',        dated: true },
}

// Служебные поля строк грида: приложению они не нужны и только мешают.
const ROW_JUNK = new Set(['visible', 'selected', 'actions', 'disabled', 'errors', 'hint', 'style'])

const PAGE_MAX = 6            // сколько раз готовы просить «ещё» у банка
const LIMIT_DEFAULT = 50
const LIMIT_MAX = 300

/** Разворачиваем {value: …} и выкидываем служебное. */
function cleanRow(row) {
  const out = {}
  for (const [k, v] of Object.entries(row || {})) {
    if (ROW_JUNK.has(k)) continue
    const val = (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
    if (val === null || val === undefined || typeof val === 'object') continue
    out[k] = val
  }
  return out
}

/** Заголовки колонок, как их называет банк, — чтобы не выдумывать свои. */
function columnsOf(field) {
  return (field?.columns || [])
    .filter(c => c.visible && c.id !== 'selected')
    .map(c => ({ id: c.id, label: c.label || c.id, type: String(c.type || '').toLowerCase() }))
}

// Форму ищем с конца: банк на каждое переключение закрывает старую и открывает
// новую с тем же именем, но новым токеном. Первая подходящая — просроченная,
// и запросы с её токеном банк молча оставляет без данных.
const lastForm = (cmds, ok) => [...cmds].reverse().find(c => c.command === 'formInit' && ok(c))

/**
 * Данные вкладки эквайринга.
 *
 * @param {{login: string, password: string}} creds
 * @param {object} opts key — ключ из TABS; from/to — период (YYYY-MM-DD);
 *                     search — строка поиска; limit — сколько строк максимум.
 */
async function getAcquiring(creds, { key = 'terminals', from = '', to = '', search = '', limit = LIMIT_DEFAULT } = {}) {
  const spec = TABS[key]
  if (!spec) throw new Error('неизвестная вкладка эквайринга: ' + key)
  const want = Math.min(Math.max(Number(limit) || LIMIT_DEFAULT, 1), LIMIT_MAX)
  const call = (method, path, body) => callBankApi(creds.login, creds.password, { method, path, body })

  const open = await call('POST', '/api/v1/menu/click', { menuItem: MENU_ITEM })
  const opened = open.json?.commands || []
  const main = lastForm(opened, c => c.instanceName === MAIN_FORM)
  if (!main) throw new Error('банк не открыл раздел эквайринга')

  // Список вкладок отдаёт сам банк — приложение рисует меню по нему, а не по
  // зашитому списку: у разных клиентов набор услуг разный.
  const switcher = main.fields?.[SWITCHER]
  const tabs = (switcher?.items || [])
    .filter(i => i.visible)
    .map(i => ({ id: i.id, label: i.label, parentId: i.parentId || null }))

  const sw = await call('PUT', `/api/v1/${MAIN_FORM}/doAction`, {
    instanceToken: main.instanceToken,
    actionId: `_switchForm_${SWITCHER}`,
    extActionId: spec.tab,
  })
  const switched = sw.json?.commands || []

  const err = [...opened, ...switched].find(c => /errorDialog/.test(c.instanceName || ''))
  if (err) throw new Error(String(err.fields?.message?.value || err.fields?.message || 'раздел недоступен'))

  // Форма вкладки — та, в которой есть нужный грид.
  const form = lastForm(switched, c => c.instanceName !== MAIN_FORM && Array.isArray(c.fields?.[spec.grid]?.items))
    || lastForm(opened, c => c.instanceName !== MAIN_FORM && Array.isArray(c.fields?.[spec.grid]?.items))
  if (!form) throw new Error(`банк не прислал вкладку «${spec.title}»`)

  const instance = form.instanceName
  let token = form.instanceToken
  let columns = columnsOf(form.fields[spec.grid])

  // Состав грида — всегда из последнего ответа, а значения полей копим:
  // при подгрузке банк присылает уже показанные строки одним идентификатором,
  // без содержимого, и «жадная» замена оставила бы от них пустые карточки.
  const known = new Map()
  let order = []
  const absorb = (list) => {
    for (const c of list || []) {
      const field = c.fields?.[spec.grid]
      if (!field || !Array.isArray(field.items)) continue
      if (c.instanceToken) token = c.instanceToken
      if (field.columns?.length) columns = columnsOf(field)
      order = field.items.map((it) => {
        const row = { ...(known.get(it?.id) || {}), ...cleanRow(it) }
        if (row.id) known.set(row.id, row)
        return row
      })
    }
  }
  absorb([form])

  // Фильтр: банк ставит период «сегодня», поэтому без applyFilter отчёты пусты.
  const fields = {}
  if (spec.dated && from) fields.dateFrom = { value: from }
  if (spec.dated && to) fields.dateTo = { value: to }
  if (search && form.fields?.search) fields.search = { value: search }
  if (Object.keys(fields).length) {
    const r = await call('PUT', `/api/v1/${instance}/doAction`, { instanceToken: token, actionId: 'applyFilter', fields })
    known.clear()   // фильтр меняет выборку — старые строки к ней отношения не имеют
    absorb(r.json?.commands)
  }

  // «Ещё»: банк отдаёт накопленный грид целиком, а не добавку.
  // Признак «есть ещё» — список продолжал расти, когда мы перестали спрашивать.
  let pages = 0
  let growing = order.length > 0
  while (order.length < want && pages < PAGE_MAX) {
    const before = order.length
    const r = await call('PUT', `/api/v1/${instance}/doAction`, { instanceToken: token, actionId: 'loadMore' })
    absorb(r.json?.commands)
    pages++
    if (order.length <= before) { growing = false; break }
  }

  const rows = order.filter(r => Object.keys(r).length)
  // Упёрлись в собственный потолок — «есть ещё» обещать нельзя: приложение
  // растило limit дальше, получало тот же список и показывало кнопку
  // «Показать ещё», которая ничего не меняла. Говорим об этом отдельным
  // признаком, чтобы экран предложил сузить период, а не жать впустую.
  const capped = want >= LIMIT_MAX && rows.length >= LIMIT_MAX
  return {
    key,
    title: spec.title,
    instanceName: instance,
    dated: spec.dated,
    columns,
    rows: rows.slice(0, want),
    total: Math.min(rows.length, want),
    hasMore: growing && rows.length >= want && !capped,
    capped,
    limitMax: LIMIT_MAX,
    tabs,
  }
}

module.exports = { getAcquiring, ACQUIRING_TABS: TABS }
