declare module '@everapi/currencyapi-js' {
    export default class CurrencyAPI {
        constructor(apiKey?: string)
        status(): Promise<any>
        currencies(params?: Record<string, unknown>): Promise<any>
        latest(params?: Record<string, unknown>): Promise<any>
        historical(params?: Record<string, unknown>): Promise<any>
        range(params?: Record<string, unknown>): Promise<any>
        convert(params?: Record<string, unknown>): Promise<any>
    }
}
