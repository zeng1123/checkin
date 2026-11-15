import { randomInt } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { accountNotice, checkinAccount, configuration, notify, redact, reportAccount } from './main.js'
import { GitHubStateStore } from './github-state.js'

export const policy = Object.freeze({ start: 550, end: 710, cutoff: 1350, maxAttempts: 3 })
export const beijingDay = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10)
export const beijingMinute = (date) => { const local = new Date(date.getTime() + 8 * 3600000); return local.getUTCHours() * 60 + local.getUTCMinutes() }
export const atMinute = (day, minute) => new Date(`${day}T00:00:00+08:00`).getTime() + minute * 60000
const statuses = new Set(['pending', 'in_flight', 'retry_wait', 'success', 'manual_required', 'failed', 'exhausted', 'missed'])
const terminal = new Set(['success', 'manual_required', 'failed', 'exhausted', 'missed'])

const validate = (state) => {
  if (state?.version !== 1 || !state.days || typeof state.days !== 'object' || Array.isArray(state.days)) throw new Error('Scheduling state is invalid; refusing to send a check-in')
  for (const [day, entry] of Object.entries(state.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(entry.accounts)) throw new Error('Invalid daily scheduling state')
    const target = new Date(entry.targetAt)
    if (!Number.isFinite(target.getTime()) || beijingDay(target) !== day || beijingMinute(target) < policy.start || beijingMinute(target) > policy.end) throw new Error('Invalid daily target time')
    for (const [index, account] of entry.accounts.entries()) {
      if (account.account !== index + 1 || !statuses.has(account.status) || !Number.isInteger(account.attempts) || account.attempts < 0 || account.attempts > policy.maxAttempts) throw new Error('Invalid account scheduling state')
      if (account.nextAttemptAt !== null && !Number.isFinite(Date.parse(account.nextAttemptAt))) throw new Error('Invalid retry time')
      if (['pending', 'retry_wait'].includes(account.status) && !account.nextAttemptAt) throw new Error('Missing retry time')
      if (account.status === 'in_flight' && (!account.lastAttemptAt || !Number.isFinite(Date.parse(account.lastAttemptAt)))) throw new Error('Missing in-flight attempt time')
    }
  }
}

export const runSchedule = async ({ env = process.env, store, now = () => new Date(), rng = randomInt, runAccount = checkinAccount, logger = console, dryRun = false, resetBlocked = false } = {}) => {
  const started = now()
  if (beijingMinute(started) < 480) return { day: beijingDay(started), accounts: [], events: ['北京时间08:00前，仅检查调度。'], notice: [], failed: 0, dryRun }
  const config = configuration(env)
  const state = await store.load()
  validate(state)
  const day = beijingDay(started)
  let changed = false
  if (!state.days[day]) {
    const targetAt = new Date(atMinute(day, rng(policy.start, policy.end + 1))).toISOString()
    state.days[day] = { policyVersion: 1, targetAt, accounts: config.cookies.map((_, index) => ({ account: index + 1, status: 'pending', attempts: 0, nextAttemptAt: targetAt, reason: 'scheduled' })) }
    changed = true
  }
  const entry = state.days[day]
  if (entry.policyVersion == null) { entry.policyVersion = 1; changed = true }
  if (entry.policyVersion !== 1) throw new Error('Daily policy version is unsupported')
  if (entry.accounts.length !== config.cookies.length) throw new Error('Account count changed during the day. Restore the previous account order or wait for the next Beijing day.')
  for (const previous of Object.keys(state.days).sort().reverse().slice(7)) { delete state.days[previous]; changed = true }
  const events = [], notice = []
  let failed = 0
  // A dry run does not write state, clear blocks, notify, or call GLaDOS.
  if (dryRun) return { day, targetAt: entry.targetAt, accounts: structuredClone(entry.accounts), events: ['预演：仅展示计划，不调用签到接口，也不保存或重置状态。'], notice, failed: 0, dryRun: true }

  for (const account of entry.accounts) {
    if (resetBlocked && account.status === 'manual_required' && account.attempts < policy.maxAttempts) {
      account.status = 'retry_wait'
      account.nextAttemptAt = new Date(Math.max(started.getTime(), Date.parse(entry.targetAt))).toISOString()
      account.reason = 'manual_reset'; changed = true
    }
    if (account.status === 'in_flight') {
      // The prior POST result is unknown. Do not automatically repeat a possible successful/blocked request.
      account.status = account.attempts >= policy.maxAttempts ? 'exhausted' : 'manual_required'
      account.reason = 'interrupted_run'
      account.nextAttemptAt = null
      failed += 1
      events.push(`账户${account.account}：上次运行中断，签到结果未知，需要人工核对。`)
      notice.push(`[Account ${account.account}] Check-in result unknown after an interrupted run; manual review required.`)
      changed = true
    }
  }
  if (changed) await store.save(state)

  for (const account of entry.accounts) {
    const current = now()
    if (beijingDay(current) !== day) { events.push('运行期间已跨入下一北京时间日期，停止旧日期请求。'); break }
    if (terminal.has(account.status)) continue
    if (beijingMinute(current) >= policy.cutoff) {
      account.status = account.attempts ? 'exhausted' : 'missed'; account.reason = 'daily_cutoff'; account.nextAttemptAt = null
      failed += 1
      events.push(`账户${account.account}：已到22:30截止时间，今天停止。`)
      notice.push(`[Account ${account.account}] Checkin missed: daily cutoff`)
      await store.save(state)
      continue
    }
    if (current.getTime() < Date.parse(account.nextAttemptAt)) continue
    if (account.attempts >= policy.maxAttempts) throw new Error('Attempt quota is inconsistent; refusing to send a check-in')
    account.attempts += 1; account.lastAttemptAt = current.toISOString(); account.nextAttemptAt = null; account.status = 'in_flight'; account.reason = 'request_started'
    // A durable reservation is required before sending the POST. Storage failures stop execution.
    await store.save(state)
    const reserved = now()
    if (beijingDay(reserved) !== day || beijingMinute(reserved) >= policy.cutoff) {
      account.status = 'exhausted'; account.reason = 'daily_cutoff'; failed += 1
      events.push(`账户${account.account}：保存状态期间超过截止时间，未发送请求。`)
      await store.save(state)
      continue
    }
    const index = account.account - 1
    let result
    try { result = await runAccount({ cookie: config.cookies[index], agent: config.agents[index] || config.agents[0], domain: config.domain, env }) } catch {
      result = { status: 'failed', reason: 'internal_error', message: 'Check-in execution interrupted unexpectedly; manual review required.' }
    }
    if (!['success', 'manual_required', 'retryable', 'failed'].includes(result.status)) throw new Error('Invalid check-in result; keeping the in-flight reservation')
    reportAccount(result, account.account, logger)
    account.reason = result.reason; account.status = result.status
    if (result.status === 'retryable') {
      const minutes = Math.max(rng(60, 121), Math.ceil((result.retryAfterSeconds || 0) / 60))
      const nextAt = now().getTime() + minutes * 60000
      if (account.attempts < policy.maxAttempts && nextAt < atMinute(day, policy.cutoff)) { account.status = 'retry_wait'; account.nextAttemptAt = new Date(nextAt).toISOString() } else { account.status = 'exhausted' }
    }
    if (result.status !== 'success') failed += 1
    // Persist scheduling data only, never response messages or account details.
    await store.save(state)
    notice.push(...accountNotice(result, account.account))
    events.push(`账户${account.account}：第${account.attempts}次尝试，${account.status}。`)
  }
  if (!events.length) events.push('本次仅检查计划；未发起签到。请以账户状态判断是否已完成，而非仅看本次调度的绿色标记。')
  return { day, targetAt: entry.targetAt, accounts: structuredClone(entry.accounts), events, notice, failed, dryRun: false }
}

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'
export const summary = (result) => {
  const names = { pending: '待首次签到', in_flight: '请求执行中', retry_wait: '等待网络故障补偿', success: '已确认签到成功', manual_required: '需要人工处理，今天停止自动重试', failed: '接口异常，今天停止', exhausted: '次数或时间已用完', missed: '已超过当日截止时间' }
  return [
    `## GLaDOS 动态签到调度${result.dryRun ? '（预演）' : ''}`,
    `北京时间日期：${result.day}；首次目标：${formatTime(result.targetAt)}。`,
    '| 账户 | 今日状态 | 已尝试 | 下次目标（北京时间） | 原因 |', '| --- | --- | --- | --- | --- |',
    ...result.accounts.map((a) => `| ${a.account} | ${names[a.status]} | ${a.attempts}/3 | ${formatTime(a.nextAttemptAt)} | ${a.reason} |`),
    '', ...result.events.map((event) => `- ${event}`), '- 遇到 Turnstile，请在正常浏览器完成页面验证和签到；动态时间不能替代验证。', '',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = new GitHubStateStore({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN })
    const result = await runSchedule({ store, dryRun: process.env.CHECKIN_DRY_RUN === 'true', resetBlocked: process.env.CHECKIN_RESET_BLOCKED === 'true' })
    const text = summary(result)
    console.log(text)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text)
    if (result.failed) process.exitCode = 1
    if (!result.dryRun) await notify(result.notice)
  } catch (error) {
    console.error(`Scheduler Error: ${redact(error.message)}`)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n调度异常：为避免重复请求，本次已停止。请检查日志与状态分支。\n')
    process.exitCode = 1
  }
}
