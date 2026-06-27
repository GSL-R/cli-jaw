import assert from 'node:assert/strict';
import test from 'node:test';
import { composeAgyPrompt, resolveAgyPromptOrder } from '../../src/agent/agy-prompt.js';


test('AGY-PROMPT-001: task-first remains the compatibility default', () => {
    const prompt = composeAgyPrompt('CURRENT', 'SYSTEM');
    assert.ok(prompt.startsWith('[Current cli-jaw task]\nCURRENT'));
    assert.ok(prompt.endsWith('SYSTEM'));
});

test('AGY-PROMPT-002: context-first keeps stable instructions first and current task last', () => {
    const prompt = composeAgyPrompt('HISTORY\nCURRENT', 'SYSTEM', 'context-first');
    assert.ok(prompt.startsWith('[Operational Context — cli-jaw Integration]'));
    assert.ok(prompt.indexOf('SYSTEM') < prompt.indexOf('HISTORY'));
    assert.ok(prompt.endsWith('[Current cli-jaw task]\nHISTORY\nCURRENT'));
});

test('AGY-PROMPT-003: unknown settings fail closed to task-first', () => {
    assert.equal(resolveAgyPromptOrder('context-first'), 'context-first');
    assert.equal(resolveAgyPromptOrder('task-first'), 'task-first');
    assert.equal(resolveAgyPromptOrder('unknown'), 'task-first');
    assert.equal(resolveAgyPromptOrder(undefined), 'task-first');
});

test('AGY-PROMPT-004: no system prompt leaves the task untouched', () => {
    assert.equal(composeAgyPrompt('CURRENT', '', 'context-first'), 'CURRENT');
});
