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

  // «Прочие продукты» — касса, самоинкассация, выдача наличных
  cashoper:   { menuItem: MENU.other, mainForm: 'ui/otherDocsMainForm', switcher: 'otherDocsSwither', tab: 'cashOperRequest',  title: 'Кассовые операции',      dated: true },
  cashout:    { menuItem: MENU.other, mainForm: 'ui/otherDocsMainForm', switcher: 'otherDocsSwither', tab: 'cashFundsRequest', title: 'Выдача наличных',        dated: true },
  selfcollect:{ menuItem: MENU.other, mainForm: 'ui/otherDocsMainForm', switcher: 'otherDocsSwither', tab: 'selfCollection',   title: 'Карты самоинкассации',   dated: true },

  // Зарплатный проект
  salary:     { menuItem: MENU.salary, mainForm: 'ui/salaryMainForm', switcher: 'salarySwitcher', tab: 'payrollCompleted', title: 'Зарплатные ведомости', dated: true },
  employees:  { menuItem: MENU.salary, mainForm: 'ui/salaryMainForm', switcher: 'salarySwitcher', tab: 'employeeSwitcher', title: 'Сотрудники',           dated: false },

  // Заявки по продуктам
  depositreq: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', tab: 'depositRequest',    title: 'Заявки на депозит',  dated: true },
  depositadd: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', tab: 'depositReplenish',  title: 'Пополнение депозита', dated: true },
  depositout: { menuItem: MENU.deposits, mainForm: 'ui/depositMainForm', switcher: 'depositMainFormSwitcher', tab: 'depositDissolve',   title: 'Возврат депозита',    dated: true },
  creditreq:  { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  tab: 'grantCredit',       title: 'Заявки на кредит',    dated: true },
  credittran: { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  tab: 'creditTranche',     title: 'Выдача транша',       dated: true },
  creditrep:  { menuItem: MENU.credits,  mainForm: 'ui/creditMainForm',  switcher: 'creditMainFormSwitcher',  tab: 'earlyRepayment',    title: 'Досрочное погашение', dated: true },
}

async function getBankSection(creds, key, opts = {}) {
  const spec = SECTIONS[key]
  if (!spec) throw new Error('неизвестный раздел: ' + key)
  const data = await readFormTab(creds, spec, opts)
  return { key, ...data }
}

module.exports = { getBankSection, BANK_SECTIONS: SECTIONS }
