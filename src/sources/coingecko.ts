import Coingecko from '@coingecko/coingecko-typescript'
import { CurrencyRates } from '../types/types'

const REQUEST_TIMEOUT_MS = 10_000

export class CoinGeckoError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CoinGeckoError'
    }
}

function redactKey(key: string): string {
    return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

// Pull the human-readable message out of CoinGecko error bodies, which come
// in two shapes: {status: {error_message}} and {error_message}.
function describeError(err: unknown): string {
    if (err instanceof Coingecko.APIError) {
        const body = err.error as any
        const message = body?.status?.error_message ?? body?.error_message
        if (typeof message === 'string') return `${err.status}: ${message}`
    }
    return err instanceof Error ? err.message : String(err)
}

// Fiat only, from /exchange_rates: entries are typed fiat/crypto/commodity,
// and the values are quoted per BTC — dividing by the USD entry converts them
// to units-per-USD, matching the other sources.
async function getLatestRates(key: string): Promise<CurrencyRates[]> {
    const client = new Coingecko({
        demoAPIKey: key,
        environment: 'demo',
        timeout: REQUEST_TIMEOUT_MS,
        // Key rotation is the retry strategy: a 429 here means the key's
        // quota is gone, and switching keys recovers faster than backoff.
        maxRetries: 0
    })

    const response = await client.exchangeRates.get()

    if (!response?.rates) {
        throw new CoinGeckoError('malformed response from exchange_rates endpoint')
    }

    const btcToUsd = response.rates['usd']?.value
    if (!Number.isFinite(btcToUsd) || btcToUsd <= 0) {
        throw new CoinGeckoError('response is missing a usable USD rate')
    }

    const parsed: CurrencyRates[] = []

    for (const [code, entry] of Object.entries(response.rates)) {
        if (entry?.type !== 'fiat') continue
        if (!Number.isFinite(entry.value) || entry.value <= 0) {
            console.warn(`coingecko: skipping malformed fiat entry: ${code}=${JSON.stringify(entry)}`)
            continue
        }
        parsed.push({
            code: code.toUpperCase(),
            rate: entry.value / btcToUsd
        })
    }

    if (parsed.length === 0) {
        throw new CoinGeckoError('no fiat rates in exchange_rates response')
    }

    return parsed
}

export default async function fetchCoinGeckoRates(): Promise<CurrencyRates[]> {
    const keys = (process.env.COINGECKO_KEY ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)

    if (keys.length === 0) {
        throw new CoinGeckoError('COINGECKO_KEY is not set')
    }

    const failures: string[] = []

    for (const key of keys) {
        try {
            return await getLatestRates(key)
        } catch (err) {
            const reason = describeError(err)
            failures.push(`${redactKey(key)}: ${reason}`)
            console.warn(`coingecko: key ${redactKey(key)} failed (${reason}), trying next key`)
        }
    }

    throw new CoinGeckoError(`all ${keys.length} API key(s) failed — ${failures.join('; ')}`)
}
