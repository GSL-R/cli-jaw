import { isTelegramRateLimitError } from './delivery-guard.js';

type ErrorLike = {
    code?: string;
    message?: string;
    constructor?: { name?: string };
    error?: unknown;
    cause?: unknown;
};

function errorLike(value: unknown): ErrorLike {
    return value && typeof value === 'object' ? value as ErrorLike : {};
}

export function isTransientTelegramNetworkError(err: unknown): boolean {
    if (isTelegramRateLimitError(err)) return false;
    const pending = [err];
    const seen = new Set<unknown>();
    while (pending.length) {
        const value = pending.shift();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const current = errorLike(value);
        if (current.constructor?.name === 'HttpError') return true;
        if (/^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH)$/i.test(current.code || '')) {
            return true;
        }
        if (/network request|socket hang up|fetch failed/i.test(current.message || '')) return true;
        if (current.error) pending.push(current.error);
        if (current.cause) pending.push(current.cause);
    }
    return false;
}

export async function sendTelegramTextWithRetry<T>(
    operation: () => Promise<T>,
    options: {
        maxAttempts?: number;
        delayMs?: number;
        sleep?: (ms: number) => Promise<void>;
        label?: string;
    } = {},
): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    const delayMs = Math.max(0, options.delayMs ?? 1000);
    const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (err: unknown) {
            if (!isTransientTelegramNetworkError(err) || attempt >= maxAttempts) throw err;
            console.warn(`[telegram:text-retry] ${options.label || 'sendMessage'} attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms`);
            await sleep(delayMs);
        }
    }
}
