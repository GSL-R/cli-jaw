import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../../src/core/config.js';
import {
    beginDeliveryReceipt,
    completeDeliveryReceipt,
    getDeliveryReceipt,
    isValidDeliveryId,
} from '../../src/messaging/delivery-receipts.js';

test('delivery receipt persists pending to sent lifecycle', () => {
    const id = '019f0000-0000-7000-8000-000000000001';
    const dir = path.join(JAW_HOME, 'state', 'channel-deliveries');
    fs.rmSync(dir, { recursive: true, force: true });
    const pending = beginDeliveryReceipt(id, {
        channel: 'telegram',
        type: 'text',
        text: 'hello',
        chatId: '7',
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.request.contentBytes, 5);
    assert.equal(beginDeliveryReceipt(id, { channel: 'telegram', type: 'text', text: 'ignored' }).createdAt, pending.createdAt);

    const sent = completeDeliveryReceipt(id, 'sent', { ok: true });
    assert.equal(sent.status, 'sent');
    assert.equal(getDeliveryReceipt(id)?.result?.['ok'], true);
    assert.equal(fs.statSync(path.join(dir, `${id}.json`)).mode & 0o777, 0o600);
});
test('delivery receipt validates ids and preserves failed result', () => {
    assert.equal(isValidDeliveryId('../escape'), false);
    assert.equal(isValidDeliveryId('too-short'), false);
    const id = '019f0000-0000-7000-8000-000000000002';
    beginDeliveryReceipt(id, { channel: 'telegram', type: 'text', text: 'x' });
    const failed = completeDeliveryReceipt(id, 'failed', { error: 'network uncertain' });
    assert.equal(failed.error, 'network uncertain');
    assert.throws(() => getDeliveryReceipt('../escape'), /invalid_delivery_id/);
});
