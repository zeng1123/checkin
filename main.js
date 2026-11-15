import { pathToFileURL } from 'node:url'

export const lines = (value) => String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const defaultAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Only sanitized messages may reach public Actions logs or notifications.
export const redact = (value, env = process.env) => {
  let message = String(value || 'Unknown error')
  const secrets = [...lines(env.GLADOS), ...lines(env.NOTIFY), env.GITHUB_TOKEN]
  for (const cookie of lines(env.GLADOS)) {
    for (const part of cookie.split(';')) {
      const separator = part.indexOf('=')
      if (separator >= 0) secrets.push(part.slice(separator + 1).trim())
    }
  }
  for (const option of lines(env.NOTIFY)) secrets.push(...option.split(':'))
  for (const secret of secrets.filter((secret) => secret && secret.length >= 6)) message = message.split(secret).join('[redacted]')
  return message.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted email]').replace(/[\r\n]+/g, ' ').slice(0, 600)
}

export const configuration = (env = process.env) => {
  const cookies = lines(env.GLADOS)
  const agents = lines(env.GLADOS_UA)
  const domain = String(env.GLADOS_DOMAIN || 'glados.cloud').trim().toLowerCase()
  if (!['glados.cloud', 'glados.rocks'].includes(domain)) throw new Error('GLADOS_DOMAIN must be glados.cloud or glados.rocks.')
  if (!cookies.length) throw new Error('GLADOS is missing or empty. Update the GLADOS repository secret.')
  if (agents.length > 1 && agents.length !== cookies.length) throw new Error('GLADOS_UA account count does not match GLADOS.')
  return { cookies, agents, domain }
}

const apiError = (label, result, env) => Object.assign(new Error(
  `${label}: ${redact(result?.message || 'Invalid API response', env)} (code=${redact(result?.code ?? 'missing', env)}${result?.reason ? ', reason=' + redact(result.reason, env) : ''})`
), { apiCode: result?.code, apiReason: result?.reason })

const requestJson = async (domain, path, options, fetchFn) => {
  let response
  try {
    response = await fetchFn(`https://${domain}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) })
  } catch {
    throw Object.assign(new Error(`${path}: network request failed or timed out`), { network: true })
  }
  if (!response.ok) {
    const retryAfter = response.headers?.get('retry-after')
    const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
    throw Object.assign(new Error(`${path}: HTTP ${response.status}`), { httpStatus: response.status, retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 })
  }
  try { return await response.json() } catch {
    throw Object.assign(new Error(`${path}: response is not valid JSON`), { invalidResponse: true })
  }
}

export const classifyError = (error, env = process.env) => {
  const message = redact(error.message, env)
  if (error.apiReason === 'turnstile' || /turnstile|cloudflare verification|captcha/i.test(message)) return { status: 'manual_required', reason: 'turnstile', message }
  if (error.apiCode === -2 || [401, 403].includes(error.httpStatus) || /device-mismatch|Automated check-in detected|没有权限|No permission/i.test(message)) return { status: 'manual_required', reason: 'authentication', message }
  if (error.network || error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500) return { status: 'retryable', reason: error.network ? 'network' : `http_${error.httpStatus}`, message, retryAfterSeconds: error.retryAfterSeconds || 0 }
  return { status: 'failed', reason: error.invalidResponse ? 'invalid_response' : 'api_error', message }
}

export const checkinAccount = async ({ cookie, agent, domain, env = process.env, fetchFn = fetch }) => {
  const common = { cookie, referer: `https://${domain}/console/checkin`, origin: `https://${domain}`, 'user-agent': agent || defaultAgent }
  let action, alreadyCheckedIn
  try {
    action = await requestJson(domain, '/api/user/checkin', { method: 'POST', headers: { ...common, 'content-type': 'application/json' }, body: JSON.stringify({ token: domain }) }, fetchFn)
    alreadyCheckedIn = action?.code === 1 && /checkin repeats|already checked in|today's observation logged|今日已签到/i.test(String(action?.message))
    if (action?.code !== 0 && !alreadyCheckedIn) throw apiError('Check-in failed', action, env)
  } catch (error) { return classifyError(error, env) }

  // A confirmed check-in must not be repeated just because the balance lookup fails.
  const result = { status: 'success', reason: alreadyCheckedIn ? 'already_checked_in' : 'checked_in', code: action.code, message: redact(action.message, env) }
  try {
    const status = await requestJson(domain, '/api/user/status', { method: 'GET', headers: common }, fetchFn)
    if (status?.code !== 0) throw apiError('Login status failed', status, env)
    if (status?.data?.leftDays == null || !Number.isFinite(Number(status.data.leftDays))) throw new Error('Status response does not contain valid remaining days')
    result.leftDays = Number(status.data.leftDays)
  } catch (error) { result.warning = redact(error.message, env) }
  return result
}

export const reportAccount = (result, account, logger = console) => {
  const label = `Account ${account}`
  if (result.status === 'success') {
    logger.log(`[${label}] ${result.reason === 'already_checked_in' ? 'Already checked in' : 'Checkin OK'} (code=${result.code})`)
    if (result.warning) logger.log(`[${label}] Check-in confirmed; account details unavailable: ${result.warning}`)
  } else {
    logger.error(`[${label}] Checkin Error: ${result.message}`)
    if (result.reason === 'turnstile') logger.error('Manual action required: complete website verification and check-in in a normal browser. Automated retries stop for today.')
    if (result.reason === 'authentication') logger.error('Manual action required: log in again and update GLADOS plus GLADOS_UA from the same browser. Do not share credentials.')
  }
}

export const accountNotice = (result, account) => [`[Account ${account}] ${result.status === 'success' ? 'Checkin OK' : 'Checkin Error'}`, result.message, ...(result.leftDays != null ? [`Left Days ${result.leftDays}`] : [])]

export const runCheckins = async ({ env = process.env, fetchFn = fetch, logger = console } = {}) => {
  let config
  try { config = configuration(env) } catch (error) {
    logger.error(`Checkin Error: ${redact(error.message, env)}`)
    return { notice: ['Checkin Error', redact(error.message, env)], failed: 1, results: [] }
  }
  const { cookies, agents, domain } = config
  logger.log(`Starting GLaDOS check-in for ${cookies.length} account(s).`)
  logger.log(`GLaDOS domain: ${domain}`)
  const results = [], notice = []
  for (const [index, cookie] of cookies.entries()) {
    const result = await checkinAccount({ cookie, agent: agents[index] || agents[0], domain, env, fetchFn })
    results.push(result)
    reportAccount(result, index + 1, logger)
    notice.push(...accountNotice(result, index + 1))
  }
  const failed = results.filter((result) => result.status !== 'success').length
  logger.log(`Finished: ${cookies.length - failed} succeeded, ${failed} failed.`)
  return { notice, failed, results }
}

export const notify = async (notice, { env = process.env, fetchFn = fetch, logger = console } = {}) => {
  if (!env.NOTIFY || !notice.length) return
  for (const option of lines(env.NOTIFY)) {
    const [kind, token, ...uids] = option.split(':')
    let url, body
    if (kind === 'console') { for (const line of notice) logger.log(line); continue }
    if (kind === 'wxpusher') {
      url = 'https://wxpusher.zjiecode.com/api/send/message'
      body = { appToken: token, summary: notice[0], content: notice.join('<br>'), contentType: 3, uids }
    } else if (kind === 'bark') {
      url = `https://api.day.app/${token}`; body = { title: notice[0], body: notice.slice(1).join('\n') }
    } else if (kind === 'qyweixin') {
      url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${token}`; body = { msgtype: 'markdown', markdown: { content: notice.join('<br>') } }
    } else {
      url = 'https://www.pushplus.plus/send'; body = { token: kind === 'pushplus' ? token : option, title: notice[0], content: notice.join('<br>'), template: 'markdown' }
    }
    const response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Notification HTTP ${response.status}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { notice, failed } = await runCheckins()
  if (failed) process.exitCode = 1
  try { await notify(notice) } catch (error) { console.error(`Notification Error: ${redact(error.message)}`); process.exitCode = 1 }
}
