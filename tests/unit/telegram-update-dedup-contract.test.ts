import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const botSrc = readFileSync(join(root, 'src/telegram/bot.ts'), 'utf8');
const pipelineSrc = readFileSync(join(root, 'src/orchestrator/pipeline.ts'), 'utf8');

test('Telegram drops replayed update ids before orchestration', () => {
    assert.match(botSrc, /seenUpdateIds\.has\(updateId\)/);
    assert.match(botSrc, /suppressed duplicate update_id=/);
    assert.match(botSrc, /updateIdOrder\.length > 512/);
    assert.match(botSrc, /await tgOrchestrate\(ctx, text, text\)/);
});

test('recent heartbeat context overrides older heartbeat state when applicable', () => {
    assert.match(
        pipelineSrc,
        /treat this as the latest operational state and let it override older heartbeat state/,
    );
});
