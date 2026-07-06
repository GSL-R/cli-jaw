import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientTelegramNetworkError, sendTelegramTextWithRetry } from '../../src/telegram/telegram-text.js';

test('detects nested ECONNRESET from grammY HttpError', () => {
    const error = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
        error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    assert.equal(isTransientTelegramNetworkError(error), true);
});

test('retries a transient text delivery once and returns the result', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await sendTelegramTextWithRetry(async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return 'sent';
    }, { sleep: async ms => { sleeps.push(ms); } });

    assert.equal(result, 'sent');
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [1000]);
});

test('does not retry Telegram cooldown errors', async () => {
    let attempts = 0;
    const error = Object.assign(new Error('cooldown'), {
        code: 'TELEGRAM_COOLDOWN',
        error_code: 429,
        parameters: { retry_after: 30 },
    });
    await assert.rejects(
        sendTelegramTextWithRetry(async () => { attempts++; throw error; }, { sleep: async () => {} }),
        error,
    );
    assert.equal(attempts, 1);
});

test('does not retry permanent Telegram API errors', async () => {
    let attempts = 0;
    const error = Object.assign(new Error('Bad Request'), { error_code: 400 });
    await assert.rejects(
        sendTelegramTextWithRetry(async () => { attempts++; throw error; }, { sleep: async () => {} }),
        error,
    );
    assert.equal(attempts, 1);
});
