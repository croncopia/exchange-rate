import fs from 'fs/promises'
import path from 'path'
import { AggregatedRates } from './aggregate'

const OUTPUT_DIR = './out'

// The index and stats live in the repo root, next to the output dir — not
// inside it — so they survive a prune and sit at a stable, well-known path.
const INDEX_FILE = './out/index.json'
const STATS_FILE = './stats.json'

// Where each symbol file ends up once published; written into index.json so
// consumers can resolve a symbol to its URL. <symbol> is replaced per file.
const LOCATION_TEMPLATE =
    'https://raw.githubusercontent.com/NotReeceHarris/live-exchange-rate/refs/heads/main/latest/<symbol>.json'

// Codes come from external APIs and include unicode, "$", dots, spaces and
// worse — only codes matching this pattern get their own file. Unsafe codes
// still appear as entries inside every other file's rates map.
const SAFE_CODE = /^[A-Z0-9_-]{1,32}$/

// Cap on simultaneous file writes so ~11k files don't exhaust descriptors.
const WRITE_CONCURRENCY = 64

export interface DistributeOptions {
    // Directory the per-symbol files are written to.
    outputDir?: string
    // Which symbols get a file. Defaults to every usable symbol — note that
    // the full matrix is symbols², roughly 4GB for ~11k symbols. Pass e.g.
    // the fiat codes to keep the output small.
    bases?: string[]
    // Delete files in outputDir for symbols not written this run, so symbols
    // that disappear upstream don't linger with stale rates. Only applied
    // when distributing the default (full) base list, otherwise a partial run
    // would wipe the other bases' files.
    prune?: boolean
}

export interface DistributeResult {
    outputDir: string
    written: number
    skippedUnsafeName: string[]
    skippedUnusableRate: string[]
    pruned: number
}

export class DistributeError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DistributeError'
    }
}

interface SymbolFile {
    base: string
    timestamp: string
    rates: Record<string, number>
}

function ordinalSuffix(day: number): string {
    if (day % 100 >= 11 && day % 100 <= 13) return 'th'
    switch (day % 10) {
        case 1: return 'st'
        case 2: return 'nd'
        case 3: return 'rd'
        default: return 'th'
    }
}

// "11th July @ 14:52", in UTC so runs from any machine or CI agree.
function formatTimestamp(date: Date): string {
    const day = date.getUTCDate()
    const month = date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })
    const hours = String(date.getUTCHours()).padStart(2, '0')
    const minutes = String(date.getUTCMinutes()).padStart(2, '0')
    return `${day}${ordinalSuffix(day)} ${month} @ ${hours}:${minutes}`
}

// Write via a temp file and rename so a crash mid-write can never leave a
// truncated JSON file where a consumer expects a valid one.
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, contents)
    await fs.rename(tmpPath, filePath)
}

export default async function distribute(
    data: AggregatedRates,
    options: DistributeOptions = {}
): Promise<DistributeResult> {
    const outputDir = options.outputDir ?? OUTPUT_DIR

    const usable = new Map<string, number>()
    const skippedUnusableRate: string[] = []

    for (const [code, entry] of Object.entries(data)) {
        if (Number.isFinite(entry.avg) && entry.avg > 0) {
            usable.set(code, entry.avg)
        } else {
            skippedUnusableRate.push(code)
        }
    }

    if (usable.size === 0) {
        throw new DistributeError('no usable rates to distribute')
    }

    const bases = options.bases ?? [...usable.keys()]
    const timestamp = new Date().toISOString()

    const skippedUnsafeName: string[] = []
    const written = new Set<string>()
    let queue: Promise<void>[] = []

    await fs.mkdir(outputDir, { recursive: true })

    for (const base of bases) {
        const baseRate = usable.get(base)

        if (baseRate === undefined) {
            skippedUnusableRate.push(base)
            continue
        }

        // Filenames are uppercase; checking the pattern after uppercasing
        // also rescues codes a source delivered in lowercase. Two codes that
        // differ only in case would map to the same file — first one wins.
        const fileCode = base.toUpperCase()

        if (!SAFE_CODE.test(fileCode)) {
            skippedUnsafeName.push(base)
            continue
        }

        if (written.has(fileCode)) {
            console.warn(`distribute: skipping ${base} — ${fileCode}.json already written this run`)
            continue
        }

        // Both sides are units-per-USD, so dividing by the base's rate
        // re-expresses every symbol in units per 1 unit of the base. For the
        // USD file the divisor is 1 and the rates pass through unchanged.
        const rates: Record<string, number> = {}
        for (const [code, rate] of usable) {
            rates[code] = rate / baseRate
        }

        const file: SymbolFile = { base: fileCode, timestamp, rates }

        written.add(fileCode)
        queue.push(writeFileAtomic(path.join(outputDir, `${fileCode}.json`), JSON.stringify(file)))

        if (queue.length >= WRITE_CONCURRENCY) {
            await Promise.all(queue)
            queue = []
        }
    }

    await Promise.all(queue)

    if (written.size === 0) {
        throw new DistributeError('no symbol files written — every requested base was skipped')
    }

    // index.json lists every symbol that got a file this run and where each
    // file lives once published. Sorted for stable diffs between runs.
    const symbols = [...written].sort()
    const locations: Record<string, string> = {}
    for (const symbol of symbols) {
        locations[symbol] = LOCATION_TEMPLATE.replace('<symbol>', symbol)
    }

    await writeFileAtomic(INDEX_FILE, JSON.stringify({ symbols, locations }))

    // Quick at-a-glance stats; anything deeper belongs in the data itself.
    const sources = new Set<string>()
    let multiSourceSymbols = 0
    let outliersDiscarded = 0

    for (const entry of Object.values(data)) {
        for (const rate of entry.rates) {
            sources.add(rate.source)
            if (rate.outlier) outliersDiscarded++
        }
        if (entry.rates.length > 1) multiSourceSymbols++
    }

    const stats = {
        symbol_count: written.size,
        timestamp: formatTimestamp(new Date()),
        sources: [...sources].sort(),
        source_count: sources.size,
        multi_source_symbols: multiSourceSymbols,
        outliers_discarded: outliersDiscarded
    }

    await writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 4))

    let pruned = 0
    if (options.prune && options.bases === undefined) {
        for (const fileName of await fs.readdir(outputDir)) {
            const code = fileName.replace(/\.json$/, '')
            const isSymbolFile = fileName.endsWith('.json') && SAFE_CODE.test(code)

            if (isSymbolFile && !written.has(code)) {
                await fs.unlink(path.join(outputDir, fileName))
                pruned++
            }
        }
    }

    return {
        outputDir,
        written: written.size,
        skippedUnsafeName,
        skippedUnusableRate,
        pruned
    }
}
