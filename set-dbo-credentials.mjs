/**
 * Задаёт логин и пароль ДБО в переменных Railway.
 *
 * Значения вводятся здесь, в приглашении, и уходят прямо в Railway через stdin:
 * они не попадают ни в код, ни в историю команд, ни в список процессов.
 *
 * Запуск:  node set-dbo-credentials.mjs
 * Проверка без записи:  node set-dbo-credentials.mjs --dry-run
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'

const DRY_RUN = process.argv.includes('--dry-run')
const SERVICE = 'delightful-essence'

// Один общий интерфейс ввода на оба вопроса: два отдельных readline не работают —
// первый забирает весь поток ввода себе, и второй вопрос повисает.
const rl = createInterface({ input: process.stdin, output: process.stdout })

/** Обычный ввод — видно, что печатаешь. */
function ask(question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())))
}

/** Скрытый ввод: приглашение печатаем сами, а эхо набираемых символов глушим. */
function askHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question)
    const echo = rl._writeToOutput
    rl._writeToOutput = () => {}
    rl.question('', answer => {
      rl._writeToOutput = echo
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** Передаёт значение в railway через stdin, чтобы оно не светилось в аргументах. */
function setVariable(key, value) {
  return new Promise((resolve, reject) => {
    const args = ['variable', 'set', key, '--stdin', '--service', SERVICE, '--skip-deploys']
    if (DRY_RUN) {
      console.log(`  [проверка] railway ${args.join(' ')}  <- значение из ${value.length} символов`)
      return resolve()
    }
    const child = spawn('railway', args, { stdio: ['pipe', 'inherit', 'inherit'], shell: true })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`railway вернул код ${code}`)))
    child.stdin.write(value)
    child.stdin.end()
  })
}

console.log('Настройка доступа прокси к ДБО Центр-инвеста')
if (DRY_RUN) console.log('(проверочный режим: ничего не записывается)')
console.log('')

rl.on("close", () => {})
const login = await ask('Логин ДБО: ')
if (!login) { console.error('Логин пустой — прерываю'); process.exit(1) }

const password = await askHidden('Пароль ДБО (не отображается): ')
if (!password) { console.error('Пароль пустой — прерываю'); process.exit(1) }

console.log('')
console.log('Записываю в Railway...')
await setVariable('DBO_LOGIN', login)
await setVariable('DBO_PASSWORD', password)

if (DRY_RUN) {
  console.log('')
  console.log('Проверка прошла. Запустите без --dry-run, чтобы записать.')
  process.exit(0)
}

console.log('')
console.log('Готово. Запускаю передеплой, чтобы сервис подхватил переменные...')
await new Promise((resolve, reject) => {
  const child = spawn('railway', ['redeploy', '--service', SERVICE, '--yes'], { stdio: 'inherit', shell: true })
  child.on('error', reject)
  child.on('close', () => resolve())
})

console.log('')
console.log('Через минуту проверьте:')
console.log('  https://delightful-essence-production-413c.up.railway.app/health')
console.log('Должно стать "dboConfigured": true — после этого вход в приложении заработает.')
