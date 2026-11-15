// Persist scheduling enums/timestamps only, never cookies, browser identifiers, or account details.
export class GitHubStateStore {
  constructor({ repository, token, branch = 'checkin-state', fetchFn = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('GITHUB_REPOSITORY is invalid')
    if (!token) throw new Error('GITHUB_TOKEN is missing')
    this.root = `https://api.github.com/repos/${repository}`
    this.token = token; this.branch = branch; this.fetchFn = fetchFn; this.sha = null
  }

  async request(path, method = 'GET', body) {
    const response = await this.fetchFn(`${this.root}${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw Object.assign(new Error(`GitHub state ${method} failed (HTTP ${response.status})`), { httpStatus: response.status })
    return response.json()
  }

  async load() {
    try {
      const file = await this.request(`/contents/scheduler-state.json?ref=${encodeURIComponent(this.branch)}`)
      this.sha = file.sha
      return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    } catch (error) {
      if (error.httpStatus === 404) return { version: 1, days: {} }
      throw error
    }
  }

  async ensureBranch() {
    try { await this.request(`/git/ref/heads/${encodeURIComponent(this.branch)}`) } catch (error) {
      if (error.httpStatus !== 404) throw error
      const repo = await this.request('')
      const base = await this.request(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)
      try { await this.request('/git/refs', 'POST', { ref: `refs/heads/${this.branch}`, sha: base.object.sha }) } catch (createError) {
        if (createError.httpStatus !== 422) throw createError
        await this.request(`/git/ref/heads/${encodeURIComponent(this.branch)}`)
      }
    }
  }

  async save(state) {
    if (!this.sha) await this.ensureBranch()
    const result = await this.request('/contents/scheduler-state.json', 'PUT', {
      branch: this.branch, message: 'chore: update daily check-in scheduling state',
      content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64'), ...(this.sha ? { sha: this.sha } : {}),
    })
    this.sha = result.content.sha
  }
}
