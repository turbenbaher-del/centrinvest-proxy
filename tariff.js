// Смена тарифного плана.
//
// Порядок банка (сверено с исходниками веб-версии, app/forms/Tariffs):
//   1) POST /api/v1/menu/click {menuItem: corporate-api-menu-small-tariff-cinv}
//      → форма marketplace/tariff, грид tariffTypes с планами;
//   2) PUT  /api/v1/marketplace/tariff/doAction {actionId:'selectTariff', rowId}
//      → банк отвечает диалогом messages/confirmDialog с предупреждением
//        «при смене тарифа предыдущий тариф будет отключен»;
//   3) PUT  /api/v1/messages/confirmDialog/doAction {actionId:'_yes'}
//      → форма marketplace/tariffConfirm — карточка заявления: тариф, его
//        параметры, обслуживаемые счета, текст уведомления;
//   4) PUT  /api/v1/marketplace/tariffConfirm/doAction {actionId:'_saveAndSign'}
//      → заявление сохраняется И подписывается одним действием.
//
// ВАЖНО: до шага 4 в банке НИЧЕГО не создаётся — отдельного «сохранить» у формы
// нет. Поэтому шаги 1–3 безопасны и обратимы, а шаг 4 — это уже подпись,
// которую инициирует человек. Смена тарифа меняет стоимость обслуживания.
//
// Состояние между вызовами не храним: токены форм живут недолго, и попытка их
// переиспользовать давала бы «молчаливые» пустые ответы. Каждый шаг проходит
// цепочку заново — это три быстрых запроса к REST банка.
const { callBankApi } = require('./browser')

const MENU_ITEM = 'corporate-api-menu-small-tariff-cinv'
const FORM = 'marketplace/tariff'
const CONFIRM_FORM = 'marketplace/tariffConfirm'

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v
const text = (f) => {
  const v = plain(f)
  return typeof v === 'string' ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : (v == null ? '' : String(v))
}
const lastForm = (cmds, name) => [...(cmds || [])].reverse()
  .find(c => c.command === 'formInit' && c.instanceName === name)

/** Планы тарифов с признаками «подключён» и «можно сменить». */
function readPlans(form) {
  return (form?.fields?.tariffTypes?.items || []).map(t => ({
    id: t.id,
    name: text(t.name),
    active: !!t.checked,
    canChange: !!t.availableChangeTariff,
  }))
}

/**
 * Шаг к смене тарифа.
 *
 * confirm=false — доходим до предупреждения банка и останавливаемся;
 * confirm=true  — подтверждаем и открываем карточку заявления.
 * Подпись не выполняется ни в том, ни в другом случае.
 */
async function prepareTariffChange(creds, { tariffId, confirm = false } = {}) {
  if (!tariffId) throw new Error('не указан тариф')
  const call = (method, path, body) => callBankApi(creds.login, creds.password, { method, path, body })

  const open = await call('POST', '/api/v1/menu/click', { menuItem: MENU_ITEM })
  const form = lastForm(open.json?.commands, FORM)
  if (!form) throw new Error('банк не открыл раздел тарифов')

  const plans = readPlans(form)
  const plan = plans.find(p => p.id === tariffId)
  if (!plan) throw new Error('такого тарифа нет в списке банка')
  if (plan.active) throw new Error(`«${plan.name}» уже подключён`)
  if (!plan.canChange) throw new Error(`банк не разрешает переключиться на «${plan.name}»`)

  const sel = await call('PUT', `/api/v1/${FORM}/doAction`, {
    instanceToken: form.instanceToken, actionId: 'selectTariff', rowId: tariffId, ids: [tariffId],
  })
  const selCmds = sel.json?.commands || []
  const dialog = selCmds.find(c => /confirmDialog/.test(c.instanceName || ''))

  if (!confirm) {
    // Предупреждение показываем словами банка, а не своими: цена ошибки здесь
    // не наша, и пересказ может разойтись с тем, на что человек соглашается.
    const message = text(dialog?.fields?.message) || text(dialog?.fields?.text)
      || 'При смене тарифа предыдущий тариф будет отключён.'
    return { stage: 'confirm', plan, message }
  }
  if (!dialog) throw new Error('банк не предложил подтверждение смены тарифа')

  const yes = await call('PUT', `/api/v1/${dialog.instanceName}/doAction`, {
    instanceToken: dialog.instanceToken, actionId: '_yes',
  })
  const card = lastForm(yes.json?.commands, CONFIRM_FORM)
  if (!card) {
    const err = (yes.json?.commands || []).find(c => /errorDialog/.test(c.instanceName || ''))
    throw new Error(text(err?.fields?.message) || 'банк не открыл заявление на смену тарифа')
  }

  const f = card.fields || {}
  return {
    stage: 'ready',
    plan,
    name: text(f.name) || plan.name,
    description: text(f.description),
    notice: text(f.noticeText),
    branch: [text(f.branchName), text(f.branchBic) && 'БИК ' + text(f.branchBic)].filter(Boolean).join(', '),
    // Особенности тарифа и счета, которые попадут под новый тариф
    props: (f.props?.items || []).map(p => ({ label: text(p.label), value: text(p.value) }))
      .filter(p => p.label || p.value),
    accounts: (f['appAccountCollection.appAccounts']?.items || [])
      .map(a => ({ id: a.id, account: text(a.account), bic: text(a.bankBic), bank: text(a.branchName) }))
      .filter(a => a.account),
    // Подпись доступна не всегда: у пользователя может не быть права подписи
    canSign: !!card.actions?._saveAndSign && !card.actions._saveAndSign.disabled,
  }
}

/**
 * Подпись заявления: сохраняет и подписывает одним действием банка.
 * Вызывается ТОЛЬКО по явному действию человека — это шаг, меняющий договор.
 */
async function signTariffChange(creds, { tariffId } = {}) {
  if (!tariffId) throw new Error('не указан тариф')
  const call = (method, path, body) => callBankApi(creds.login, creds.password, { method, path, body })

  // Цепочку проходим ровно один раз: повторные selectTariff/_yes — это лишние
  // обращения к банку, а он ограничивает их частоту.
  const open = await call('POST', '/api/v1/menu/click', { menuItem: MENU_ITEM })
  const form = lastForm(open.json?.commands, FORM)
  if (!form) throw new Error('банк не открыл раздел тарифов')
  const plan = readPlans(form).find(p => p.id === tariffId)
  if (!plan) throw new Error('такого тарифа нет в списке банка')
  if (plan.active) throw new Error(`«${plan.name}» уже подключён`)

  const sel = await call('PUT', `/api/v1/${FORM}/doAction`, {
    instanceToken: form.instanceToken, actionId: 'selectTariff', rowId: tariffId, ids: [tariffId],
  })
  const dialog = (sel.json?.commands || []).find(c => /confirmDialog/.test(c.instanceName || ''))
  if (!dialog) throw new Error('банк не предложил подтверждение смены тарифа')
  const yes = await call('PUT', `/api/v1/${dialog.instanceName}/doAction`, {
    instanceToken: dialog.instanceToken, actionId: '_yes',
  })
  const card = lastForm(yes.json?.commands, CONFIRM_FORM)
  if (!card) throw new Error('банк не открыл заявление на смену тарифа')
  if (card.actions?._saveAndSign?.disabled) throw new Error('банк не даёт подписать заявление: нет права подписи')

  const res = await call('PUT', `/api/v1/${CONFIRM_FORM}/doAction`, {
    instanceToken: card.instanceToken, actionId: '_saveAndSign',
  })
  const cmds = res.json?.commands || []
  const err = cmds.find(c => /errorDialog/.test(c.instanceName || ''))
  if (err) throw new Error(text(err.fields?.message) || 'банк отклонил заявление')

  // Что именно банк потребует для подписи — решает он: это может быть
  // криптооперация с ключом eToken или подтверждение в PayControl. Ответ
  // отдаём как есть: выдумывать здесь сценарий опаснее, чем показать правду.
  return {
    stage: 'signing',
    commands: cmds.map(c => ({
      command: c.command,
      instanceName: c.instanceName,
      title: c.title || '',
      message: text(c.fields?.message),
      actions: Object.keys(c.actions || {}),
    })),
  }
}

module.exports = { prepareTariffChange, signTariffChange }
