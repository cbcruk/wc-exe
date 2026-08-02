import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { bearerToken, controlPlaneGuard, tokensMatch } from './auth.js'

const TOKEN = 'a'.repeat(64)

function guardedApp(): Hono {
  const app = new Hono()
  app.use('/control/*', controlPlaneGuard(TOKEN))
  app.get('/control/ping', (c) => c.json({ ok: true }))
  return app
}

const authorized = { authorization: `Bearer ${TOKEN}` }

describe('tokensMatch', () => {
  it('accepts an identical token', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
  })

  it('rejects a different token of the same length', () => {
    expect(tokensMatch('b'.repeat(64), TOKEN)).toBe(false)
  })

  it('rejects a prefix rather than throwing on the length mismatch', () => {
    expect(tokensMatch('a'.repeat(63), TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
  })
})

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer xyz')).toBe('xyz')
  })

  it('returns null for anything that is not a bearer header', () => {
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken('Basic xyz')).toBeNull()
    expect(bearerToken('xyz')).toBeNull()
  })
})

describe('controlPlaneGuard', () => {
  it('allows a correctly authorized request with no Origin', async () => {
    const res = await guardedApp().request('/control/ping', {
      headers: authorized,
    })

    expect(res.status).toBe(200)
  })

  it('rejects a missing token', async () => {
    const res = await guardedApp().request('/control/ping')

    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await guardedApp().request('/control/ping', {
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    })

    expect(res.status).toBe(401)
  })

  // The daemon listens on a fixed port for as long as it runs, so any page the
  // user visits can reach it. Browsers always attach Origin cross-origin and
  // cannot be talked out of it, so this holds even against a stolen token.
  it('rejects a request carrying an Origin even with a valid token', async () => {
    const res = await guardedApp().request('/control/ping', {
      headers: { ...authorized, origin: 'https://evil.example' },
    })

    expect(res.status).toBe(403)
  })

  it('rejects an Origin naming the daemon itself', async () => {
    const res = await guardedApp().request('/control/ping', {
      headers: { ...authorized, origin: 'http://localhost:5199' },
    })

    expect(res.status).toBe(403)
  })

  it('rejects an empty Origin, which is still a browser', async () => {
    const res = await guardedApp().request('/control/ping', {
      headers: { ...authorized, origin: '' },
    })

    expect(res.status).toBe(403)
  })
})
