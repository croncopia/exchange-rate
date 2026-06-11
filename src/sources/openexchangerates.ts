import { CurrencyRates } from '../types/types'

const BASE_URL = 'https://openexchangerates.org/api'
const REQUEST_TIMEOUT_MS = 10_000

interface UsageResponse {
    data?: {
        status?: string
        usage?: {
            requests_remaining?: number
        }
    }
}

interface LatestResponse {
    base?: string
    timestamp?: number
    rates?: Record<string, number>
}

// Error bodies look like {error: true, status: 401, message: "invalid_app_id",
// description: "..."}.
interface ErrorResponse {
    message?: string
    description?: string
}

export class OpenExchangeRatesError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'OpenExchangeRatesError'
    }
}

function redactKey(key: string): string {
    return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

async function callApi<T>(endpoint: string, key: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams({ app_id: key, prettyprint: 'false', ...params })
    const url = `${BASE_URL}/${endpoint}?${query}`

    let response: Response
    try {
        response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
    } catch (err) {
        // Rethrow without the original error, whose message can embed the
        // request URL and with it the app_id.
        const cause = err instanceof Error ? err.name : 'unknown error'
        throw new OpenExchangeRatesError(`${endpoint} request failed (${cause})`)
    }

    const body = await response.json().catch(() => null)

    if (!response.ok) {
        const error = body as ErrorResponse | null
        const detail = error?.description ?? error?.message ?? 'no error detail'
        throw new OpenExchangeRatesError(`${endpoint} returned ${response.status}: ${detail}`)
    }

    if (body === null) {
        throw new OpenExchangeRatesError(`${endpoint} returned unparseable JSON`)
    }

    return body as T
}

async function assertUsableKey(key: string): Promise<void> {
    const usage = await callApi<UsageResponse>('usage.json', key)

    if (usage.data?.status !== 'active') {
        throw new OpenExchangeRatesError(`key is not active (status: ${usage.data?.status ?? 'unknown'})`)
    }

    const remaining = usage.data?.usage?.requests_remaining
    if (typeof remaining === 'number' && remaining <= 0) {
        throw new OpenExchangeRatesError('monthly request quota exhausted')
    }
}

async function getLatestRates(key: string): Promise<CurrencyRates[]> {
    await assertUsableKey(key)

    // The base param is deliberately omitted: free-plan keys reject it, and
    // the default base is already USD, which matches the other sources.
    const response = await callApi<LatestResponse>('latest.json', key, { show_alternative: 'false' })

    if (!response.rates || typeof response.rates !== 'object') {
        throw new OpenExchangeRatesError('malformed response from latest endpoint')
    }

    const parsed: CurrencyRates[] = []

    for (const [code, rate] of Object.entries(response.rates)) {
        if (!Number.isFinite(rate) || rate <= 0) {
            console.warn(`openexchangerates: skipping malformed rate entry: ${code}=${JSON.stringify(rate)}`)
            continue
        }
        parsed.push({ code, rate })
    }

    if (parsed.length === 0) {
        throw new OpenExchangeRatesError('no usable rates in response')
    }

    return parsed
}

export default async function fetchOpenExchangeRates(): Promise<CurrencyRates[]> {
    const keys = (process.env.OPENEXCHANGERATES_KEY ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)

    if (keys.length === 0) {
        throw new OpenExchangeRatesError('OPENEXCHANGERATES_KEY is not set')
    }

    const failures: string[] = []

    for (const key of keys) {
        try {
            return await getLatestRates(key)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failures.push(`${redactKey(key)}: ${reason}`)
            console.warn(`openexchangerates: key ${redactKey(key)} failed (${reason}), trying next key`)
        }
    }

    throw new OpenExchangeRatesError(`all ${keys.length} API key(s) failed — ${failures.join('; ')}`)
}
