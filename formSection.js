// Чтение раздела, живущего на ФОРМЕ СО СВИТЧЕРОМ.
//
// Так у банка устроен не только эквайринг: «Счета и платежи», «Мои документы»,
// «Прочие продукты», «Зарплатный проект», депозиты и кредиты — всё это одна и
// та же механика, снятая с живого банка 13.08.2026:
//
//   1) POST /api/v1/menu/click {menuItem}
//        → главная форма раздела со свитчером вкладок (поле *Switcher)
//        и форма вкладки по умолчанию;
//   2) PUT  /api/v1/<главная форма>/doAction
//        {actionId: '_switchForm_<свитчер>', extActionId: <вкладка>}
//        — именно doAction с extActionId: stateUpdate по полю свитчера банк
//        принимает молча и форму вкладки не присылает;
//   3) PUT  /api/v1/<форма вкладки>/doAction {actionId: 'applyFilter', fields}
//        — без периода отчёты пусты: по умолчанию банк ставит «сегодня»;
//   4) PUT  … {actionId: 'loadMore'} — следующая страница.
//
// Две ловушки, стоившие времени на эквайринге и повторённые бы здесь:
//   • форму брать ПОСЛЕДНЮЮ — на каждое переключение банк закрывает старую и
//     открывает новую с тем же именем и новым токеном, запрос со старым токеном
//     молча возвращает пусто;
//   • при loadMore банк присылает уже показанные строки одним идентификатором,
//     без содержимого, поэтому значения полей надо копить по id.
const { callBankApi } = require('./browser')

// Служебные поля строк грида: приложению они не нужны и только мешают.
const ROW_JUNK = new Set(['visible', 'selected', 'actions', 'disabled', 'errors', 'hint', 'style', 'highlighted'])

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

const lastForm = (cmds, ok) => [...(cmds || [])].reverse().find(c => c.command === 'formInit' && ok(c))

/**
 * Имя грида в форме вкладки.
 *
 * Задавать его списком для каждого раздела — значит гадать: у банка их
 * десятки, и имена ничем не связаны с названием вкладки (у счетов на оплату
 * грид называется `items`, у запросов выписок — `statementReq`). Поэтому ищем
 * поле с описанием колонок: грид у банка — единственное, у чего они есть.
 */
function findGrid(form, want = '') {
  const fields = Object.entries(form?.fields || {})
  if (want && Array.isArray(form?.fields?.[want]?.items)) return want
  const withColumns = fields.find(([, f]) => Array.isArray(f?.items) && Array.isArray(f?.columns) && f.columns.length)
  if (withColumns) return withColumns[0]
  // Ни у одного поля нет колонок — берём самый населённый список
  const biggest = fields
    .filter(([, f]) => Array.isArray(f?.items))
    .sort((a, b) => (b[1].items.length - a[1].items.length))[0]
  return biggest?.[0] || ''
}

/**
 * Прочитать вкладку раздела.
 *
 * @param {{login:string,password:string}} creds
 * @param {object} spec  menuItem, mainForm, switcher, tab, grid (необязательно),
 *                       title, dated — нужен ли период
 * @param {object} opts  from/to (YYYY-MM-DD), search, limit
 */
async function readFormTab(creds, spec, { from = '', to = '', search = '', limit = LIMIT_DEFAULT } = {}) {
  const want = Math.min(Math.max(Number(limit) || LIMIT_DEFAULT, 1), LIMIT_MAX)
  const call = (method, path, body) => callBankApi(creds.login, creds.password, { method, path, body })

  const open = await call('POST', '/api/v1/menu/click', { menuItem: spec.menuItem })
  const opened = open.json?.commands || []
  const main = lastForm(opened, c => c.instanceName === spec.mainForm)
  if (!main) throw new Error(`банк не открыл раздел «${spec.title}»`)

  // Свитчер ищем в самой форме: имя поля у разделов разное
  // (mainFormSwitcher, otherDocsSwither — да, у банка там опечатка).
  const switcherName = spec.switcher
    || Object.keys(main.fields || {}).find(k => /switcher|swither/i.test(k))
  const switcher = main.fields?.[switcherName]
  const tabs = (switcher?.items || [])
    .filter(i => i.visible !== false)
    .map(i => ({ id: i.id, label: i.label || (Array.isArray(i.values) ? i.values[0] : '') || i.id, parentId: i.parentId || null }))

  let switched = []
  if (spec.tab && switcherName) {
    const sw = await call('PUT', `/api/v1/${spec.mainForm}/doAction`, {
      instanceToken: main.instanceToken,
      actionId: `_switchForm_${switcherName}`,
      extActionId: spec.tab,
    })
    switched = sw.json?.commands || []
  }

  const err = [...opened, ...switched].find(c => /errorDialog/.test(c.instanceName || ''))
  if (err) throw new Error(String(err.fields?.message?.value || err.fields?.message || 'раздел недоступен'))

  // Форма вкладки — последняя, где есть грид
  const hasGrid = c => c.instanceName !== spec.mainForm && !!findGrid(c, spec.grid)
  const form = lastForm(switched, hasGrid) || lastForm(opened, hasGrid)
  if (!form) throw new Error(`банк не прислал вкладку «${spec.title}»`)

  const gridName = findGrid(form, spec.grid)
  const instance = form.instanceName
  let token = form.instanceToken
  let columns = columnsOf(form.fields[gridName])

  const known = new Map()
  let order = []
  const absorb = (list) => {
    for (const c of list || []) {
      const field = c.fields?.[gridName]
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

  const fields = {}
  if (spec.dated && from && form.fields?.dateFrom) fields.dateFrom = { value: from }
  if (spec.dated && to && form.fields?.dateTo) fields.dateTo = { value: to }
  if (search && form.fields?.search) fields.search = { value: search }
  if (Object.keys(fields).length && form.actions?.applyFilter) {
    const r = await call('PUT', `/api/v1/${instance}/doAction`, { instanceToken: token, actionId: 'applyFilter', fields })
    known.clear()   // фильтр меняет выборку — старые строки к ней отношения не имеют
    absorb(r.json?.commands)
  }

  let pages = 0
  let growing = order.length > 0
  while (order.length < want && pages < PAGE_MAX && form.actions?.loadMore) {
    const before = order.length
    const r = await call('PUT', `/api/v1/${instance}/doAction`, { instanceToken: token, actionId: 'loadMore' })
    absorb(r.json?.commands)
    pages++
    if (order.length <= before) { growing = false; break }
  }

  const rows = order.filter(r => Object.keys(r).length)
  const capped = want >= LIMIT_MAX && rows.length >= LIMIT_MAX
  return {
    title: spec.title,
    instanceName: instance,
    grid: gridName,
    dated: !!spec.dated,
    columns,
    rows: rows.slice(0, want),
    total: Math.min(rows.length, want),
    hasMore: growing && rows.length >= want && !capped,
    capped,
    limitMax: LIMIT_MAX,
    tabs,
    // Действия вкладки нужны экрану, чтобы честно решать, что можно предложить:
    // «Создать счёт» рисуем, только если банк дал createInvoice.
    actions: Object.keys(form.actions || {}),
  }
}

module.exports = { readFormTab, cleanRow, columnsOf, lastForm, LIMIT_DEFAULT, LIMIT_MAX }
