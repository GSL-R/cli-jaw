import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildAgySpillArgPrompt,
    buildAgySpillWorkspaceFiles,
    composeAgyPrompt,
    resolveAgyPromptOrder,
    serializeAgyCompactRoutes,
} from '../../src/agent/agy-prompt.js';


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

test('AGY-PROMPT-005: spill stores the full system prompt exactly once', () => {
    const files = buildAgySpillWorkspaceFiles('FULL_SYSTEM', '/project', 'CRITICAL');
    assert.match(files['AGENTS.md'], /FULL_SYSTEM/);
    assert.doesNotMatch(files['GEMINI.md'], /FULL_SYSTEM/);
    assert.doesNotMatch(files['CLAUDE.md'], /FULL_SYSTEM/);
    assert.doesNotMatch(files['CONTEXT.md'], /FULL_SYSTEM/);
    assert.match(files['GEMINI.md'], /CRITICAL/);
    assert.match(files['GEMINI.md'], /AGENTS\.md/);
});

test('AGY-PROMPT-006: compact routes stay bounded and reject malformed entries', () => {
    const routes = serializeAgyCompactRoutes({
        quest: 'daily quest -> /known/quest.md',
        'bad key!': 'ignored',
        empty: '   ',
        diary_pair: 'meaningful event -> diary_pair.py',
    }, 180);

    assert.match(routes, /^\[Canonical routes/);
    assert.match(routes, /quest:/);
    assert.match(routes, /diary_pair:/);
    assert.doesNotMatch(routes, /bad key/);
    assert.ok(Buffer.byteLength(routes, 'utf8') <= 180);
});

test('AGY-PROMPT-007: spill argv respects byte limit and preserves current task tail', () => {
    const prompt = buildAgySpillArgPrompt(
        `BOOT\n${'규칙'.repeat(3000)}`,
        `OLD\n${'과거'.repeat(5000)}\nCURRENT_TASK_TAIL`,
        12000,
    );

    assert.ok(Buffer.byteLength(prompt, 'utf8') <= 12000);
    assert.match(prompt, /Current Task Prompt/);
    assert.match(prompt, /CURRENT_TASK_TAIL$/);
});
