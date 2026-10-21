import type { SecretAtRestProtection } from './secret-at-rest-protection'

export type MiniMaxCredentialsStatus = {
  configured: boolean
  cookieConfigured: boolean
  apiKeyConfigured: boolean
  cookieProtection: SecretAtRestProtection | null
  apiKeyProtection: SecretAtRestProtection | null
}
