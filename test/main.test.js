import assert from 'node:assert/strict'
import test from 'node:test'
import { notify, runCheckins } from '../main.js'

const cookie = 'gld:sess=private-session-value; gld:sess.sig=private-signature-value'
const ok = { code: 0, message: 'Checkin! Got 10 Points' }
const status = { code: 0, data: { leftDays: '12.5' } }

const run = async ({ env = {}, replies = [ok, status], networkError } = {}) => {
  const calls = []
  const output = []
  const settings = { GLADOS: cookie, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/checkin', ...env }
  const sandbox = {
    console: { log: (...args) => output.push(args.join(' ')), error: (...args) => output.push(args.join(' ')) },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (networkError) throw networkError
      assert.ok(replies.length, 'Unexpected network request')
      const reply = replies.shift()
      return {
        ok: !reply.http || reply.http === 200,
        status: reply.http || 200,
        json: async () => {
          if (reply.invalidJson) throw new Error('HTML login page with private data')
          return reply
        },
      }
    },
  }
  const result = await runCheckins({ env: settings, fetchFn: sandbox.fetch, logger: sandbox.console })
  await notify(result.notice, { env: settings, fetchFn: sandbox.fetch, logger: sandbox.console })
  return { calls, output: output.join('\n'), exitCode: result.failed ? 1 : 0, results: result.results }
}

test('successful check-in logs a result without NOTIFY and sends the configured browser identifier', async () => {
  const result = await run({ env: { GLADOS_UA: 'Actual browser identifier' } })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /Checkin OK/)
  assert.equal(result.calls.length, 2)
  assert.equal(result.calls[0].options.headers['user-agent'], 'Actual browser identifier')
  assert.equal(result.calls[0].options.headers.cookie, cookie)
  assert.equal(result.calls[0].options.headers.origin, 'https://glados.cloud')
  assert.ok(result.calls[0].options.signal instanceof AbortSignal)
  assert.doesNotMatch(result.output, /private-session|private-signature/)
})

test('device mismatch fails visibly without NOTIFY', async () => {
  const result = await run({ replies: [{ code: 4, message: 'Automated check-in detected', reason: 'device-mismatch' }] })
  assert.equal(result.exitCode, 1)
  assert.match(result.output, /code=4, reason=device-mismatch/)
  assert.match(result.output, /GLADOS_UA/)
  assert.equal(result.calls.length, 1)
})

test('invalid login fails and redacts session values and emails from server messages', async () => {
  const result = await run({ replies: [{ code: -2, message: `No permission for somebody@example.com ${cookie} private-session-value` }] })
  assert.equal(result.exitCode, 1)
  assert.match(result.output, /code=-2/)
  assert.doesNotMatch(result.output, /private-session|private-signature|somebody@example/)
})

test('a recognized already-checked-in response succeeds and still verifies login status', async () => {
  const result = await run({ replies: [{ code: 1, message: 'Checkin Repeats! Please Try Tomorrow' }, status] })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /Already checked in/)
  assert.equal(result.calls.length, 2)
})

test('an unrelated code=1 response does not silently count as success', async () => {
  const result = await run({ replies: [{ code: 1, message: 'Please checkin via another website' }] })
  assert.equal(result.exitCode, 1)
})

test('missing or whitespace-only credentials fail without making a request', async () => {
  for (const value of ['', ' \r\n ']) {
    const result = await run({ env: { GLADOS: value } })
    assert.equal(result.exitCode, 1)
    assert.match(result.output, /GLADOS is missing or empty/)
    assert.equal(result.calls.length, 0)
  }
})

test('HTTP errors, malformed JSON, network errors and malformed check-in responses fail visibly', async () => {
  for (const options of [
    { replies: [{ http: 403 }] },
    { replies: [{ http: 429 }] },
    { replies: [{ invalidJson: true }] },
    { networkError: new Error('fetch failed') },
    { replies: [{ message: 'missing code' }] },
  ]) {
    const result = await run(options)
    assert.equal(result.exitCode, 1)
    assert.match(result.output, /Checkin Error/)
    assert.doesNotMatch(result.output, /HTML login page with private data/)
  }
})

test('one failed account does not prevent another account running, and the overall task fails', async () => {
  const result = await run({
    env: { GLADOS: `${cookie}\r\nsecond-session-cookie`, GLADOS_UA: 'Browser one\r\nBrowser two' },
    replies: [{ code: -2, message: 'No permission' }, ok, status],
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.calls.length, 3)
  assert.equal(result.calls[1].options.headers['user-agent'], 'Browser two')
  assert.match(result.output, /1 succeeded, 1 failed/)
})

test('mismatched browser identifier counts fail before sending credentials', async () => {
  const result = await run({ env: { GLADOS_UA: 'Browser one\nBrowser two' } })
  assert.equal(result.exitCode, 1)
  assert.equal(result.calls.length, 0)
})

test('the existing console notification format remains supported', async () => {
  const result = await run({ env: { NOTIFY: 'console:log' } })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /Left Days 12.5/)
})

test('the selected GLaDOS domain is used consistently for URLs, browser headers and check-in token', async () => {
  const result = await run({ env: { GLADOS_DOMAIN: 'glados.rocks' } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.calls[0].url, 'https://glados.rocks/api/user/checkin')
  assert.equal(result.calls[1].url, 'https://glados.rocks/api/user/status')
  assert.equal(result.calls[0].options.headers.origin, 'https://glados.rocks')
  assert.equal(result.calls[0].options.headers.referer, 'https://glados.rocks/console/checkin')
  assert.deepEqual(JSON.parse(result.calls[0].options.body), { token: 'glados.rocks' })
  assert.equal(result.calls[0].options.redirect, 'error')
})

test('an unsupported domain fails without sending credentials', async () => {
  const result = await run({ env: { GLADOS_DOMAIN: 'example.com' } })
  assert.equal(result.exitCode, 1)
  assert.equal(result.calls.length, 0)
})

test('a confirmed POST remains successful when the account-details lookup fails', async () => {
  for (const reply of [{ http: 503 }, { code: -2, message: 'No permission' }, { code: 0, data: {} }]) {
    const result = await run({ replies: [ok, reply] })
    assert.equal(result.exitCode, 0)
    assert.equal(result.results[0].status, 'success')
    assert.match(result.output, /Check-in confirmed; account details unavailable/)
    assert.equal(result.calls.filter((call) => call.options.method === 'POST').length, 1)
  }
})

test('Turnstile requires manual action, whereas temporary network/server errors are retryable', async () => {
  const blocked = await run({ replies: [{ code: 5, reason: 'turnstile', message: 'Cloudflare verification failed' }] })
  assert.equal(blocked.results[0].status, 'manual_required')
  assert.equal(blocked.results[0].reason, 'turnstile')
  assert.match(blocked.output, /Automated retries stop for today/)
  assert.equal(blocked.calls.length, 1)
  for (const options of [{ replies: [{ http: 429 }] }, { replies: [{ http: 503 }] }, { networkError: new Error('fetch failed') }]) {
    const result = await run(options)
    assert.equal(result.results[0].status, 'retryable')
  }
  const forbidden = await run({ replies: [{ http: 403 }] })
  assert.equal(forbidden.results[0].status, 'manual_required')
})
