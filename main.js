const lines = (value) => String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const defaultAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Actions logs are public. Never print cookies, notification tokens or account emails.
const redact = (value) => {
  let message = String(value || 'Unknown error')
  const secrets = [...lines(process.env.GLADOS), ...lines(process.env.NOTIFY)]
  for (const cookie of lines(process.env.GLADOS)) {
    for (const part of cookie.split(';')) {
      const separator = part.indexOf('=')
      if (separator >= 0) secrets.push(part.slice(separator + 1).trim())
    }
  }
  for (const option of lines(process.env.NOTIFY)) secrets.push(...option.split(':'))
  for (const secret of secrets.filter((secret) => secret.length >= 6)) {
    message = message.split(secret).join('[redacted]')
  }
  return message.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted email]').replace(/[\r\n]+/g, ' ').slice(0, 600)
}

const requestJson = async (path, options) => {
  const response = await fetch(`https://glados.cloud${path}`, {
    ...options,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error(`${path}: response is not valid JSON`)
  }
}

const apiError = (label, result) => new Error(
  `${label}: ${redact(result?.message || 'Invalid API response')} (code=${redact(result?.code ?? 'missing')}${result?.reason ? ', reason=' + redact(result.reason) : ''})`
)

const glados = async () => {
  const notice = []
  const cookies = lines(process.env.GLADOS)
  const agents = lines(process.env.GLADOS_UA)
  let failed = 0
  if (!cookies.length) {
    console.error('Checkin Error: GLADOS is missing or empty. Update the GLADOS repository secret.')
    return { notice: ['Checkin Error', 'GLADOS is missing or empty'], failed: 1 }
  }
  if (agents.length > 1 && agents.length !== cookies.length) {
    console.error('Checkin Error: GLADOS_UA must contain one shared User-Agent or one line per account.')
    return { notice: ['Checkin Error', 'GLADOS_UA account count does not match GLADOS'], failed: 1 }
  }
  console.log(`Starting GLaDOS check-in for ${cookies.length} account(s).`)
  if (!agents.length) console.log('GLADOS_UA is not configured; using the default browser identifier. If device validation fails, set it to the browser used to obtain GLADOS.')
  for (const [index, cookie] of cookies.entries()) {
    const label = `Account ${index + 1}`
    try {
      const common = {
        'cookie': cookie,
        'referer': 'https://glados.cloud/console/checkin',
        'origin': 'https://glados.cloud',
        'user-agent': agents[index] || agents[0] || defaultAgent,
      }
      const action = await requestJson('/api/user/checkin', {
        method: 'POST',
        headers: { ...common, 'content-type': 'application/json' },
        body: '{"token":"glados.cloud"}',
      })
      const alreadyCheckedIn = action?.code === 1 && /checkin repeats|already checked in|today's observation logged|今日已签到/i.test(String(action?.message))
      if (action?.code !== 0 && !alreadyCheckedIn) throw apiError('Check-in failed', action)
      const status = await requestJson('/api/user/status', {
        method: 'GET',
        headers: { ...common },
      })
      if (status?.code !== 0) throw apiError('Login status failed', status)
      if (status?.data?.leftDays == null || !Number.isFinite(Number(status.data.leftDays))) throw new Error('Status response does not contain valid remaining days')
      console.log(`[${label}] ${alreadyCheckedIn ? 'Already checked in' : 'Checkin OK'} (code=${action.code})`)
      notice.push(
        `[${label}] Checkin OK`,
        redact(action?.message),
        `Left Days ${Number(status?.data?.leftDays)}`
      )
    } catch (error) {
      failed += 1
      const message = redact(error.message)
      console.error(`[${label}] Checkin Error: ${message}`)
      if (/device-mismatch|Automated check-in detected|没有权限|No permission/i.test(message)) {
        console.error('Log in again at https://glados.cloud and update GLADOS plus GLADOS_UA from the same browser. Do not post credentials in logs or issues.')
      }
      notice.push(
        `[${label}] Checkin Error`,
        message,
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }
  console.log(`Finished: ${cookies.length - failed} succeeded, ${failed} failed.`)
  return { notice, failed }
}

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice) return
  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue
    try {
      if (option.startsWith('console:')) {
        for (const line of notice) {
          console.log(line)
        }
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        })
      } else if (option.startsWith('pushplus:')) {
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('bark:')) {
        await fetch(`https://api.day.app/${option.split(':')[1]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]
        const qyweixinNotifyRebotUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyweixinToken;
        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: notice.join('<br>')
            }
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      }
    } catch (error) {
      throw error
    }
  }
}

const main = async () => {
  const { notice, failed } = await glados()
  if (failed) process.exitCode = 1
  await notify(notice)
}

main().catch((error) => {
  console.error(`Checkin Error: ${redact(error.message)}`)
  process.exitCode = 1
})
