import assert from 'node:assert/strict'
import test from 'node:test'
import { atMinute, beijingDay, policy, runSchedule, summary } from '../scheduler.js'
import { GitHubStateStore } from '../github-state.js'

const env = { GLADOS: 'first-private-cookie', GLADOS_UA: 'private-browser-id', GLADOS_DOMAIN: 'glados.rocks' }
const time = (clock, day = '2026-11-16') => new Date(`${day}T${clock}:00+08:00`)
const quiet = { log() {}, error() {} }
const success = { status: 'success', reason: 'checked_in', code: 0, message: 'OK' }
const network = { status: 'retryable', reason: 'network', message: 'temporary network failure' }
const blocked = { status: 'manual_required', reason: 'turnstile', message: 'Cloudflare verification failed' }

const memory = (initial = { version: 1, days: {} }) => {
  let state = structuredClone(initial)
  const snapshots = []
  return {
    load: async () => structuredClone(state),
    save: async (next) => { state = structuredClone(next); snapshots.push(structuredClone(next)) },
    read: () => structuredClone(state), snapshots,
  }
}

const setup = (options = {}) => {
  const store = options.store || memory()
  const requests = []
  let current = time('15:00')
  const run = (extra = {}) => runSchedule({
    env, store, now: () => current, logger: quiet, rng: (a) => a,
    runAccount: async (request) => { requests.push(request); return success }, ...options, ...extra,
  })
  return { store, requests, run, setTime: (clock, day) => { current = time(clock, day) } }
}

test('one random target is durably selected inside the inclusive morning window', async () => {
  for (const choose of [(a) => a, (_, b) => b - 1]) {
    const t = setup({ rng: choose })
    t.setTime('08:11')
    const first = await t.run()
    const target = first.targetAt
    const minutes = (Date.parse(target) - atMinute(first.day, 0)) / 60000
    assert.ok(minutes >= policy.start && minutes <= policy.end)
    assert.equal(t.requests.length, 0)
    t.setTime('08:41')
    const again = await t.run({ rng: () => { throw new Error('daily time must not be randomized again') } })
    assert.equal(again.targetAt, target)
    assert.equal(t.store.snapshots.length, 1)
  }
})

test('a delayed GitHub trigger catches up; confirmed success prevents same-day duplicates', async () => {
  const t = setup()
  const result = await t.run()
  assert.equal(t.requests.length, 1)
  assert.equal(result.accounts[0].status, 'success')
  assert.equal(result.accounts[0].attempts, 1)
  t.setTime('19:41')
  const later = await t.run()
  assert.equal(t.requests.length, 1)
  assert.equal(later.accounts[0].status, 'success')
  assert.match(summary(later), /本次仅检查计划；未发起签到/)
})

test('Turnstile/authentication blocks stop the day and do not repeatedly notify', async () => {
  for (const reason of ['turnstile', 'authentication']) {
    const t = setup()
    const first = await t.run({ runAccount: async (r) => { t.requests.push(r); return { ...blocked, reason } } })
    assert.equal(first.failed, 1)
    assert.equal(first.accounts[0].status, 'manual_required')
    t.setTime('17:00')
    const later = await t.run()
    assert.equal(t.requests.length, 1)
    assert.deepEqual(later.notice, [])
    assert.match(summary(later), /需要人工处理/)
  }
})

test('temporary errors receive 60-120 minute targets and at most three attempts', async () => {
  for (const retryMinutes of [60, 120]) {
    const t = setup({ rng: (a) => a === policy.start ? policy.start : retryMinutes })
    for (const clock of ['15:00', '17:00', '19:00']) {
      t.setTime(clock)
      const result = await t.run({ runAccount: async (r) => { t.requests.push(r); return network } })
      const a = result.accounts[0]
      if (a.attempts < 3) assert.equal(Date.parse(a.nextAttemptAt) - time(clock).getTime(), retryMinutes * 60000)
      else assert.equal(a.status, 'exhausted')
    }
    t.setTime('21:00')
    await t.run()
    assert.equal(t.requests.length, 3)
  }
})

test('Retry-After is respected when the server requires more than the normal random delay', async () => {
  const t = setup()
  const r = await t.run({ runAccount: async () => ({ ...network, reason: 'http_429', retryAfterSeconds: 3 * 3600 }) })
  assert.equal(r.accounts[0].nextAttemptAt, time('18:00').toISOString())
})

test('permanent application errors do not retry', async () => {
  const t = setup()
  await t.run({ runAccount: async (r) => { t.requests.push(r); return { status: 'failed', reason: 'invalid_response', message: 'bad response' } } })
  t.setTime('18:00')
  await t.run()
  assert.equal(t.requests.length, 1)
})

test('22:30 is a hard cutoff, including delayed first runs and late retry targets', async () => {
  const t = setup()
  t.setTime('22:30')
  const missed = await t.run()
  assert.equal(t.requests.length, 0)
  assert.equal(missed.accounts[0].status, 'missed')
  const late = setup()
  late.setTime('22:00')
  const exhausted = await late.run({ runAccount: async () => network })
  assert.equal(exhausted.accounts[0].status, 'exhausted')
  assert.equal(exhausted.accounts[0].nextAttemptAt, null)
})

test('a state-write delay crossing the cutoff or date does not send a request', async () => {
  for (const after of [time('22:31'), time('00:01', '2026-11-17')]) {
    const t = setup()
    const clocks = [time('22:29'), time('22:29'), after]
    const result = await t.run({ now: () => clocks.shift() || after })
    assert.equal(t.requests.length, 0)
    assert.equal(result.accounts[0].reason, 'daily_cutoff')
  }
})

test('Beijing midnight resets the day independently of UTC and generates a new daily target', async () => {
  assert.equal(beijingDay(new Date('2026-11-16T16:00:00Z')), '2026-11-17')
  const t = setup()
  await t.run()
  t.setTime('09:41', '2026-11-17')
  const nextDay = await t.run()
  assert.equal(t.requests.length, 2)
  assert.equal(nextDay.day, '2026-11-17')
  assert.equal(nextDay.accounts[0].attempts, 1)
})

test('dry runs neither send requests nor write state or clear an existing manual block', async () => {
  const t = setup()
  const preview = await t.run({ dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(t.store.snapshots.length, 0)
  assert.equal(t.requests.length, 0)
  await t.run({ runAccount: async () => blocked })
  const writes = t.store.snapshots.length
  const state = t.store.read()
  const dry = await t.run({ dryRun: true, resetBlocked: true })
  assert.equal(dry.accounts[0].status, 'manual_required')
  assert.equal(t.store.snapshots.length, writes)
  assert.deepEqual(t.store.read(), state)
})

test('state persistence must succeed before any request', async () => {
  const t = setup()
  await assert.rejects(t.run({ store: { load: t.store.load, save: async () => { throw new Error('storage denied') } } }), /storage denied/)
  assert.equal(t.requests.length, 0)
  const primed = setup()
  primed.setTime('08:11')
  await primed.run()
  primed.setTime('15:00')
  await assert.rejects(primed.run({ store: { load: primed.store.load, save: async () => { throw new Error('reservation denied') } } }), /reservation denied/)
  assert.equal(primed.requests.length, 0)
})

test('an interrupted in-flight request is counted and requires manual review instead of blind retry', async () => {
  const t = setup()
  t.setTime('08:11')
  await t.run()
  const snapshot = t.store.read()
  Object.assign(snapshot.days['2026-11-16'].accounts[0], { status: 'in_flight', attempts: 1, lastAttemptAt: time('15:00').toISOString(), nextAttemptAt: null })
  const resumed = setup({ store: memory(snapshot) })
  resumed.setTime('19:00')
  const result = await resumed.run()
  assert.equal(resumed.requests.length, 0)
  assert.equal(result.accounts[0].status, 'manual_required')
  assert.equal(result.accounts[0].attempts, 1)
  assert.equal(result.failed, 1)
})

test('multiple accounts have independent success and manual-block states without persisting secrets', async () => {
  const t = setup({ env: { ...env, GLADOS: env.GLADOS + '\nsecond-private-cookie' } })
  const r = await t.run({ runAccount: async (request) => { t.requests.push(request); return request.cookie === env.GLADOS ? blocked : success } })
  assert.deepEqual(r.accounts.map((a) => a.status), ['manual_required', 'success'])
  assert.equal(t.requests.length, 2)
  assert.doesNotMatch(JSON.stringify(t.store.read()), /private-cookie|private-browser|Cloudflare verification/)
})

test('manual unblocking preserves the daily target and three-attempt quota', async () => {
  const t = setup()
  const first = await t.run({ runAccount: async () => blocked })
  const reset = await t.run({ resetBlocked: true })
  assert.equal(reset.targetAt, first.targetAt)
  assert.equal(reset.accounts[0].attempts, 2)
  assert.equal(reset.accounts[0].status, 'success')
})

test('malformed scheduling records fail closed, and account-order changes require attention', async () => {
  for (const bad of [{ version: 9, days: {} }, { version: 1, days: { '2026-11-16': { targetAt: 'bad', accounts: [] } } }]) {
    const t = setup({ store: memory(bad) })
    await assert.rejects(t.run(), /invalid/i)
    assert.equal(t.requests.length, 0)
  }
  const t = setup()
  await t.run()
  await assert.rejects(t.run({ env: { ...env, GLADOS: env.GLADOS + '\nsecond' } }), /Account count changed/)
})

test('checks before 08:00 never touch storage or the service', async () => {
  const t = setup({ store: { load: () => { throw new Error('must not load') } } })
  t.setTime('07:59')
  const result = await t.run()
  assert.equal(result.accounts.length, 0)
  assert.equal(t.requests.length, 0)
})

test('migration records retain existing manual blocks and attempt counts while adding the policy version', async () => {
  const state = { version: 1, days: { '2026-11-16': { targetAt: time('10:00').toISOString(), accounts: [{ account: 1, status: 'manual_required', attempts: 1, lastAttemptAt: time('12:00').toISOString(), nextAttemptAt: null, reason: 'turnstile' }] } } }
  const t = setup({ store: memory(state) })
  const r = await t.run()
  assert.equal(t.requests.length, 0)
  assert.equal(r.accounts[0].status, 'manual_required')
  assert.equal(r.accounts[0].attempts, 1)
  assert.equal(t.store.read().days['2026-11-16'].policyVersion, 1)
  assert.equal(t.store.snapshots.length, 1)
})

test('GitHub state storage creates the branch once and uses the latest SHA for conditional writes', async () => {
  const calls = []
  const replies = [
    [404, {}], [404, {}], [200, { default_branch: 'main' }], [200, { object: { sha: 'base-sha' } }],
    [201, {}], [201, { content: { sha: 'state-1' } }], [200, { content: { sha: 'state-2' } }],
  ]
  const store = new GitHubStateStore({ repository: 'owner/checkin', token: 'private-github-token', fetchFn: async (url, options) => {
    calls.push({ url, options })
    const [code, data] = replies.shift()
    return { ok: code < 400, status: code, json: async () => data }
  } })
  const state = await store.load()
  await store.save(state)
  await store.save(state)
  const writes = calls.filter((c) => c.options.method === 'PUT').map((c) => JSON.parse(c.options.body))
  assert.equal(writes[0].sha, undefined)
  assert.equal(writes[1].sha, 'state-1')
  assert.equal(writes[0].branch, 'checkin-state')
  assert.doesNotMatch(Buffer.from(writes[0].content, 'base64').toString(), /private-github-token/)
  assert.equal(replies.length, 0)
})

test('GitHub authorization errors and state-write conflicts are not mistaken for empty state', async () => {
  const store = new GitHubStateStore({ repository: 'owner/checkin', token: 'private-github-token', fetchFn: async () => ({ ok: false, status: 403 }) })
  await assert.rejects(store.load(), /HTTP 403/)
  store.sha = 'existing'
  store.fetchFn = async () => ({ ok: false, status: 409 })
  await assert.rejects(store.save({ version: 1, days: {} }), /HTTP 409/)
})
