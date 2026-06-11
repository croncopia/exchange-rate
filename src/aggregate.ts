import currencyapi from './sources/currencyapi'
import coingecko from './sources/coingecko'
import openexchangerates from './sources/openexchangerates'
import currencylayer from './sources/currencylayer'

import { CurrencyRates } from './types/types'

// A rate is an outlier when it strays more than this fraction from the median
// of its sources. Relative (not absolute) deviation, because rates span ten
// orders of magnitude across currencies.
const OUTLIER_THRESHOLD = 0.1
// With fewer than 3 rates there is no majority to define "normal", so nothing
// is discarded.
const MIN_RATES_FOR_OUTLIER_CHECK = 3

// Each source handles its own key rotation and throws once its keys are
// exhausted; the aggregate tolerates individual sources failing.
const SOURCES: { name: string; fetch: () => Promise<CurrencyRates[]> }[] = [
    { name: 'currencyapi', fetch: currencyapi },
    { name: 'coingecko', fetch: coingecko },
    { name: 'openexchangerates', fetch: openexchangerates },
    { name: 'currencylayer', fetch: currencylayer }
]

export interface SourceRate {
    source: string
    rate: number
    outlier?: boolean
}

export interface AggregatedRate {
    avg: number
    rates: SourceRate[]
}

export interface AggregatedRates {
    [code: string]: AggregatedRate
}

export class AggregationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AggregationError'
    }
}

function addRates(data: AggregatedRates, source: string, rates: CurrencyRates[]): void {
    for (const rate of rates) {
        if (!data[rate.code]) {
            data[rate.code] = { avg: 0, rates: [] }
        }

        data[rate.code].rates.push({ source, rate: rate.rate })
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function calculateAverageRates(data: AggregatedRates): void {
    for (const code in data) {
        const entry = data[code]
        let usable = entry.rates

        if (entry.rates.length >= MIN_RATES_FOR_OUTLIER_CHECK) {
            const mid = median(entry.rates.map((r) => r.rate))

            for (const r of entry.rates) {
                r.outlier = Math.abs(r.rate - mid) / mid > OUTLIER_THRESHOLD
            }

            usable = entry.rates.filter((r) => !r.outlier)

            // With an even count the median sits between two values, and if
            // sources disagree wildly every rate can exceed the threshold —
            // fall back to the median rather than averaging nothing.
            if (usable.length === 0) {
                entry.avg = mid
                continue
            }
        }

        const rates = usable.map((r) => r.rate)
        entry.avg = rates.reduce((a, b) => a + b, 0) / rates.length
    }
}

export default async function aggregate(): Promise<AggregatedRates> {
    // Per-call state so repeated calls (e.g. on a refresh interval) never
    // accumulate rates from earlier runs.
    const data: AggregatedRates = {}

    // The sources hit unrelated APIs, so fetch them concurrently and let each
    // succeed or fail on its own.
    const results = await Promise.allSettled(SOURCES.map((source) => source.fetch()))

    const failed: string[] = []

    results.forEach((result, index) => {
        const name = SOURCES[index].name

        if (result.status === 'fulfilled') {
            addRates(data, name, result.value)
        } else {
            failed.push(name)
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
            console.error(`aggregate: source ${name} failed: ${reason}`)
        }
    })

    if (failed.length === SOURCES.length) {
        throw new AggregationError(`all ${SOURCES.length} sources failed`)
    }

    if (failed.length > 0) {
        console.warn(
            `aggregate: continuing with ${SOURCES.length - failed.length}/${SOURCES.length} sources (failed: ${failed.join(', ')})`
        )
    }

    calculateAverageRates(data)

    return data
}
