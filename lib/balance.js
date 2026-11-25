/**
 * 余额：优先用宿主自带的 DeepSeek 账号服务（ctx.deepseekAccount），
 * 拿不到时退回直接读凭据文件请求官方接口。带 5 分钟缓存，失败保留旧值。
 *
 * 不记录、不打印任何 token；只把余额数字留在本机缓存文件里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, STATE_DIR, readJson, writeJson } from './util.js'

const STATE_FILE = join(STATE_DIR, 'local-token-meter.state.json')
const CREDENTIALS_FILE = join(HOME, '.credentials.yaml')
const GRANT_KEY = 'deepseek-account-platform/default'
const SUMMARY_PATH = '/api/v0/users/get_user_summary'
const TOPUP_PATH = '/top_up'
const DEFAULT_TOPUP = 'https://platform.deepseek.com/top_up'

/** 多久查一次余额（毫秒）。余额是按调用结算的，5 分钟足够且省流量。 */
export const REFRESH_MS = 5 * 60_000

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 从 credentials.yaml 里取 grant（只截取固定记录，不解析整份 YAML）。 */
function readGrant() {
  let raw
  try {
    raw = readFileSync(CREDENTIALS_FILE, 'utf8')
  } catch {
    return undefined
  }
  const start = raw.indexOf(`${GRANT_KEY}:`)
  if (start < 0) return undefined
  const block = raw.slice(start, start + 600)
  const token = /token:\s*(\S+)/.exec(block)?.[1]
  const issuer = /issuer:\s*(\S+)/.exec(block)?.[1]
  if (token === undefined || issuer === undefined) return undefined
  return { token, issuer }
}

/** 按币种汇总钱包；返回 Map<币种, 金额>（没有钱包时为空 Map）。 */
function groupWallets(wallets) {
  const map = new Map()
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    if (wallet?.balance === undefined) continue
    const currency = typeof wallet?.currency === 'string' ? wallet.currency : 'CNY'
    map.set(currency, (map.get(currency) ?? 0) + num(wallet.balance))
  }
  return map
}

/** 选一个币种（优先人民币），把充值余额和赠送余额加在一起；没有钱包返回 undefined。 */
function totalOf(normal, bonus) {
  const currency = normal.has('CNY') || bonus.has('CNY')
    ? 'CNY'
    : (normal.keys().next().value ?? bonus.keys().next().value)
  if (currency === undefined) return undefined
  return { amount: (normal.get(currency) ?? 0) + (bonus.get(currency) ?? 0), currency }
}

/** 平台客户端身份头需要的最小信息。 */
function clientIdentity() {
  return {
    version: '0.0.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

export class BalanceMonitor {
  /** @param ctx plugin context（用来找 deepseekAccount 服务）。 */
  constructor(ctx, { lowThreshold = 5 } = {}) {
    this.ctx = ctx
    this.lowThreshold = Number.isFinite(Number(lowThreshold)) ? Number(lowThreshold) : 5
    this.state = undefined
    this.inflight = undefined
    this.lastAttempt = 0
    this.failures = 0
    this.topUpUrl = DEFAULT_TOPUP
  }

  load() {
    if (this.state !== undefined) return
    const saved = readJson(STATE_FILE)
    const balance = saved?.balance
    if (balance !== null && typeof balance === 'object' && typeof balance.amount === 'number') {
      this.state = {
        amount: balance.amount,
        currency: typeof balance.currency === 'string' ? balance.currency : 'CNY',
        at: num(balance.at),
        ok: true,
      }
      if (typeof saved?.topUpUrl === 'string' && saved.topUpUrl.startsWith('https://')) this.topUpUrl = saved.topUpUrl
    } else {
      this.state = { amount: undefined, currency: 'CNY', at: 0, ok: false }
    }
  }

  /** 当前快照（不发网络请求）。 */
  snapshot() {
    this.load()
    const state = this.state
    const fresh = state.ok && Date.now() - state.at < REFRESH_MS * 2
    return {
      amount: state.ok && typeof state.amount === 'number' ? state.amount : undefined,
      currency: state.currency,
      at: state.at,
      stale: !fresh,
      low: state.ok && typeof state.amount === 'number' ? state.amount < this.lowThreshold : false,
      threshold: this.lowThreshold,
      topUpUrl: this.topUpUrl,
    }
  }

  /** 当前刷新间隔：失败一次就翻倍，成功复位（最长 15 分钟）。 */
  interval() {
    return Math.min(REFRESH_MS * 2 ** Math.min(this.failures, 4), 15 * 60_000)
  }

  /** 是否需要刷新。 */
  due() {
    this.load()
    const last = Math.max(this.state.at, this.lastAttempt)
    return !this.state.ok ? Date.now() - last >= this.interval() : Date.now() - this.state.at >= REFRESH_MS
  }

  /** 刷新余额；并发调用合并成一次。 */
  refresh({ force = false } = {}) {
    this.load()
    if (!force && !this.due()) return Promise.resolve(this.snapshot())
    if (this.inflight !== undefined) return this.inflight
    this.lastAttempt = Date.now()
    this.inflight = this.#fetch().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  async #fetch() {
    let result
    try {
      result = await this.#fetchViaAccount()
    } catch {
      result = undefined
    }
    if (result === undefined) {
      try {
        result = await this.#fetchViaCredentials()
      } catch {
        result = undefined
      }
    }
    if (result !== undefined && typeof result.amount === 'number' && Number.isFinite(result.amount)) {
      this.failures = 0
      this.state = { amount: result.amount, currency: result.currency ?? 'CNY', at: Date.now(), ok: true }
      if (typeof result.topUpUrl === 'string' && result.topUpUrl.startsWith('https://')) this.topUpUrl = result.topUpUrl
      writeJson(STATE_FILE, { balance: { amount: this.state.amount, currency: this.state.currency, at: this.state.at }, topUpUrl: this.topUpUrl })
    }
    // 失败：保留旧值，只更新尝试时间（state.at 不动，快照会标记 stale），并指数退避。
    this.failures = Math.min(this.failures + 1, 4)
    return this.snapshot()
  }

  /** 宿主自带的账号服务：不碰凭据文件，登录状态由引擎维护。 */
  async #fetchViaAccount() {
    const account = (() => {
      try {
        return this.ctx.get('deepseekAccount')
      } catch {
        return undefined
      }
    })()
    if (account === undefined || account === null) return undefined
    try {
      if (typeof account.getState === 'function') {
        const info = await account.getState()
        const link = info?.links?.topUpUrl
        if (typeof link === 'string' && link.startsWith('https://')) this.topUpUrl = link
        if (info?.status === 'signed-out') return undefined
      }
      const result = await account.getBalance(clientIdentity())
      if (result === null || result === undefined || result.status === 'failed') return undefined
      const total = totalOf(groupWallets(result.value), groupWallets(result.bonusWallets))
      if (total === undefined) return undefined
      return { amount: Math.round(total.amount * 1e6) / 1e6, currency: total.currency }
    } catch {
      return undefined
    }
  }

  /** 兜底：直接读本机 grant 请求官方余额接口。 */
  async #fetchViaCredentials() {
    const grant = readGrant()
    if (grant === undefined) return undefined
    // 只把 token 发给 https 的官方 origin。
    if (!grant.issuer.startsWith('https://')) return undefined
    const respond = await fetch(new URL(SUMMARY_PATH, grant.issuer), {
      method: 'GET',
      headers: { 'x-dsh-auth-token': grant.token, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!respond.ok) return undefined
    const body = await respond.json()
    if (body?.code !== 0) return undefined
    const biz = body?.data?.biz_data
    const total = totalOf(groupWallets(biz?.normal_wallets), groupWallets(biz?.bonus_wallets))
    // 真正的 0 元也是一次有效读数，不能当成失败；只有完全拿不到钱包才算失败。
    if (total === undefined) return undefined
    return {
      amount: Math.round(total.amount * 1e6) / 1e6,
      currency: total.currency,
      topUpUrl: new URL(TOPUP_PATH, grant.issuer).href,
    }
  }
}
