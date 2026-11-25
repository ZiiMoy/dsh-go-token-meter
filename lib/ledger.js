/**
 * 用量账本：把 $DSH_HOME/sessions 下每场对话的 token 记录折算成
 * 「每天 / 每模型 / 每场对话 / 总计」，并做增量缓存。
 *
 * 数据来源：引擎的会话日志（session.vN.jsonl.zstd），每个 assistant/message 事件带
 * data.usage（input/output/cacheRead/cacheWrite）。子智能体是独立的会话目录，
 * delegationDepth > 0，计入总量但不计入「本对话」。
 *
 * 实时性：挂 session/event，用量事件到达后 1.2 秒内重扫该会话日志（引擎是实时写的），
 * 不维护两份容易重复计数的实时账。另外每 2 分钟做一次便宜的变动检查，兜住漏网。
 *
 * 性能：每个文件按 mtime+size+文件长度 缓存，没变就不重读；扫描是异步分片的，
 * 不阻塞引擎主循环；账本缓存落在 $DSH_HOME/cache/local-token-meter/index.json。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { CACHE_DIR, HOME, dayKey, readJson, sameSession, writeJson } from './util.js'
import { costOf, savedOf } from './pricing.js'

const SESSIONS_DIR = join(HOME, 'sessions')
const CACHE_FILE = join(CACHE_DIR, 'index.json')
const CACHE_VERSION = 4
const FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/
const SCAN_DEBOUNCE_MS = 1200
const SWEEP_MS = 120_000
const SAVE_DEBOUNCE_MS = 6000
/** 超过这个大小的日志，实时重扫降到最多 20 秒一次，避免长对话拖慢引擎。 */
const BIG_FILE_BYTES = 4 * 1024 * 1024
const BIG_FILE_RESCAN_MS = 20_000

const emptyBucket = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, saved: 0 })

function addTo(target, { calls = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, saved = 0 } = {}) {
  target.calls += calls
  target.input += input
  target.output += output
  target.cacheRead += cacheRead
  target.cacheWrite += cacheWrite
  target.tokens += input + output + cacheRead + cacheWrite
  target.cost += cost
  target.saved += saved
  return target
}

function bucketFromSlot(slot) {
  return {
    calls: slot.c,
    input: slot.i,
    output: slot.o,
    cacheRead: slot.r,
    cacheWrite: slot.w,
    tokens: slot.i + slot.o + slot.r + slot.w,
    cost: slot.cost,
    saved: slot.saved,
  }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 会话目录里最新一代的日志文件（版本号优先，其次 zstd > 明文）。 */
function latestLogFile(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best
  let bestVersion = -1
  let bestCompressed = false
  for (const name of names) {
    const match = FILE_RE.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    const compressed = match[2] === '.zstd'
    if (version > bestVersion || (version === bestVersion && compressed && !bestCompressed)) {
      best = name
      bestVersion = version
      bestCompressed = compressed
    }
  }
  return best === undefined ? undefined : join(dir, best)
}

/**
 * 读一份会话日志，按引擎 tokenUsage 投影的同一套规则折账：
 *   - assistant/message 用 data.usage，assistant/attempt 用 stream 里最后一个 usage chunk；
 *   - 同 turn+step 的后一次结算替换前一次（流式 attempt → 最终 message）；
 *   - llm/retry-started 关掉替换槽，重试后的 attempt 是新的计费调用；
 *   - fork/seeded 会话在 session/end-seed(inherited) 之前的结算全部丢弃（父日志已计过）。
 * 折出「按天×模型」的槽位、按回合的用量，以及会话自身总量。
 */
function readSessionFile(file) {
  const stat = statSync(file)
  const buf = readFileSync(file)
  const text = file.endsWith('.zstd') ? zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8')
  const lines = text.split('\n')
  let header
  let maxSeq = 0
  const slots = new Map()
  const turns = new Map()
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, saved: 0 }
  let last = null
  let route = { provider: '', model: 'unknown' }

  const slotOf = (day, provider, model) => {
    const key = `${day}\u0000${provider}\u0000${model}`
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = { d: day, p: provider, m: model, c: 0, i: 0, o: 0, r: 0, w: 0, cost: 0, saved: 0 }
      slots.set(key, slot)
    }
    return slot
  }
  const turnOf = (key) => {
    let row = turns.get(key)
    if (row === undefined) {
      row = { c: 0, i: 0, o: 0, r: 0, w: 0, cost: 0 }
      turns.set(key, row)
    }
    return row
  }
  const addSample = (sample, sign) => {
    totals.calls += sign
    totals.input += sign * sample.input
    totals.output += sign * sample.output
    totals.cacheRead += sign * sample.cacheRead
    totals.cacheWrite += sign * sample.cacheWrite
    totals.cost += sign * sample.cost
    totals.saved += sign * sample.saved
    const slot = slotOf(sample.day, sample.provider, sample.model)
    slot.c += sign
    slot.i += sign * sample.input
    slot.o += sign * sample.output
    slot.r += sign * sample.cacheRead
    slot.w += sign * sample.cacheWrite
    slot.cost += sign * sample.cost
    slot.saved += sign * sample.saved
    const turn = turnOf(sample.turnKey)
    turn.c += sign
    turn.i += sign * sample.input
    turn.o += sign * sample.output
    turn.r += sign * sample.cacheRead
    turn.w += sign * sample.cacheWrite
    turn.cost += sign * sample.cost
  }
  const resetInherited = () => {
    totals.calls = 0
    totals.input = 0
    totals.output = 0
    totals.cacheRead = 0
    totals.cacheWrite = 0
    totals.cost = 0
    totals.saved = 0
    slots.clear()
    turns.clear()
    last = null
  }

  for (const line of lines) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'session' && header === undefined) {
      header = event
      continue
    }
    if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
    // 继承前缀：父日志已经计过，全局账里不能重复算。
    if (event.type === 'session/end-seed' && event.data?.inherited === true) {
      resetInherited()
      continue
    }
    if (event.type === 'request/context' || event.type === 'request/header') {
      const provider = event.data?.provider ?? event.data?.header?.config?.provider
      const model = event.data?.model ?? event.data?.header?.config?.model
      if (typeof provider === 'string') route = { ...route, provider }
      if (typeof model === 'string') route = { ...route, model }
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOfEvent(event)
    if (usage === null || typeof usage !== 'object') continue
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    const turn = event.data?.turn
    const step = event.data?.step
    const source = event.data?.message?.source
    const provider = typeof source?.provider === 'string' ? source.provider : route.provider
    const model = typeof source?.model === 'string' ? source.model : route.model
    const at = typeof event.time === 'number' && event.time > 0 ? event.time : Date.now()
    const turnKey = typeof turn === 'number' || typeof turn === 'string' ? String(turn) : ''
    const sameSlot = last !== null && last.turn === turn && last.step === step
    if (sameSlot) {
      const same = last.input === input && last.output === output && last.cacheRead === cacheRead && last.cacheWrite === cacheWrite && last.model === model
      if (same) continue
      // 同一次调用的新结算：替换掉上一次的值。
      addSample(last, -1)
    }
    if (input + output + cacheRead + cacheWrite === 0) {
      if (sameSlot) last = null
      continue
    }
    const sample = {
      turn,
      step,
      input,
      output,
      cacheRead,
      cacheWrite,
      cost: costOf(model, usage, at),
      saved: savedOf(model, usage, at),
      day: dayKey(at),
      provider,
      model,
      turnKey,
    }
    addSample(sample, 1)
    last = sample
  }

  if (header === undefined) return undefined
  const sessionId = typeof header.id === 'string' ? header.id : ''
  if (sessionId === '') return undefined
  let firstAt = 0
  let lastAt = 0
  for (const slot of slots.values()) {
    const stamp = Date.parse(`${slot.d}T00:00:00+08:00`)
    if (Number.isFinite(stamp)) {
      if (firstAt === 0 || stamp < firstAt) firstAt = stamp
      if (stamp > lastAt) lastAt = stamp
    }
  }
  return {
    file,
    size: buf.length,
    stamp: `${Math.round(stat.mtimeMs)}:${buf.length}`,
    sessionId,
    depth: Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0,
    origin: typeof header.origin === 'string' ? header.origin : '',
    parentId: typeof header.parentSession === 'string' ? header.parentSession : '',
    createdAt: num(header.createdAt),
    firstAt,
    lastAt,
    maxSeq,
    slots: [...slots.values()].filter((slot) => slot.c > 0 || slot.i > 0 || slot.o > 0 || slot.r > 0 || slot.w > 0),
    turns: Object.fromEntries([...turns.entries()].filter(([, row]) => row.c > 0 || row.i > 0 || row.o > 0 || row.r > 0 || row.w > 0)),
  }
}

/** 一次结算里报告的 usage（同引擎 lastAssistantStreamChunk 的口径）。 */
function usageOfEvent(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

export class Ledger {
  constructor({ onChange } = {}) {
    this.onChange = typeof onChange === 'function' ? onChange : () => {}
    this.records = new Map() // 相对 key → record
    this.views = undefined
    this.disposed = false
    this.started = false
    this.scanning = false
    this.scanQueued = false
    this.dirty = new Set()
    this.scanTimer = undefined
    this.saveTimer = undefined
    this.changeTimer = undefined
    this.sweepTimer = undefined
    this.bySession = new Map()
    this.bigScanAt = new Map()
  }

  // ---------------------------------------------------------------- 生命周期

  start() {
    if (this.started || this.disposed) return
    this.started = true
    const cached = readJson(CACHE_FILE)
    if (cached?.version === CACHE_VERSION && cached?.files !== null && typeof cached?.files === 'object') {
      for (const [key, record] of Object.entries(cached.files)) {
        if (record !== null && typeof record === 'object' && Array.isArray(record.slots) && typeof record.sessionId === 'string') {
          this.records.set(key, record)
        }
      }
    }
    this.sweepTimer = setInterval(() => this.scheduleScan(false), SWEEP_MS)
    this.sweepTimer.unref?.()
    void this.scan()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of [this.scanTimer, this.saveTimer, this.changeTimer, this.sweepTimer]) clearTimeout(timer)
    // 没开始扫描过就不要写缓存，避免用空账本覆盖已有账本。
    if (this.started) this.save(true)
  }

  // ---------------------------------------------------------------- 扫描

  /** 计划一次扫描；debounce 内多次调用合并。 */
  scheduleScan(force = false) {
    if (this.disposed) return
    if (force) this.scanQueued = true
    if (this.scanTimer !== undefined) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined
      void this.scan(this.scanQueued)
      this.scanQueued = false
    }, force ? 50 : SCAN_DEBOUNCE_MS)
    this.scanTimer.unref?.()
  }

  /** 会话产生了新事件：重扫它（未知会话则整表扫）。 */
  touchSession(sessionId) {
    if (this.disposed) return
    const key = this.#keyOf(sessionId)
    if (key === undefined) {
      // 还没扫到这场会话（比如刚开始的子智能体）：一次普通扫描就能发现新文件。
      this.scheduleScan(false)
      return
    }
    const record = this.records.get(key)
    if (record !== undefined && record.size > BIG_FILE_BYTES) {
      const last = this.bigScanAt.get(key) ?? 0
      if (Date.now() - last < BIG_FILE_RESCAN_MS) return
      this.bigScanAt.set(key, Date.now())
    }
    this.dirty.add(key)
    this.scheduleScan(false)
  }

  #keyOf(sessionId) {
    for (const [key, record] of this.records) if (sameSession(record.sessionId, sessionId)) return key
    return undefined
  }

  /** 全表扫描（只重读有变化的文件）。 */
  async scan(force = false) {
    if (this.disposed) return
    if (this.scanning) {
      // 扫描期间来的请求（哪怕不是 force）也要在这一次结束后补扫，否则最新用量要等 2 分钟 sweep。
      this.scanQueued = true
      return
    }
    this.scanning = true
    let changed = false
    try {
      let workspaces
      try {
        workspaces = readdirSync(SESSIONS_DIR)
      } catch {
        return
      }
      for (const workspace of workspaces) {
        if (this.disposed) return
        const workspaceDir = join(SESSIONS_DIR, workspace)
        let sessions
        try {
          sessions = readdirSync(workspaceDir)
        } catch {
          continue
        }
        for (const session of sessions) {
          const dir = join(workspaceDir, session)
          const file = latestLogFile(dir)
          if (file === undefined) continue
          const key = `${workspace}/${session}`
          let stat
          try {
            stat = statSync(file)
          } catch {
            continue
          }
          const cached = this.records.get(key)
          if (!force && cached !== undefined && !this.dirty.has(key) && cached.stamp === `${Math.round(stat.mtimeMs)}:${stat.size}`) continue
          let record
          try {
            record = readSessionFile(file)
          } catch {
            // 正在被写入（可能读到半帧）：保留旧记录，下一次再试。
            continue
          }
          this.dirty.delete(key)
          if (record === undefined) continue
          this.records.set(key, record)
          changed = true
          // 每处理一个文件就让出主循环，避免拖慢引擎。
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
      if (changed) {
        this.#invalidate()
        this.save()
      }
    } finally {
      this.scanning = false
      if (this.scanQueued) {
        this.scanQueued = false
        this.scheduleScan(false)
      }
    }
  }

  // ---------------------------------------------------------------- 视图

  #invalidate() {
    this.views = undefined
    this.bySession.clear()
    if (this.changeTimer !== undefined) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      if (!this.disposed) this.onChange()
    }, 250)
    this.changeTimer.unref?.()
  }

  save(immediate = false) {
    if (this.disposed && !immediate) return
    if (immediate) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      writeJson(CACHE_FILE, { version: CACHE_VERSION, files: Object.fromEntries(this.records) })
      return
    }
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      if (this.disposed) return
      writeJson(CACHE_FILE, { version: CACHE_VERSION, files: Object.fromEntries(this.records) })
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** 按需构建聚合视图（总量 / 每天 / 每模型 / 每场对话）。 */
  view() {
    if (this.views !== undefined) return this.views
    const total = emptyBucket()
    const byDay = new Map()
    const byModel = new Map()
    const bySession = new Map()
    const sessions = []
    const recordBySession = new Map()
    for (const [key, record] of this.records) {
      const session = {
        sessionId: record.sessionId,
        key,
        depth: record.depth,
        origin: record.origin,
        parentId: typeof record.parentId === 'string' ? record.parentId : '',
        createdAt: record.createdAt,
        firstAt: record.firstAt,
        lastAt: record.lastAt,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        cost: 0,
        saved: 0,
        turnCount: Object.keys(record.turns ?? {}).length,
      }
      for (const slot of record.slots) {
        const bucket = bucketFromSlot(slot)
        addTo(total, bucket)
        addTo(session, bucket)
        const day = slot.d
        let dayBucket = byDay.get(day)
        if (dayBucket === undefined) {
          dayBucket = emptyBucket()
          byDay.set(day, dayBucket)
        }
        addTo(dayBucket, bucket)
        const modelKey = `${slot.p}\u0000${slot.m}`
        let modelBucket = byModel.get(modelKey)
        if (modelBucket === undefined) {
          modelBucket = { provider: slot.p, model: slot.m, ...emptyBucket() }
          byModel.set(modelKey, modelBucket)
        }
        addTo(modelBucket, bucket)
      }
      bySession.set(record.sessionId, session)
      sessions.push(session)
      recordBySession.set(record.sessionId, record)
    }
    sessions.sort((a, b) => b.lastAt - a.lastAt || (b.createdAt || 0) - (a.createdAt || 0))
    // 子智能体会话（parentSession）挂在父对话下：本对话花费要算上它们。
    const children = new Map()
    for (const session of sessions) {
      if (session.parentId === '') continue
      const list = children.get(session.parentId) ?? []
      list.push(session.sessionId)
      children.set(session.parentId, list)
    }
    this.bySession = bySession
    this.views = {
      children,
      total,
      byDay,
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
      bySession,
      sessions,
      records: recordBySession,
    }
    return this.views
  }

  /** 一场对话连同它派生的子智能体会话的合计（「本对话」用）。 */
  conversationTotals(sessionId) {
    const view = this.view()
    const own = this.sessionTotals(sessionId)
    if (own === undefined) return undefined
    const merged = { ...own }
    const queue = [own.sessionId]
    const seen = new Set(queue)
    while (queue.length > 0) {
      const parent = queue.shift()
      for (const childId of view.children.get(parent) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = this.sessionTotals(childId)
        if (child === undefined) continue
        merged.calls += child.calls
        merged.input += child.input
        merged.output += child.output
        merged.cacheRead += child.cacheRead
        merged.cacheWrite += child.cacheWrite
        merged.tokens += child.tokens
        merged.cost += child.cost
        merged.saved += child.saved
        merged.subagentCount = (merged.subagentCount ?? 0) + 1
        queue.push(child.sessionId)
      }
    }
    return merged
  }

  /** 某场对话自己的合计；找不到返回 undefined。 */
  sessionTotals(sessionId) {
    const view = this.view()
    for (const session of view.sessions) if (sameSession(session.sessionId, sessionId)) return session
    return undefined
  }

  /** 某场对话里某一回合的合计（尾注用）。 */
  turnTotals(sessionId, turnId) {
    const view = this.view()
    for (const [, record] of view.records) {
      if (!sameSession(record.sessionId, sessionId)) continue
      const turns = record.turns ?? {}
      let row = turns[String(turnId)]
      if (row === undefined) {
        // App 的 turnId 与引擎回合号对不上时，只有单回合会话可以安全退化，避免把别的
        // 回合的用量安到这一条上。
        const keys = Object.keys(turns)
        if (keys.length === 1) row = turns[keys[0]]
        else return undefined
      }
      return { calls: row.c, input: row.i, output: row.o, cacheRead: row.r, cacheWrite: row.w, tokens: row.i + row.o + row.r + row.w, cost: row.cost }
    }
    return undefined
  }

  /** 最近 n 天（含今天）的按天合计。 */
  lastDays(n, at = Date.now()) {
    const view = this.view()
    const out = []
    const today = new Date(`${dayKey(at)}T00:00:00+08:00`)
    for (let i = n - 1; i >= 0; i -= 1) {
      const date = new Date(today.getTime() - i * 86_400_000)
      const key = dayKey(date.getTime())
      const bucket = view.byDay.get(key) ?? emptyBucket()
      out.push({ day: key, at: date.getTime(), ...bucket })
    }
    return out
  }

  today(at = Date.now()) {
    return this.view().byDay.get(dayKey(at)) ?? emptyBucket()
  }

  /** 总量（含所有会话）。 */
  totals() {
    return this.view().total
  }

  /** 每模型合计（按花费降序）。 */
  models() {
    return this.view().byModel
  }
}
