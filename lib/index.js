/**
 * local-token-meter：手机端输入框上方的用量胶囊 + 用量面板 + 每轮尾注。
 *
 * 数据全部在本机：会话日志 → token 用量 → 按官方价目表折算人民币（预估）；
 * 余额走宿主账号服务或官方余额接口。只读，不改会话，不发消息。
 */
import { BalanceMonitor } from './balance.js'
import { Ledger } from './ledger.js'
import { panelDefinition } from './panel.js'
import { nextSwitch, setPriceOverrides } from './pricing.js'
import { buildStrip } from './strip.js'
import { clampText, cny, readJson, STATE_DIR, tokens } from './util.js'
import { join } from 'node:path'

export const name = 'local-token-meter'

/** 配置：$DSH_HOME/dsh-go/local-token-meter.config.json（可选）。 */
function loadConfig() {
  const raw = readJson(join(STATE_DIR, 'local-token-meter.config.json'))
  const config = { lowBalance: 5, prices: undefined, topUpUrl: undefined }
  if (raw !== null && typeof raw === 'object') {
    const threshold = Number(raw.lowBalance)
    if (Number.isFinite(threshold) && threshold > 0) config.lowBalance = threshold
    if (raw.prices !== undefined) config.prices = raw.prices
    if (typeof raw.topUpUrl === 'string' && raw.topUpUrl.startsWith('https://')) config.topUpUrl = raw.topUpUrl
  }
  return config
}

class Meter {
  constructor(dshGoCtx, config) {
    this.ctx = dshGoCtx
    this.config = config
    this.listeners = new Set()
    this.ledger = new Ledger({ onChange: () => this.#changed() })
    this.balance = new BalanceMonitor(dshGoCtx, { lowThreshold: config.lowBalance })
    if (typeof config.topUpUrl === 'string') this.customTopUp = config.topUpUrl
    this.balanceTimer = undefined
    this.startBalanceTimer()
  }

  ensure() {
    this.ledger.start()
    // App 刚打开（胶囊/面板第一次订阅）时，超过 1 分钟的旧余额先刷新一次。
    const snapshot = this.balance.snapshot()
    const age = snapshot.at > 0 ? Date.now() - snapshot.at : Number.POSITIVE_INFINITY
    if (age > 60_000) void this.refreshBalance()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  #changed() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 单个订阅失败不影响其他 */
      }
    }
  }

  refreshBalance() {
    return this.balance.refresh().then(() => this.#changed(), () => undefined)
  }

  topUpUrl() {
    return this.customTopUp ?? this.balance.snapshot().topUpUrl
  }

  startBalanceTimer() {
    if (this.balanceTimer !== undefined) return
    this.balanceTimer = setInterval(() => {
      if (this.listeners.size === 0) return
      if (!this.balance.due()) return
      void this.refreshBalance()
    }, 60_000)
    this.balanceTimer.unref?.()
  }

  dispose() {
    clearInterval(this.balanceTimer)
    this.balanceTimer = undefined
    this.listeners.clear()
    this.ledger.dispose()
  }

  /** 聚合快照（面板/胶囊共用）。 */
  snapshot(scope) {
    const views = this.ledger
    const sessionId = scope?.sessionId
    const scoped = sessionId !== undefined && sessionId !== null && sessionId !== ''
    // 有会话 scope 就只看这一场（新对话还没用量时显示「—」，不要拿上一场冒充）；
    // 从「全部功能」打开时没有 scope，才退回最近一场主对话。
    let conv = scoped ? views.conversationTotals(sessionId) : views.view().sessions.find((row) => row.depth === 0)
    const days30 = views.lastDays(30)
    const balanceSnapshot = this.balance.snapshot()
    return {
      conv,
      today: views.today(),
      total: views.totals(),
      days: days30.slice(-7),
      monthCost: days30.reduce((sum, day) => sum + day.cost, 0),
      models: views.models(),
      balance: balanceSnapshot,
      stale: balanceSnapshot.stale,
    }
  }

  // ---------------------------------------------------------------- 胶囊

  stripFeed(scope, emit) {
    this.ensure()
    let last = ''
    const push = () => {
      let data
      try {
        data = this.stripData(scope)
      } catch {
        data = { text: '用量 —', tone: 'muted' }
      }
      const key = `${data.text}\u0000${data.tone ?? ''}\u0000${data.icon ?? ''}`
      if (key === last) return
      last = key
      emit(data)
    }
    push()
    const off = this.subscribe(push)
    // 峰谷倒计时每分钟都会变：30 秒算一次，文案没变就不推（桥接本身也会去重）。
    const timer = setInterval(push, 30_000)
    timer.unref?.()
    return () => {
      off()
      clearInterval(timer)
    }
  }

  /** 胶囊文案：本对话花费 · 余额 · 峰/谷 + 距下次切换的倒计时（≤24 字）。 */
  stripData(scope) {
    const snapshot = this.snapshot(scope)
    return buildStrip({
      convCost: snapshot.conv === undefined ? undefined : snapshot.conv.cost,
      balance: snapshot.balance,
      period: nextSwitch(Date.now()),
    })
  }

  // ---------------------------------------------------------------- 尾注

  noteFeed(scope, emit) {
    this.ensure()
    const sessionId = scope?.sessionId
    const turnId = scope?.turnId
    if (sessionId === undefined || turnId === undefined) return () => undefined
    let stopped = false
    let timers = []
    const finish = () => {
      stopped = true
      off()
      for (const timer of timers) clearTimeout(timer)
    }
    const tryEmit = () => {
      if (stopped) return false
      const turn = this.ledger.turnTotals(sessionId, turnId)
      if (turn === undefined || turn.tokens === 0) return false
      emit({ [String(turnId)]: { text: clampText(`${tokens(turn.tokens)} · ${cny(turn.cost)}`, 16), tone: 'muted' } })
      finish()
      return true
    }
    // 账本一变就试；日志落盘比事件慢，所以另外再补几次（含大文件被限流的情况）。
    const off = this.subscribe(tryEmit)
    if (tryEmit()) return () => undefined
    timers = [600, 2000, 6000, 15000].map((delay) =>
      setTimeout(() => {
        if (!stopped) tryEmit()
      }, delay),
    )
    for (const timer of timers) timer.unref?.()
    return () => {
      stopped = true
      off()
      for (const timer of timers) clearTimeout(timer)
    }
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (dshGoCtx) => {
    const config = loadConfig()
    setPriceOverrides(config.prices)
    const meter = new Meter(dshGoCtx, config)

    // 结算类事件（最终消息 / 失败重试的 attempt / 关替换槽）都会改变账本，触发本会话重扫。
    ctx.on('session/event', (session, event) => {
      const type = event?.type
      if (type !== 'assistant/message' && type !== 'assistant/attempt' && type !== 'llm/retry-started') return
      meter.ledger.start()
      const id = typeof session?.id === 'string' ? session.id : ''
      if (id !== '') meter.ledger.touchSession(id)
    })

    dshGoCtx.dshGo.strip('meter', (scope, emit) => meter.stripFeed(scope, emit))
    dshGoCtx.dshGo.panel('usage', panelDefinition(meter))
    dshGoCtx.dshGo.turnNote('note', (scope, emit) => meter.noteFeed(scope, emit))

    const effect = typeof dshGoCtx.effect === 'function' ? dshGoCtx.effect : typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : undefined
    if (effect !== undefined) effect(() => () => meter.dispose(), 'local-token-meter')
  })
}
