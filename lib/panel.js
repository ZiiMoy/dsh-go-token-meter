/**
 * 面板：视图（结构）+ 数据（数字）+ 点按处理。
 * 视图用 v1 组件，手机端兼容面最广；金额/百分比都在这里格式化成字符串。
 */
import { cny, money, percent, tokens, dayKey } from './util.js'
import { formatLeft, nextSwitch } from './pricing.js'

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 视图里的文案，中英各一份。 */
function strings(locale) {
  const en = typeof locale === 'string' && locale.toLowerCase().startsWith('en')
  return en
    ? {
        panelTitle: 'Usage',
        balance: 'Balance',
        conversation: 'This chat',
        today: 'Today',
        turns: 'turns',
        subagents: 'subtasks',
        calls: 'calls',
        hitRate: 'Cache hit',
        saved: 'Saved today',
        week: 'Last 7 days',
        month: 'Last 30 days',
        total: 'All time',
        runOut: 'Balance lasts',
        model: 'Model',
        callsColumn: 'Calls',
        costColumn: 'Cost',
        topUp: 'Top up',
        chartCaption: 'Estimated spend per day (CNY)',
        unknown: '—',
        noBalance: 'Balance unavailable; usage still counted',
        lowBalance: (amount, threshold) => `Balance ${amount} is below ${threshold}; top up to keep going`,
        okBalance: (amount, period) => `Balance ${amount} · ${period}`,
        todayLabel: 'Today',
        peak: 'Peak 2×',
        offPeak: 'Off-peak',
        toPeak: 'until peak',
        toOff: 'until off-peak',
        turnOne: 'turn',
        turnMany: 'turns',
      }
    : {
        panelTitle: '用量',
        balance: '余额',
        conversation: '本对话',
        today: '今日',
        turns: '轮',
        subagents: '个子任务',
        calls: '次调用',
        hitRate: '缓存命中',
        saved: '今日节省',
        week: '近 7 天',
        month: '近 30 天',
        total: '累计',
        runOut: '余额可用',
        model: '模型',
        callsColumn: '调用',
        costColumn: '花费',
        topUp: '去充值',
        chartCaption: '最近 7 天预估花费（元）',
        unknown: '—',
        noBalance: '读不到余额，用量统计不受影响',
        lowBalance: (amount, threshold) => `余额 ${amount} 已不足 ${threshold} 元，建议充值`,
        okBalance: (amount, period) => `余额 ${amount} · ${period}`,
        todayLabel: '今天',
        peak: '峰时 2×',
        offPeak: '谷时',
        toPeak: '后转峰',
        toOff: '后转谷',
        turnOne: '轮',
        turnMany: '轮',
      }
}

/** 视图骨架。 */
export function buildView(caps) {
  const t = strings(caps?.locale)
  return {
    type: 'stack',
    title: t.panelTitle,
    children: [
      { type: 'callout', text: { $: 'data.notice' }, tone: { $: 'data.noticeTone' } },
      {
        type: 'row',
        children: [
          {
            type: 'metric',
            label: t.balance,
            value: { $: 'data.balanceText' },
            tone: { $: 'data.balanceTone' },
            caption: { $: 'data.balanceCaption' },
          },
          {
            type: 'metric',
            label: t.conversation,
            value: { $: 'data.convCostText' },
            caption: { $: 'data.convCaption' },
          },
          {
            type: 'metric',
            label: t.today,
            value: { $: 'data.todayCostText' },
            caption: { $: 'data.todayCaption' },
          },
        ],
      },
      {
        type: 'keyValue',
        items: [
          [t.hitRate, { $: 'data.hitRateText' }],
          [t.saved, { $: 'data.savedTodayText' }],
          [t.week, { $: 'data.weekText' }],
          [t.month, { $: 'data.monthText' }],
          [t.total, { $: 'data.totalText' }],
          [t.runOut, { $: 'data.runOutText' }],
        ],
      },
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.dayLabels' },
        series: [{ name: t.costColumn, values: { $: 'data.dayCosts' } }],
        unit: '元',
        caption: t.chartCaption,
      },
      {
        type: 'table',
        columns: [t.model, t.callsColumn, t.costColumn],
        rows: { $: 'data.modelRows' },
      },
      {
        type: 'actions',
        items: [{ label: t.topUp, action: 'topup', style: 'primary', icon: 'wallet' }],
      },
    ],
  }
}

function hitRateOf(bucket) {
  const denom = bucket.input + bucket.cacheRead + bucket.cacheWrite
  return denom > 0 ? bucket.cacheRead / denom : undefined
}

function modelLabel(provider, model) {
  if (typeof model !== 'string' || model === '') return '未知'
  return model
}

/** 组装数据（≤ 32KB）。 */
export function buildData(meter, scope, caps) {
  const t = strings(caps?.locale)
  const snapshot = meter.snapshot(scope)
  const en = typeof caps?.locale === 'string' && caps.locale.toLowerCase().startsWith('en')
  const weekdays = en ? WEEK_EN : WEEK_ZH
  const week = snapshot.days
  const today = snapshot.today
  const conv = snapshot.conv
  const balance = snapshot.balance
  const period = nextSwitch()
  const periodLabel = period.peak ? t.peak : t.offPeak
  const left = formatLeft(period.leftMs)
  const periodLine = left === '' ? periodLabel : en
    ? `${periodLabel} · ${left} ${period.nextPeak ? t.toPeak : t.toOff}`
    : `${periodLabel} · ${left}${period.nextPeak ? t.toPeak : t.toOff}`
  const hitRate = hitRateOf(today)

  const parts = []
  let noticeTone = 'info'
  if (balance.low) {
    noticeTone = 'warn'
    parts.push(`${t.lowBalance(money(balance.amount, balance.currency), `¥${balance.threshold}`)} · ${periodLine}`)
  } else if (typeof balance.amount === 'number') {
    noticeTone = 'good'
    parts.push(t.okBalance(money(balance.amount, balance.currency), periodLine))
  } else {
    parts.push(t.noBalance)
  }
  if (snapshot.stale && typeof balance.amount === 'number') parts.push('（余额为上次读数）')

  const balanceTone = balance.low ? 'bad' : balance.stale ? 'muted' : 'good'
  const convCost = conv === undefined ? undefined : conv.cost
  const convTurns = conv === undefined ? 0 : conv.turnCount ?? 0
  const runOut = (() => {
    if (typeof balance.amount !== 'number') return t.unknown
    // 用「每次调用」的平均花费估算，比按轮更稳：第一轮常常带着很大的历史上下文。
    const calls = conv !== undefined && conv.calls > 0 ? conv.calls : today.calls
    const cost = conv !== undefined && conv.calls > 0 ? conv.cost : today.cost
    if (!(calls > 0) || !(cost > 0)) return t.unknown
    const perCall = cost / calls
    return `≈ ${Math.max(0, Math.floor(balance.amount / perCall))} ${t.calls}`
  })()

  return {
    notice: parts.join(' '),
    noticeTone,
    balanceText: typeof balance.amount === 'number' ? money(balance.amount, balance.currency) : t.unknown,
    balanceTone,
    balanceCaption: balance.stale && typeof balance.amount === 'number' ? `${periodLine} · 稍后更新` : periodLine,
    convCostText: conv === undefined ? t.unknown : cny(convCost),
    convCaption: conv === undefined
      ? t.unknown
      : [`${tokens(conv.tokens)} tokens`, `${convTurns} ${convTurns === 1 ? t.turnOne : t.turnMany}`, ...(conv.subagentCount > 0 ? [`${conv.subagentCount} ${t.subagents}`] : [])].join(' · '),
    todayCostText: cny(today.cost),
    todayCaption: `${today.calls} ${t.calls} · ${tokens(today.tokens)} tokens`,
    hitRateText: hitRate === undefined ? t.unknown : `${percent(hitRate)} · ${tokens(today.cacheRead)} / ${tokens(today.input + today.cacheRead + today.cacheWrite)}`,
    savedTodayText: cny(today.saved),
    weekText: cny(week.reduce((sum, day) => sum + day.cost, 0)),
    monthText: cny(snapshot.monthCost),
    totalText: `${cny(snapshot.total.cost)} · ${tokens(snapshot.total.tokens)} tokens`,
    runOutText: runOut,
    dayLabels: week.map((day) => {
      const name = weekdays[new Date(day.at).getDay()] ?? ''
      return day.day === dayKey() ? t.todayLabel : (name === '' ? day.day.slice(5) : name)
    }),
    dayCosts: week.map((day) => Math.round(day.cost * 100) / 100),
    modelRows: snapshot.models.slice(0, 5).map((row) => [modelLabel(row.provider, row.model), String(row.calls), cny(row.cost)]),
  }
}

/** 面板定义（给 dshGo.panel 用）。 */
export function panelDefinition(meter) {
  return {
    view: (scope, caps) => buildView(caps),
    data: (scope, emit, caps) => {
      // 面板可能不经胶囊直接打开（全部功能 / 对话详情），账本要在这里也启动一次。
      meter.ensure()
      let stopped = false
      const push = () => {
        if (stopped) return
        try {
          emit(buildData(meter, scope, caps))
        } catch {
          emit({ notice: '读不到用量数据', noticeTone: 'warn', balanceText: '—' })
        }
      }
      push()
      void meter.refreshBalance()
      const off = meter.subscribe(push)
      // 倒计时每分钟会变：面板开着时 30 秒重算一次（数据相同就不重复发）。
      const timer = setInterval(push, 30_000)
      timer.unref?.()
      return () => {
        stopped = true
        off()
        clearInterval(timer)
      }
    },
    actions: {
      topup: () => {
        const url = meter.topUpUrl()
        return typeof url === 'string' && url.startsWith('https://') ? { link: url } : { toast: '还没有可用的充值链接' }
      },
    },
  }
}
