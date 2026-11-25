/**
 * DeepSeek 官方价目表（人民币 / 百万 token）与费用折算。
 *
 * 价格来自官方中文定价页（2026-11-23 核对）：
 *   deepseek-flash     缓存命中 0.02 / 未命中 1 / 输出 4（空闲时段）
 *                      高峰时段翻倍：0.04 / 2 / 8
 *   deepseek-v4-pro    0.15 / 4.5 / 13.5（空闲），高峰 0.30 / 9 / 27
 * 高峰：北京时间周一至周五 9:00-12:00、14:00-18:00，法定节假日除外；
 * 其余时段（含周末、节假日全天）为空闲时段。
 *
 * 口径：usage 里 input 与 cacheRead/cacheWrite 互斥，reasoning 已含在 output 内，
 * 因此只按 input × 未命中 + cacheRead × 命中 + cacheWrite × 写缓存 + output × 输出 计费。
 *
 * 用户可用 $DSH_HOME/dsh-go/local-token-meter.config.json 覆盖：
 *   { "prices": { "模型名": { "hit": 0.02, "miss": 1, "out": 4, "peakFactor": 2 } } }
 */
import { dayKey, hourInTz, weekdayInTz } from './util.js'

/** 空闲时段价：每百万 token 的人民币价格。peakFactor 为高峰时段倍率。 */
const DEFAULT_PRICES = {
  'deepseek-flash': { hit: 0.02, miss: 1, out: 4, peakFactor: 2 },
  'deepseek-v4.1-flash': { hit: 0.02, miss: 1, out: 4, peakFactor: 2 },
  'deepseek-v3.2': { hit: 0.02, miss: 1, out: 4, peakFactor: 2 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5, peakFactor: 2 },
  'deepseek-reasoner': { hit: 0.15, miss: 4.5, out: 13.5, peakFactor: 2 },
  'deepseek-chat': { hit: 0.02, miss: 1, out: 4, peakFactor: 2 },
}
const FLASH = DEFAULT_PRICES['deepseek-flash']
const PRO = DEFAULT_PRICES['deepseek-v4-pro']
/** 高峰时段（北京时间，小时左闭右开）。 */
const PEAK_WINDOWS = [
  [9, 12],
  [14, 18],
]
/** 已知的 2026 年法定节假日（只影响高峰判断；缺的按工作日算，略高估）。 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

let override = {}
/** 载入用户覆盖价目（可在 config 里改）。 */
export function setPriceOverrides(prices) {
  override = prices !== null && typeof prices === 'object' ? prices : {}
}

/** 该模型的价格条目（已合并用户覆盖）。 */
function entryOf(model) {
  const name = typeof model === 'string' ? model : ''
  const user = override[name]
  if (user !== null && typeof user === 'object') return { ...FLASH, ...user }
  for (const [key, value] of Object.entries(DEFAULT_PRICES)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  // 名字里带 pro / reasoner 的按 pro，其余按 flash（宁可小估不夸张）。
  const lower = name.toLowerCase()
  if (lower.includes('pro') || lower.includes('reasoner')) return PRO
  return FLASH
}

/** 某一时刻是否处于高峰计价。 */
export function isPeak(at = Date.now()) {
  const day = weekdayInTz(at)
  if (day === 0 || day === 6) return false
  if (HOLIDAYS.has(dayKey(at))) return false
  const hour = hourInTz(at)
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end)
}

/** 该时刻生效的单价（元 / 百万 token）。 */
export function ratesFor(model, at = Date.now()) {
  const base = entryOf(model)
  const factor = isPeak(at) ? Number(base.peakFactor) || 1 : 1
  return {
    hit: base.hit * factor,
    miss: base.miss * factor,
    out: base.out * factor,
    peak: factor > 1,
  }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 一次调用的花费（人民币）。
 * @param usage `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`。
 */
export function costOf(model, usage, at = Date.now()) {
  if (usage === null || typeof usage !== 'object') return 0
  const rates = ratesFor(model, at)
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const read = num(usage.cacheReadTokens)
  const write = num(usage.cacheWriteTokens)
  const cost = (input * rates.miss + read * rates.hit + write * rates.miss + output * rates.out) / 1e6
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

/** 这次调用因缓存命中省下的钱（未命中价与命中价之差）。 */
export function savedOf(model, usage, at = Date.now()) {
  if (usage === null || typeof usage !== 'object') return 0
  const rates = ratesFor(model, at)
  const read = num(usage.cacheReadTokens)
  const saved = (read * (rates.miss - rates.hit)) / 1e6
  return Number.isFinite(saved) && saved > 0 ? saved : 0
}

/** 面板上的一句话价格标签。 */
export function priceLabel(at = Date.now()) {
  return isPeak(at) ? { text: '高峰计价', tone: 'warn' } : { text: '空闲时段', tone: 'good' }
}

/** 最近一次高峰/空闲切换的边界时刻列表（未来 days 天里工作日的高峰起止）。 */
function boundaryTimes(at, days = 10) {
  const out = []
  const base = Date.parse(`${dayKey(at)}T00:00:00+08:00`)
  if (!Number.isFinite(base)) return out
  for (let i = 0; i <= days; i += 1) {
    const stamp = base + i * 86_400_000
    const day = dayKey(stamp)
    const weekday = weekdayInTz(stamp)
    if (weekday === 0 || weekday === 6 || HOLIDAYS.has(day)) continue
    for (const [start, end] of PEAK_WINDOWS) {
      const from = Date.parse(`${day}T${String(start).padStart(2, '0')}:00:00+08:00`)
      const to = Date.parse(`${day}T${String(end).padStart(2, '0')}:00:00+08:00`)
      if (Number.isFinite(from)) out.push(from)
      if (Number.isFinite(to)) out.push(to)
    }
  }
  return out
}

/**
 * 当前计价时段与下一次切换。
 * @returns `{ peak, nextAt, leftMs, nextPeak }`；`leftMs` 是距离下一次峰/谷切换的毫秒数。
 */
export function nextSwitch(at = Date.now()) {
  const peak = isPeak(at)
  const nextAt = boundaryTimes(at)
    .filter((stamp) => stamp > at)
    .sort((left, right) => left - right)[0]
  return {
    peak,
    nextAt,
    leftMs: nextAt === undefined ? undefined : nextAt - at,
    nextPeak: !peak,
  }
}

/** 倒计时文案：48m / 3h20m / 10h / 2d15h（尽量 ≤5 个字符）。 */
export function formatLeft(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 10) return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}m`
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d${restHours}h`
}
