import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    TelegramCooldownError,
    TelegramDeliveryGuard,
    isTelegramParseError,
    isTelegramRateLimitError,
    telegramRetryAfter,
} from '../../src/telegram/delivery-guard.js';

function tempState(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-tg-delivery-'));
    return { dir, file: path.join(dir, 'telegram-delivery.json') };
}

test('serializes same-token deliveries and spaces a chat by 1.1 seconds', async () => {
    const tmp = tempState();
    let now = 10_000;
    const starts: number[] = [];
    const guard = new TelegramDeliveryGuard({
        statePath: tmp.file,
        now: () => now,
        sleep: async ms => { now += ms; },
    });
    try {
        await Promise.all([
            guard.run('token-a', 'chat-1', async () => { starts.push(now); }),
            guard.run('token-a', 'chat-1', async () => { starts.push(now); }),
            guard.run('token-a', 'chat-1', async () => { starts.push(now); }),
        ]);
        assert.deepEqual(starts, [10_000, 11_100, 12_200]);
    } finally {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
});

test('persists cooldown by token hash and blocks without invoking operation', async () => {
    const tmp = tempState();
    let now = 20_000;
    try {
        const first = new TelegramDeliveryGuard({ statePath: tmp.file, now: () => now });
        first.recordCooldown('secret-token', 30);

        const raw = fs.readFileSync(tmp.file, 'utf8');
        assert.equal(raw.includes('secret-token'), false);
        assert.equal(fs.statSync(tmp.file).mode & 0o777, 0o600);

        const resumed = new TelegramDeliveryGuard({ statePath: tmp.file, now: () => now });
        let calls = 0;
        await assert.rejects(
            resumed.run('secret-token', 'chat-1', async () => { calls += 1; }),
            (err: unknown) => err instanceof TelegramCooldownError && err.parameters.retry_after === 30,
        );
        assert.equal(calls, 0);

        now += 30_000;
        await resumed.run('secret-token', 'chat-1', async () => { calls += 1; });
        assert.equal(calls, 1);
    } finally {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
});

test('transformer records JSON parameters.retry_after and suppresses the next API call', async () => {
    const tmp = tempState();
    let now = 50_000;
    const guard = new TelegramDeliveryGuard({ statePath: tmp.file, now: () => now, sleep: async ms => { now += ms; } });
    const transformer = guard.transformer('token-a') as any;
    let calls = 0;
    const limited = async () => {
        calls += 1;
        return { ok: false, error_code: 429, description: 'limited', parameters: { retry_after: 45 } };
    };
    try {
        const response = await transformer(limited, 'sendMessage', { chat_id: 7, text: 'hello' });
        assert.equal(response.error_code, 429);
        assert.equal(calls, 1);
        assert.equal(guard.cooldownRemaining('token-a'), 45);

        await assert.rejects(
            transformer(limited, 'sendMessage', { chat_id: 7, text: 'again' }),
            (err: unknown) => isTelegramRateLimitError(err) && telegramRetryAfter(err) === 45,
        );
        assert.equal(calls, 1);
    } finally {
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
});

test('plain-text fallback classification is limited to Telegram parse errors', () => {
    assert.equal(isTelegramParseError({ error_code: 400, message: "Bad Request: can't parse entities" }), true);
    assert.equal(isTelegramParseError({ error_code: 429, message: "can't parse entities", parameters: { retry_after: 3 } }), false);
    assert.equal(isTelegramRateLimitError({ error_code: 429, parameters: { retry_after: 3 } }), true);
});

