import CurrencyAPI from '@everapi/currencyapi-js'
import { CurrencyRates } from '../types/types'

const BASE_CURRENCY = 'USD'
const REQUEST_TIMEOUT_MS = 10_000

interface StatusResponse {
    account_id?: number
    quotas?: {
        month?: { total: number; used: number; remaining: number }
    }
    message?: string
}

interface LatestResponse {
    meta?: { last_updated_at: string }
    data?: Record<string, { code: string; value: number }>
    message?: string
}

export class CurrencyApiError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CurrencyApiError'
    }
}

function redactKey(key: string): string {
    return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

// The SDK's fetch has no timeout, so a stalled connection would hang the
// process. Promise.race can't abort the request, but it unblocks the caller.
async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new CurrencyApiError(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
            REQUEST_TIMEOUT_MS
        )
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

async function assertUsableKey(client: CurrencyAPI): Promise<void> {
    const status = await withTimeout<StatusResponse>(client.status(), 'status check')

    if (!status?.account_id) {
        throw new CurrencyApiError(status?.message ?? 'key rejected by status endpoint')
    }

    const remaining = status.quotas?.month?.remaining
    if (typeof remaining === 'number' && remaining <= 0) {
        throw new CurrencyApiError('monthly quota exhausted')
    }
}

async function getLatestRates(key: string): Promise<CurrencyRates[]> {
    const client = new CurrencyAPI(key)
    await assertUsableKey(client)

    const response = await withTimeout<LatestResponse>(
        client.latest({ base_currency: BASE_CURRENCY }),
        'latest rates request'
    )

    if (!response?.data) {
        throw new CurrencyApiError(response?.message ?? 'malformed response from latest endpoint')
    }

    const parsed: CurrencyRates[] = []

    for (const exchange of Object.values(response.data)) {
        if (typeof exchange?.code !== 'string' || !Number.isFinite(exchange?.value)) {
            console.warn(`currencyapi: skipping malformed rate entry: ${JSON.stringify(exchange)}`)
            continue
        }
        parsed.push({
            code: exchange.code,
            rate: exchange.value
        })
    }

    if (parsed.length === 0) {
        throw new CurrencyApiError('no usable rates in response')
    }

    return parsed
}

export default async function fetchCurrencyApiRates(): Promise<CurrencyRates[]> {
    const keys = (process.env.CURRENCYAPI_KEY ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)

    if (keys.length === 0) {
        throw new CurrencyApiError('CURRENCYAPI_KEY is not set')
    }

    const failures: string[] = []

    for (const key of keys) {
        try {
            return await getLatestRates(key)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failures.push(`${redactKey(key)}: ${reason}`)
            console.warn(`currencyapi: key ${redactKey(key)} failed (${reason}), trying next key`)
        }
    }

    throw new CurrencyApiError(`all ${keys.length} API key(s) failed — ${failures.join('; ')}`)
}
