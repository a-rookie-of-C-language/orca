import { serve } from '@hono/node-server'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Hono } from 'hono'
import { z } from 'zod'

// Dev-only relay-token issuer: signs ES256 JWTs that the local @orca-cloud/relay
// verifies via this service's /.well-known/jwks.json. Stands in for the closed-source
// login backend when ORCA_CLOUD_DEV_AUTH=1 lets the desktop mint its own access tokens.

const PORT = Number(process.env.PORT ?? 8787)
const ISSUER = process.env.ORCA_DEV_AUTH_ISSUER ?? `http://localhost:${PORT}`
const TOKEN_TTL_SECONDS = Number(process.env.ORCA_DEV_AUTH_TOKEN_TTL_SECONDS ?? 24 * 60 * 60)

const RelayTokenRequestSchema = z
  .object({
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    hostPublicKeyB64: z.string().min(1).max(4 * 1024)
  })
  .strict()

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
const jwk = await exportJWK(publicKey)
const kid = 'dev-auth-es256'

const app = new Hono()

app.get('/.well-known/jwks.json', (context) =>
  context.json({ keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' }] })
)

app.post('/v1/desktop/auth/relay-token', async (context) => {
  const authorization = context.req.header('authorization')
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 'Bearer '.length) {
    return context.json({ error: 'missing_bearer_token' }, 401)
  }
  const parsed = RelayTokenRequestSchema.safeParse(await context.req.json().catch(() => null))
  if (!parsed.success) {
    return context.json({ error: 'invalid_request' }, 400)
  }
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000
  const relayToken = await new SignJWT({
    prof: parsed.data.hostPublicKeyB64,
    relayHostId: parsed.data.relayHostId,
    purpose: 'host-control'
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(ISSUER)
    .setAudience('orca-relay')
    .setSubject('dev-user')
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(privateKey)
  return context.json({ relayToken, expiresAt })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[dev-auth] listening on http://localhost:${info.port} (issuer ${ISSUER})`)
})
