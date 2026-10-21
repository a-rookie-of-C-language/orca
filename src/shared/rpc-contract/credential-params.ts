import { z } from 'zod'

// Credential values cross the authenticated runtime socket only long enough to be
// persisted by the host; the runtime never includes them in a response or log.
export const CredentialValueParams = z.object({ value: z.string() }).strict()
