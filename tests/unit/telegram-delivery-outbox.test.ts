import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistTelegramOutbox } from '../../src/telegram/delivery-outbox.js';

test('persists deferred Telegram payload atomically and deduplicates repeats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-tg-outbox-'));
    try {
        const request = { channel: 'telegram' as const, type: 'text' as const, text: 'important briefing', chatId: '7' };
        const first = persistTelegramOutbox(request, 'limited', 30, dir);
        const second = persistTelegramOutbox(request, 'still limited', 25, dir);
        assert.equal(first, second);
        const files = fs.readdirSync(dir);
        assert.deepEqual(files, [`${first}.json`]);
        const file = path.join(dir, files[0]!);
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(record.occurrences, 2);
        assert.equal(record.retryAfter, 25);
        assert.equal(record.request.text, 'important briefing');
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

