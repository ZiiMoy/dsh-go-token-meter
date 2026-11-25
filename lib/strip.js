/**
 * 胶囊文案（纯函数，方便单测）。
 * 正常：本对话¥5.18·余额¥11.05·峰48m
 * 低余额：⚠余额¥4.94不足·本对话¥5.18·峰48m（放不下的部分按优先级丢弃）
 * 文案总长 ≤24 字；峰时用警告色、谷时用正常色、余额不足用错误色。
 */
import { clampText, stripMoney } from './util.js'
import { formatLeft } from './pricing.js'

const MAX = 24

function width(text) {
  return [...text].length
}

/**
 * @param object
 * @param object.convCost 本对话预估花费；undefined 表示还没有数据
 * @param object.balance `{ amount?: number, low: boolean }`
 * @param object.period `{ peak: boolean, leftMs?: number }`
 * @returns `{ text, icon, tone }`
 */
export function buildStrip({ convCost, balance, period }) {
  const hasBalance = balance !== undefined && typeof balance.amount === 'number'
  const low = balance !== undefined && balance.low === true
  const conv = typeof convCost === 'number' ? stripMoney(convCost) : '—'
  const bal = hasBalance ? stripMoney(balance.amount) : '—'
  const tag = period !== undefined && period.peak ? '峰' : '谷'
  const left = period === undefined ? '' : formatLeft(period.leftMs)
  const price = left === '' ? tag : `${tag}${left}`

  if (low) {
    let text = `⚠余额${bal}不足`
    const withConv = `${text}·本对话${conv}`
    if (width(`${withConv}·${price}`) <= MAX) text = withConv
    text = `${text}·${price}`
    if (width(text) > MAX) text = `⚠余额${bal}不足·${price}`
    return { text: clampText(text, MAX), icon: 'warning', tone: 'bad' }
  }

  let text = `本对话${conv}·余额${bal}·${price}`
  if (width(text) > MAX) text = `${conv}·余额${bal}·${price}`
  if (width(text) > MAX) text = `余额${bal}·${price}`
  return { text: clampText(text, MAX), icon: 'clock', tone: period !== undefined && period.peak ? 'warn' : 'good' }
}
