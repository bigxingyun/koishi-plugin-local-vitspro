/** 并发执行，保持返回顺序；单个任务的异常不会中断其它任务 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    task: (item: T, index: number) => Promise<R>
): Promise<(R | Error)[]> {
    const results: (R | Error)[] = new Array(items.length)
    const size = Math.max(1, Math.min(limit, items.length || 1))
    let cursor = 0

    const worker = async () => {
        while (true) {
            const index = cursor++
            if (index >= items.length) return
            try {
                results[index] = await task(items[index], index)
            } catch (error) {
                results[index] = error instanceof Error ? error : new Error(String(error))
            }
        }
    }

    await Promise.all(Array.from({ length: size }, () => worker()))
    return results
}

/** 带超时的 Promise 包装：超时抛 TIMEOUT 语义的错误 */
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label = 'request'
): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return promise

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out after ${ms}ms`)
            ;(error as any).code = 'ETIMEDOUT'
            reject(error)
        }, ms)
        // 不阻止进程退出
        if (typeof timer === 'object' && timer && 'unref' in timer) {
            ;(timer as any).unref?.()
        }
    })

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    }) as Promise<T>
}
