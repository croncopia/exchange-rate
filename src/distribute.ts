import fs from 'fs/promises'
import path from 'path'
import { AggregatedRates } from './aggregate'

const OUTPUT_DIR = './output'

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

        if (!SAFE_CODE.test(base)) {
            skippedUnsafeName.push(base)
            continue
        }

        // Both sides are units-per-USD, so dividing by the base's rate
        // re-expresses every symbol in units per 1 unit of the base. For the
        // USD file the divisor is 1 and the rates pass through unchanged.
        const rates: Record<string, number> = {}
        for (const [code, rate] of usable) {
            rates[code] = rate / baseRate
        }

        const file: SymbolFile = { base, timestamp, rates }

        written.add(base)
        queue.push(writeFileAtomic(path.join(outputDir, `${base}.json`), JSON.stringify(file)))

        if (queue.length >= WRITE_CONCURRENCY) {
            await Promise.all(queue)
            queue = []
        }
    }

    await Promise.all(queue)

    if (written.size === 0) {
        throw new DistributeError('no symbol files written — every requested base was skipped')
    }

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
