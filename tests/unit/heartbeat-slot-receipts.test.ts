import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { HeartbeatSlotReceiptStore } from '../../src/memory/heartbeat-slot-receipts.ts';

function tempReceiptPath(): string {
    return join(fs.mkdtempSync(join(os.tmpdir(), 'jaw-heartbeat-receipts-')), 'state', 'heartbeat-slot-receipts.json');
}

test('heartbeat slot receipts survive a new store and suppress the same cron slot', () => {
    const filePath = tempReceiptPath();
    const first = new HeartbeatSlotReceiptStore(filePath);

    assert.equal(first.claim('deep-work-start', '2026-07-10 09:00 Asia/Seoul', 1_000), true);
    first.finish('deep-work-start', '2026-07-10 09:00 Asia/Seoul', 'completed', 1_100);

    const afterReload = new HeartbeatSlotReceiptStore(filePath);
    assert.equal(afterReload.claim('deep-work-start', '2026-07-10 09:00 Asia/Seoul', 1_200), false);
    assert.equal(afterReload.claim('deep-work-start', '2026-07-10 09:10 Asia/Seoul', 1_200), true);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(stored.receipts['deep-work-start\u00002026-07-10 09:00 Asia/Seoul'].status, 'completed');
});

test('heartbeat slot receipts prune expired slots before claiming', () => {
    const filePath = tempReceiptPath();
    const receipts = new HeartbeatSlotReceiptStore(filePath, 100);

    assert.equal(receipts.claim('daily', '2026-07-10 09:00 Asia/Seoul', 1_000), true);
    assert.equal(receipts.claim('daily', '2026-07-10 09:00 Asia/Seoul', 1_101), true);
});
