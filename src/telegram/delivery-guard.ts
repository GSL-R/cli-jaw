import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Transformer } from 'grammy';
import { JAW_HOME } from '../core/config.js';

type CooldownEntry = {
    blockedUntil: number;
    retryAfter: number;
    updatedAt: string;
};

type CooldownState = {
    version: 1;
    tokens: Record<string, CooldownEntry>;
};

type DeliveryGuardOptions = {
    statePath?: string;
    minChatIntervalMs?: number;
    minGlobalIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};

type TelegramErrorLike = {
    error_code?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    description?: string;
    parameters?: { retry_after?: number };
};

const DELIVERY_METHODS = new Set([
    'sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendVideo',
    'sendAudio', 'sendAnimation', 'sendMediaGroup', 'sendChatAction',
    'editMessageText', 'editMessageCaption', 'editMessageMedia',
    'editMessageReplyMarkup', 'deleteMessage',
]);

function asTelegramError(err: unknown): TelegramErrorLike {
    return err && typeof err === 'object' ? err as TelegramErrorLike : {};
}

export function telegramErrorCode(err: unknown): number | undefined {
    const value = asTelegramError(err).error_code ?? asTelegramError(err).statusCode;
    return typeof value === 'number' ? value : undefined;
}

export function telegramRetryAfter(err: unknown): number {
    const value = asTelegramError(err).parameters?.retry_after;
    return Number.isFinite(value) && Number(value) > 0 ? Math.ceil(Number(value)) : 0;
}

export function isTelegramRateLimitError(err: unknown): boolean {
    return telegramErrorCode(err) === 429 || asTelegramError(err).code === 'TELEGRAM_COOLDOWN';
}

export function isTelegramParseError(err: unknown): boolean {
    if (telegramErrorCode(err) !== 400) return false;
    const message = String(asTelegramError(err).description || asTelegramError(err).message || '');
    return /parse|entity|entities|can't find end|unsupported start tag/i.test(message);
}

export class TelegramCooldownError extends Error {
    readonly code = 'TELEGRAM_COOLDOWN';
    readonly error_code = 429;
    readonly statusCode = 429;
    readonly parameters: { retry_after: number };

    constructor(retryAfter: number) {
        super(`Telegram delivery is cooling down; retry after ${retryAfter}s`);
        this.name = 'TelegramCooldownError';
        this.parameters = { retry_after: retryAfter };
    }
}

export class TelegramDeliveryGuard {
    private readonly statePath: string;
    private readonly minChatIntervalMs: number;
    private readonly minGlobalIntervalMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly tails = new Map<string, Promise<void>>();
    private readonly lastGlobalStart = new Map<string, number>();
    private readonly lastChatStart = new Map<string, number>();
    private state: CooldownState;

    constructor(options: DeliveryGuardOptions = {}) {
        this.statePath = options.statePath || path.join(JAW_HOME, 'state', 'telegram-delivery.json');
        this.minChatIntervalMs = options.minChatIntervalMs ?? 1100;
        this.minGlobalIntervalMs = options.minGlobalIntervalMs ?? 40;
        this.now = options.now || Date.now;
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.state = this.loadState();
    }

    private tokenKey(token: string): string {
        return createHash('sha256').update(token).digest('hex').slice(0, 16);
    }

    private loadState(): CooldownState {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as CooldownState;
            if (parsed?.version === 1 && parsed.tokens && typeof parsed.tokens === 'object') return parsed;
        } catch { /* missing or invalid state starts clean */ }
        return { version: 1, tokens: {} };
    }

    private saveState(): void {
        const dir = path.dirname(this.statePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.statePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.statePath);
        try { fs.chmodSync(this.statePath, 0o600); } catch { /* best effort */ }
    }

    cooldownRemaining(token: string): number {
        const key = this.tokenKey(token);
        const entry = this.state.tokens[key];
        if (!entry) return 0;
        const remaining = Math.ceil((entry.blockedUntil - this.now()) / 1000);
        if (remaining > 0) return remaining;
        delete this.state.tokens[key];
        this.saveState();
        return 0;
    }

    recordCooldown(token: string, retryAfter: number): void {
        if (!Number.isFinite(retryAfter) || retryAfter <= 0) return;
        const key = this.tokenKey(token);
        const blockedUntil = this.now() + Math.ceil(retryAfter) * 1000;
        const current = this.state.tokens[key];
        if (current && current.blockedUntil >= blockedUntil) return;
        this.state.tokens[key] = {
            blockedUntil,
            retryAfter: Math.ceil(retryAfter),
            updatedAt: new Date(this.now()).toISOString(),
        };
        this.saveState();
    }

    async run<T>(token: string, chatId: string, operation: () => Promise<T>, label = 'delivery'): Promise<T> {
        const enqueuedAt = this.now();
        const tokenKey = this.tokenKey(token);
        const chatKey = `${tokenKey}:${chatId}`;
        const previous = this.tails.get(tokenKey) || Promise.resolve();
        let release!: () => void;
        const slot = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.catch(() => undefined).then(() => slot);
        this.tails.set(tokenKey, tail);

        await previous.catch(() => undefined);
        try {
            const remaining = this.cooldownRemaining(token);
            if (remaining > 0) throw new TelegramCooldownError(remaining);

            const now = this.now();
            const globalWait = (this.lastGlobalStart.get(tokenKey) || 0) + this.minGlobalIntervalMs - now;
            const chatWait = (this.lastChatStart.get(chatKey) || 0) + this.minChatIntervalMs - now;
            const waitMs = Math.max(0, globalWait, chatWait);
            if (waitMs > 0) await this.sleep(waitMs);

            const startedAt = this.now();
            this.lastGlobalStart.set(tokenKey, startedAt);
            this.lastChatStart.set(chatKey, startedAt);
            try {
                return await operation();
            } finally {
                const completedAt = this.now();
                const queueWaitMs = Math.max(0, startedAt - enqueuedAt);
                const durationMs = Math.max(0, completedAt - startedAt);
                if (queueWaitMs >= 250 || durationMs >= 5000) {
                    console.log(`[telegram:delivery] method=${label} queueWaitMs=${queueWaitMs} durationMs=${durationMs}`);
                }
            }
        } finally {
            release();
            if (this.tails.get(tokenKey) === tail) this.tails.delete(tokenKey);
        }
    }

    transformer(token: string): Transformer {
        return async (prev, method, payload, signal) => {
            if (!DELIVERY_METHODS.has(method)) return prev(method, payload, signal);
            const chatId = String((payload as Record<string, unknown>)['chat_id'] ?? 'global');
            return this.run(token, chatId, async () => {
                const response = await prev(method, payload, signal);
                if (!response.ok && response.error_code === 429) {
                    const retryAfter = Number(response.parameters?.retry_after || 0);
                    this.recordCooldown(token, retryAfter);
                }
                return response;
            }, method);
        };
    }
}

export const telegramDeliveryGuard = new TelegramDeliveryGuard();

export function installTelegramDeliveryGuard(bot: { api: { config: { use: (transformer: Transformer) => unknown } } }, token: string): void {
    bot.api.config.use(telegramDeliveryGuard.transformer(token));
}
