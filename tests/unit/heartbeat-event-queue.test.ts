import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { HeartbeatEventQueue } from '../../src/memory/heartbeat-event-queue.ts';

function tempQueuePath(): string {
    return join(fs.mkdtempSync(join(os.tmpdir(), 'jaw-heartbeat-events-')), 'deep-work-events.json');
}

test('heartbeat event queue settles only events created during the current run', () => {
    const filePath = tempQueuePath();
    fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        events: [
            { id: 'old', createdAt: 100, updatedAt: 100, status: 'pending', fallbackText: 'old' },
            { id: 'current', createdAt: 200, updatedAt: 200, status: 'pending', fallbackText: 'current' },
        ],
    }));

    const queue = new HeartbeatEventQueue(filePath);
    const current = queue.pendingSince(150);
    assert.deepEqual(current.map(event => event.id), ['current']);
    queue.mark(current.map(event => event.id), 'delivered_by_arona', 250);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(stored.events[0].status, 'pending');
    assert.equal(stored.events[1].status, 'delivered_by_arona');
});
