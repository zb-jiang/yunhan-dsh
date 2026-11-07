/**
 * 待办超时展示辅助:从 dshMeta.actionPolicy.timeoutPolicy.duration 解析
 * ISO-8601 时长并推算截止时间与状态。
 *
 * <p>duration 非必填(引擎端 DshBpmnParseHandler 未配置时不合成超时机制),
 * 无值或无法解析时截止时间为 null(界面显示"无时限",到期类统计不计入)。
 */
import type { Task } from './task-api.ts'

/** 截止状态分类(统计卡与行内徽标共用)。 */
export type DeadlineState =
  | 'none'
  /** 已超时:截止已过而待办仍在名下。 */
  | 'overdue'
  /** 今日内到期(尚未超时)。 */
  | 'today'
  /** 24 小时内到期但不在今天(尚未超时)。 */
  | 'soon'
  /** 有截止且时间尚远。 */
  | 'normal'

/** ISO-8601 时长(PnW/PnD/PTnHnMnS);秒支持小数,其余取整。 */
const ISO_DURATION_PATTERN = /^P(?!$)(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

/**
 * 解析 ISO-8601 时长为毫秒。
 * @param value - duration 原文(如 PT24H、P3DT12H)。
 * @returns 毫秒数;非法或非正为 null。
 */
export function parseIsoDuration(value: string): number | null {
  const match = ISO_DURATION_PATTERN.exec(value)
  if (match === null) return null
  // 可选捕获组运行时可能是 undefined,但 RegExpMatchArray 元素类型谎称 string;
  // 显式放宽后判空才有意义(no-unnecessary-condition 依赖诚实类型)。
  const parts: readonly (string | undefined)[] = match.slice(1)
  const [weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = parts.map(part => Number(part ?? 0))
  const millis = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000
  return millis > 0 ? millis : null
}

/**
 * 待办的截止时间:到达时间 + duration。
 * @param task - 待办任务。
 * @returns 截止时间;无 duration 或无法解析为 null。
 */
export function taskDeadline(task: Task): Date | null {
  const duration = task.dshMeta?.actionPolicy?.timeoutPolicy?.duration
  if (duration === undefined || duration === null) return null
  const millis = parseIsoDuration(duration)
  if (millis === null) return null
  return new Date(Date.parse(task.createTime) + millis)
}

/**
 * 待办相对当前时刻的截止状态。
 * @param task - 待办任务。
 * @param now - 当前时刻。
 * @returns 状态分类。
 */
export function deadlineState(task: Task, now: Date): DeadlineState {
  const due = taskDeadline(task)
  if (due === null) return 'none'
  if (due.getTime() <= now.getTime()) return 'overdue'
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  if (due.getTime() <= endOfDay.getTime()) return 'today'
  if (due.getTime() - now.getTime() <= 24 * 3_600_000) return 'soon'
  return 'normal'
}

/**
 * 截止时间的人读文案:今天显示"HH:mm",其余显示"MM-DD HH:mm"。
 * @param due - 截止时刻。
 * @returns 文案。
 */
export function formatDeadline(due: Date): string {
  const pad = (n: number) => `${n}`.padStart(2, '0')
  const time = `${pad(due.getHours())}:${pad(due.getMinutes())}`
  const now = new Date()
  if (due.toDateString() === now.toDateString()) return `今日 ${time}`
  return `${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${time}`
}

/**
 * 超时时长的人读文案(ISO 时长 → "x 小时"/"x 天 y 小时"/"x 分钟")。
 * @param value - duration 原文。
 * @returns 文案;无法解析为 null。
 */
export function formatTimeoutDuration(value: string): string | null {
  const millis = parseIsoDuration(value)
  if (millis === null) return null
  return formatElapsedMillis(millis)
}

/**
 * 已完成任务耗时的人读文案(毫秒 → "x 分钟"/"x 小时 y 分"/"x 天 y 小时")。
 * @param millis - 引擎 durationInMillis。
 * @returns 文案;非正数为 null(不渲染耗时行)。
 */
export function formatElapsedMillis(millis: number): string | null {
  if (!(millis > 0)) return null
  const minutes = Math.round(millis / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} 天` : `${days} 天 ${hours % 24} 小时`
}
