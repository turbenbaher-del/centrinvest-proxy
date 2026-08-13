// Разделы банка, живущие на формах со свитчером.
//
// Идентификаторы пунктов меню, имена форм, свитчеров и вкладок сняты с ЖИВОГО
// банка 13.08.2026 (GET /api/v1/menu + открытие каждого раздела). Брать их из
// исходников веб-версии нельзя: у этого клиента набор пунктов свой, и по
// «правильным» именам банк отвечает «Выбранный пункт меню недоступен».
//
// Чтение общее для всех — formSection.readFormTab. Здесь только карта.
const { readFormTab } = require('./formSection')

const MENU = {
  payments: 'corporate-api-menu-small-accounts-and-payments',
  other:    'corporate-api-menu-small-other-docs-docs',
  salary:   'corporate-api-menu-small-salary-cinv',
  deposits: 'corporate-api-menu-small-deposit-docs',
  credits:  'corporate-api-menu-small-credit-docs',
}

// Ключ — то, чем раздел зовётся в приложении (маршрут /section/<ключ>).
const SECTIONS = {
  // «Счета и платежи» — одна форма на 22 вкладки
  invoices:   { menuItem: MENU.payments, mainForm: 'ui/mainForm', switcher: 'mainFormSwitcher', tab: 'outgoingInvoice', title: 'Счета на оплату',    dated: true },
  stmtorders: { menuItem: MENU.payments, mainForm: 'ui/mainForm', switcher: 'mainFormSwitcher', tab: 'statementReq',    title: 'Запросы выписок',    dated: true },
  bulk:       { menuItem: MENU.payments, mainForm: 'ui/mainForm', switcher: 'mainFormSwitcher', tab: 'massPayment',     title: 'Массовые платежи',   dated: true },
  goods:      { menuItem: MENU.payments, mainForm: 'ui/mainForm', switcher: 'mainFormSwitcher', tab: 'goods',           title: 'Каталог товаров и услуг', dated: false },
  acts:       { menuItem: MENU.payments, mainForm: 'ui/mainForm', switcher: 'mainFormSwitcher', tab: 'actWorkComplete', title: 'Закрывающие документы', dated: true },

  // «Прочие продукты» — касса, самоинкассация, выдача наличных.
  // Свитчер здесь ДВУХУРОВНЕВЫЙ: «Кассовые операции» — заголовок, документы
  // лежат в статусах под ним. Проверено на живом банке 13.08.2026: в заголовке
  // ноль строк, в черновиках два заявления, в отклонённых одно — от 21.08.2020.
  // Поэтому обходим статусы и сливаем; статус у банка есть колонкой в гриде.
  cashoper:   { menuItem: MENU.other, mainForm: 'ui/otherDocsMainForm', switcher: 'otherDocsSwither', title: 'Кассовые операции и выдача наличных', dated: true,
    tabs: ['cashOperationsDraft', 'cashOperationsPartlySigned', 'cashOperationsInProcess', 'cashOperationsCompleted', 'cashOperationsCanceled'] },
  selfcollect:{ menuItem: MENU.other, mainForm: 'ui/otherDocsMainForm', switcher: 'otherDocsSwither', title: 'Карты самоинкассации', dated: true,
    tabs: ['selfCollectionReqDraft', 'selfCollectionReqPartlySing', 'selfCollectionReqInProcess', 'selfCollectionReqCompleted', 'selfCollectionReqCanceled'] },

  // Зарплатный проект — тот же двухуровневый свитчер
  salary:     { menuItem: MENU.salary, mainForm: 'ui/salaryMainForm', switcher: 'salarySwitcher', title: 'Зарплатные ведомости', dated: true,
    tabs: ['payrollDraft', 'payrollPartlySigned', 'payrollInProcess', 'payrollCompleted', 'payrollCanceled'] },
  employees:  { menuItem: MENU.salary, mainForm: 'ui/salaryMainForm', switcher: 'salarySwitcher', tab: 'employeeSwitcher', title: 'Сотрудники',           dated: false },

  // Заявки по продуктам
  depositreq: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', title: 'Заявки на депозит',  dated: true,
    tabs: ['depositRequestDraft', 'depositRequestPartlySigned', 'depositRequestInProcess', 'depositRequestCompleted', 'depositRequestCanceled'] },
  depositadd: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', title: 'Пополнение депозита', dated: true,
    tabs: ['depositReplenishDraft', 'depositReplenishPartlySigned', 'depositReplenishInProcess', 'depositReplenishCompleted', 'depositReplenishCanceled'] },
  depositout: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', title: 'Возврат депозита',    dated: true,
    tabs: ['depositDissolveDraft', 'depositDissolvePartlySigned', 'depositDissolveInProcess', 'depositDissolveCompleted', 'depositDissolveCanceled'] },
  creditreq:  { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  title: 'Заявки на кредит',    dated: true,
    tabs: ['grantCreditDraft', 'grantCreditPartlySigned', 'grantCreditInProcess', 'grantCreditCompleted', 'grantCreditCanceled'] },
  credittran: { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  title: 'Выдача транша',       dated: true,
    tabs: ['creditTrancheDraft', 'creditTranchePartlySigned', 'creditTrancheInProcess', 'creditTrancheCompleted', 'creditTrancheCanceled'] },
  creditrep:  { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  title: 'Досрочное погашение', dated: true,
    tabs: ['earlyRepaymentDraft', 'earlyRepaymentPartlySigned', 'earlyRepaymentInProcess', 'earlyRepaymentCompleted', 'earlyRepaymentCanceled'] },
}

async function getBankSection(creds, key, opts = {}) {
  const spec = SECTIONS[key]
  if (!spec) throw new Error('неизвестный раздел: ' + key)
  const data = await readFormTab(creds, spec, opts)
  return { key, ...data }
}

module.exports = { getBankSection, BANK_SECTIONS: SECTIONS }
