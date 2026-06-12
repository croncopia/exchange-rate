# exchange-rate

![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fcroncopia%2Fexchange-rate%2Frefs%2Fheads%2Fmain%2Fstats.json&query=symbol_count&label=Tracked%20Fiat&cacheSeconds=20&style=flat-square&labelColor=%235C6E45&color=%23F3EAD6)
![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fcroncopia%2Fexchange-rate%2Frefs%2Fheads%2Fmain%2Fstats.json&query=source_count&label=Sources&cacheSeconds=20&style=flat-square&labelColor=%235C6E45&color=%23F3EAD6)
![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fcroncopia%2Fexchange-rate%2Frefs%2Fheads%2Fmain%2Fstats.json&query=timestamp&label=Last%20Updated&cacheSeconds=20&style=flat-square&labelColor=%235C6E45&color=%23F3EAD6)


Aggregated fiat exchange rates, rebuilt every 30 minutes from diffrent providers and published as static JSON — one file per currency, no API key required to consume.

## How it works

1. **Fetch** — each source module pulls the latest rates from its provider and normalises them to a common convention: *units of currency per 1 USD*. 
2. **Filter** — only fiat currencies pass into the aggregate. An ISO 4217 whitelist is enforced at a single choke point, which also stops crypto tokens that reuse fiat-looking ticker symbols from polluting real currencies.
3. **Aggregate** — sources are fetched concurrently and each may fail independently; the run continues as long as at least one source delivers. Per currency, the rates are averaged — and when 3+ sources report, any rate deviating more than 10% from the median is discarded as an outlier before averaging.
4. **Distribute** — one JSON file is written per currency. Since every rate is USD-based, the cross rate for any base is a single division: a currency's file divides every other rate by its own.
