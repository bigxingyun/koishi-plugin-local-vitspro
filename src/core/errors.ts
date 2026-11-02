import { DegradeCode, ErrorClass } from '../types'

/**
 * 降级错误：`code` 用于调用方/日志区分原因，`text` 是已归一化的纯文本，
 * 调用方（如 chatluna-character）若想自行兜底可以直接用。
 */
export class VitsDegradeError extends Error {
    readonly code: DegradeCode
    readonly text: string

    constructor(code: DegradeCode, text: string, message?: string) {
        super(message ?? `${code}: ${text.slice(0, 40)}`)
        this.name = 'VitsDegradeError'
        this.code = code
        this.text = text
    }
}

/** 适配器抛出的、带语义分类的错误 */
export class BackendError extends Error {
    readonly errorClass: ErrorClass
    readonly status?: number

    constructor(
        errorClass: ErrorClass,
        message: string,
        status?: number,
        options?: { cause?: unknown }
    ) {
        super(message)
        this.name = 'BackendError'
        this.errorClass = errorClass
        if (status != null) this.status = status
        if (options?.cause !== undefined) (this as any).cause = options.cause
    }
}

/**
 * 把任意异常归类成熔断用的 6 种语义。
 * 只依赖 axios 的错误形状（status / code / message），不绑定具体 http 实现。
 */
export function classifyError(error: unknown): ErrorClass {
    if (error instanceof BackendError) return error.errorClass
    if (error instanceof VitsDegradeError) {
        switch (error.code) {
            case 'TIMEOUT':
                return 'TIMEOUT'
            case 'BACKEND_ERROR':
                return 'SERVER'
            default:
                return 'BAD_REQUEST'
        }
    }

    const err = error as any
    const status: number | undefined =
        err?.status ?? err?.response?.status ?? undefined

    if (status != null) {
        if (status === 401 || status === 403) return 'AUTH'
        if (status === 400 || status === 422) return 'BAD_REQUEST'
        if (status >= 500) return 'SERVER'
        if (status >= 400) return 'BAD_REQUEST'
    }

    const code: string = String(err?.code ?? '')
    if (
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH' ||
        code === 'ECONNRESET' ||
        code === 'EPIPE'
    ) {
        return 'CONNECT'
    }

    if (
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        code === 'ERR_CANCELED' ||
        /timeout/i.test(String(err?.message ?? ''))
    ) {
        return 'TIMEOUT'
    }

    return 'SERVER'
}

