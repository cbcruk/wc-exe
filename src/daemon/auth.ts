import crypto from 'node:crypto'
import type { Context, Next } from 'hono'

/**
 * Compares two tokens without leaking their contents through timing.
 *
 * `===` on strings short-circuits at the first differing byte, which lets a
 * local attacker recover the token a byte at a time. The length check is done
 * first because `timingSafeEqual` throws on mismatched lengths — length is not
 * secret, the bytes are.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** Extracts the bearer token from an `Authorization` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match ? match[1] : null
}

/**
 * Guards the control plane.
 *
 * Two independent checks, because the daemon listens on a fixed port for as
 * long as it runs — a far larger target than the one-shot server, which existed
 * only during a build and on a random port.
 *
 * 1. **No `Origin` header.** Browsers attach one to cross-origin requests and
 *    cannot be talked out of it; a CLI never sends one. So any request carrying
 *    an `Origin` came from a web page, and no web page has any business driving
 *    builds — even one that somehow learned the token.
 * 2. **Bearer token**, compared in constant time.
 *
 * Either alone would probably do. Together, defeating this needs both a stolen
 * token and a non-browser process, and a non-browser process on this machine
 * running as this user could simply read the token file anyway.
 */
export function controlPlaneGuard(expectedToken: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (c.req.header('origin') !== undefined) {
      return c.json(
        { error: 'The control plane does not accept requests from web pages' },
        403
      )
    }

    const presented = bearerToken(c.req.header('authorization'))
    if (!presented || !tokensMatch(presented, expectedToken)) {
      return c.json({ error: 'Invalid or missing control-plane token' }, 401)
    }

    await next()
  }
}
