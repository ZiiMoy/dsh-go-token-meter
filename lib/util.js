/**
 * 小工具：格式化、日期、文件读写。全部不抛错，出错就退化成占位。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const HOME = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
export const CACHE_DIR = join(HOME, 'cache', 'local-token-meter')
export const STATE_DIR = join(HOME, 'dsh-go')

/** 上海时区（DeepSeek 计价与「今日」口径都按它）。 */
export const TZ = 'Asia/Shanghai'

/** 毫秒 → YYYY-MM-DD（上海时区）。 */
export function dayKey(at = Date.now()) {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: TZ })
}

/** 上海时区的 hour（0-23）。 */
export function hourInTz(at) {
  const text = new Date(at).toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })
  return Number(text.slice(0, 2))
}

/** 上海时区的星期（0=周日）。 */
export function weekdayInTz(at) {
  const text = new Date(at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(text)
}

/** 金额：¥12.30 / ¥1.2 / ¥128；很小的花费显示 <¥0.01，未知显示 —。 */
export function cny(value, { compact = false, exact = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 0) return `-${cny(-value, { compact, exact })}`
  if (value > 0 && value < 0.005) return '<¥0.01'
  if (exact && value < 1000) return `¥${value.toFixed(2)}`
  if (compact && value >= 100) return `¥${Math.round(value)}`
  if (value < 10) return `¥${value.toFixed(2)}`
  if (value < 100) return `¥${value.toFixed(1)}`
  return `¥${Math.round(value)}`
}

/** 金额（按币种符号）：余额用。 */
export function money(value, currency = 'CNY', { exact = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const symbol = currency === 'USD' ? '$' : '¥'
  if (value > 0 && value < 0.005) return `<${symbol}0.01`
  const digits = exact && value < 1000 ? 2 : value < 10 ? 2 : value < 100 ? 1 : 0
  return `${symbol}${value.toFixed(digits)}`
}

/** 胶囊用的紧凑金额：¥0.42 / <¥0.01 / ¥123 / ¥1.2k（给 24 字上限留空间）。 */
export function stripMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<¥0.01'
  if (value >= 1000) return `¥${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  if (value >= 100) return `¥${Math.round(value)}`
  return `¥${value.toFixed(2)}`
}

/** token 数：912 / 12.3k / 1.2M。 */
export function tokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return String(Math.round(value))
  if (value < 1e6) return `${trim(value / 1e3)}k`
  if (value < 1e9) return `${trim(value / 1e6)}M`
  return `${trim(value / 1e9)}B`
}

function trim(n) {
  const text = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

/** 百分比：38% / 38.5%。 */
export function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const n = value * 100
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`
}

/** 两个 id 是否指同一场对话：`session-<uuid>` 与 `<uuid>` 视为相同。 */
export function sameSession(a, b) {
  const norm = (v) => (typeof v === 'string' ? v.replace(/^session-/, '') : '')
  return norm(a) !== '' && norm(a) === norm(b)
}

export function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

export function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 限制字符串长度（按码点），超长截断。 */
export function clampText(text, max) {
  const chars = [...String(text)]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}
