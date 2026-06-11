import { CurrencyRates } from '../types/types'

const BASE_URL = 'https://api.currencylayer.com'
const REQUEST_TIMEOUT_MS = 10_000

// Error bodies look like {success: false, error: {code: 104, info: "..."}}.
interface LiveResponse {
    success?: boolean
    source?: string
    timestamp?: number
    quotes?: Record<string, number>
    error?: {
        code?: number
        info?: string
    }
}

export class CurrencyLayerError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CurrencyLayerError'
    }
}

function redactKey(key: string): string {
    return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

async function getLatestRates(key: string): Promise<CurrencyRates[]> {
    const query = new URLSearchParams({ access_key: key })
    const url = `${BASE_URL}/live?${query}`

    let response: Response
    try {
        response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
    } catch (err) {
        // Rethrow without the original error, whose message can embed the
        // request URL and with it the access_key.
        const cause = err instanceof Error ? err.name : 'unknown error'
        throw new CurrencyLayerError(`live request failed (${cause})`)
    }

    const body = (await response.json().catch(() => null)) as LiveResponse | null

    if (body === null) {
        throw new CurrencyLayerError(`live returned ${response.status} with unparseable JSON`)
    }

    // The API signals errors in the body, not just the HTTP status.
    if (!response.ok || body.success !== true) {
        const detail = body.error?.info ?? 'no error detail'
        throw new CurrencyLayerError(`live failed (code ${body.error?.code ?? response.status}): ${detail}`)
    }

    if (!body.quotes || typeof body.quotes !== 'object') {
        throw new CurrencyLayerError('malformed response from live endpoint')
    }

    // Quote keys are "<source><code>" pairs like USDEUR; strip the source
    // prefix so the output carries plain codes, matching the other sources.
    const source = body.source ?? 'USD'
    // The quotes omit the source currency itself (no USDUSD pair), but every
    // other source includes USD at 1 — keep the outputs consistent.
    const parsed: CurrencyRates[] = [{ code: source, rate: 1 }]

    for (const [pair, rate] of Object.entries(body.quotes)) {
        if (!pair.startsWith(source)) {
            console.warn(`currencylayer: skipping quote with unexpected pair format: ${pair}`)
            continue
        }

        const code = pair.slice(source.length)

        if (!code || !Number.isFinite(rate) || rate <= 0) {
            console.warn(`currencylayer: skipping malformed rate entry: ${pair}=${JSON.stringify(rate)}`)
            continue
        }

        parsed.push({ code, rate })
    }

    if (parsed.length === 0) {
        throw new CurrencyLayerError('no usable rates in response')
    }

    return parsed
}

export default async function fetchCurrencyLayerRates(): Promise<CurrencyRates[]> {
    const keys = (process.env.CURRENCYLAYER_KEY ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)

    if (keys.length === 0) {
        throw new CurrencyLayerError('CURRENCYLAYER_KEY is not set')
    }

    const failures: string[] = []

    for (const key of keys) {
        try {
            return await getLatestRates(key)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failures.push(`${redactKey(key)}: ${reason}`)
            console.warn(`currencylayer: key ${redactKey(key)} failed (${reason}), trying next key`)
        }
    }

    throw new CurrencyLayerError(`all ${keys.length} API key(s) failed — ${failures.join('; ')}`)
}
