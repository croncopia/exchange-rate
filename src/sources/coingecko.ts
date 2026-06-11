import Coingecko from '@coingecko/coingecko-typescript'
import { CurrencyRates } from '../types/types'

const REQUEST_TIMEOUT_MS = 10_000
const COINS_PER_PAGE = 250
// Backstop against paginating forever if the API stops returning empty pages
// to signal the end (~18k coins listed as of mid-2026).
const MAX_PAGES = 200

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

function makeClient(key: string): Coingecko {
    return new Coingecko({
        demoAPIKey: key,
        environment: 'demo',
        timeout: REQUEST_TIMEOUT_MS,
        // Key rotation is the retry strategy: a 429 here means the key's
        // minute/month quota is gone, so waiting out the SDK's backoff just
        // stalls the sweep when switching keys recovers immediately.
        maxRetries: 0
    })
}

// Rotating key pool shared by every request in one fetch. Demo keys allow 30
// calls/min and a full sweep is ~70 calls, so one key cannot finish alone: on
// any failure the same request is retried with the next key, and only when
// every key has failed does the fetch abort.
class KeyPool {
    private index = 0
    private client: Coingecko
    private failures: string[] = []

    constructor(private keys: string[]) {
        this.client = makeClient(keys[0])
    }

    async call<T>(label: string, request: (client: Coingecko) => Promise<T>): Promise<T> {
        while (true) {
            try {
                return await request(this.client)
            } catch (err) {
                const key = redactKey(this.keys[this.index])
                const reason = describeError(err)
                this.failures.push(`${key}: ${reason}`)
                console.warn(`coingecko: key ${key} failed on ${label} (${reason}), trying next key`)

                this.index++
                if (this.index >= this.keys.length) {
                    throw new CoinGeckoError(
                        `all ${this.keys.length} API key(s) failed (while fetching ${label}) — ${this.failures.join('; ')}`
                    )
                }
                this.client = makeClient(this.keys[this.index])
            }
        }
    }
}

// Fiat comes from /exchange_rates (clean ISO codes, values quoted per BTC),
// converted to units-per-USD by dividing by the USD entry.
async function fetchFiatRates(pool: KeyPool): Promise<CurrencyRates[]> {
    const response = await pool.call('exchange_rates', (client) => client.exchangeRates.get())

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

// Crypto comes from the paginated market sweep, every listed coin priced
// against USD.
async function fetchCryptoRates(pool: KeyPool, takenCodes: Set<string>): Promise<CurrencyRates[]> {
    const parsed: CurrencyRates[] = []
    const seenCodes = new Set(takenCodes)

    for (let page = 1; page <= MAX_PAGES; page++) {
        const coins = await pool.call(`markets page ${page}`, (client) =>
            client.coins.markets.get({
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: COINS_PER_PAGE,
                page
            })
        )

        if (coins.length === 0) break

        for (const coin of coins) {
            const code = coin.symbol?.toUpperCase()
            const price = coin.current_price

            // Pages are market-cap ordered and symbols are not unique (many
            // wrapped or bridged tokens reuse BTC, ETH, ...), so the first
            // occurrence wins — and fiat codes are pre-seeded into the set so
            // no token can shadow a real currency.
            if (!code || !Number.isFinite(price) || price! <= 0 || seenCodes.has(code)) {
                continue
            }

            seenCodes.add(code)
            parsed.push({
                code,
                // Invert the USD price so the value means "units of this coin
                // per 1 USD", matching the currencyapi source.
                rate: 1 / price!
            })
        }
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

    const pool = new KeyPool(keys)

    const fiat = await fetchFiatRates(pool)
    const crypto = await fetchCryptoRates(pool, new Set(fiat.map((entry) => entry.code)))

    if (crypto.length === 0) {
        throw new CoinGeckoError('no usable crypto rates in market sweep')
    }

    return [...fiat, ...crypto]
}
