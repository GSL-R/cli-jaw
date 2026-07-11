import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getFlushStatus,
    incrementMemoryFlush,
    resetMemoryFlushCounter,
} from '../../src/agent/memory-flush-controller.js';

test('session refresh resets the turn counter without recording a flush cycle', () => {
    const initialCycles = getFlushStatus().cycleCount;

    incrementMemoryFlush();
    incrementMemoryFlush();
    resetMemoryFlushCounter(false);

    const refreshed = getFlushStatus();
    assert.equal(refreshed.counter, 0);
    assert.equal(refreshed.cycleCount, initialCycles);

    resetMemoryFlushCounter();
    assert.equal(getFlushStatus().cycleCount, initialCycles + 1);
});
