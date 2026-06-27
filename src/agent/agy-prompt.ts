export type AgyPromptOrder = 'task-first' | 'context-first';

const AGY_PROMPT_FALLBACK_TEXT = 'Continue using the workspace instructions and proceed with the current task shown below.';

function utf8TruncateMiddle(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

    const marker = '\n\n[... cli-jaw truncated older middle context for AGY argv size ...]\n\n';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    if (maxBytes <= markerBytes) {
        let tail = '';
        let tailBytes = 0;
        for (const ch of Array.from(text).reverse()) {
            const bytes = Buffer.byteLength(ch, 'utf8');
            if (tailBytes + bytes > maxBytes) break;
            tail = ch + tail;
            tailBytes += bytes;
        }
        return tail;
    }

    const sideBudget = maxBytes - markerBytes;
    const headBudget = Math.floor(sideBudget * 0.35);
    const tailBudget = sideBudget - headBudget;

    let head = '';
    let headBytes = 0;
    for (const ch of text) {
        const bytes = Buffer.byteLength(ch, 'utf8');
        if (headBytes + bytes > headBudget) break;
        head += ch;
        headBytes += bytes;
    }

    let tail = '';
    let tailBytes = 0;
    for (const ch of Array.from(text).reverse()) {
        const bytes = Buffer.byteLength(ch, 'utf8');
        if (tailBytes + bytes > tailBudget) break;
        tail = ch + tail;
        tailBytes += bytes;
    }

    return `${head}${marker}${tail}`;
}

export function resolveAgyPromptOrder(value: unknown): AgyPromptOrder {
    return value === 'context-first' ? 'context-first' : 'task-first';
}

export function composeAgyPrompt(
    taskPrompt: string,
    systemPrompt: string,
    order: AgyPromptOrder = 'task-first',
): string {
    if (!systemPrompt) return taskPrompt;

    const operationalContext = [
        '[Operational Context — cli-jaw Integration]',
        'The following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:',
        '',
        systemPrompt,
    ].join('\n');
    const currentTask = `[Current cli-jaw task]\n${taskPrompt}`;

    return order === 'context-first'
        ? `${operationalContext}\n\n---\n\n${currentTask}`
        : `${currentTask}\n\n---\n\n${operationalContext}`;
}

export function serializeAgyCompactRoutes(value: unknown, maxBytes = 1200): string {
    const header = '[Canonical routes - use directly; do not rediscover these paths]';
    if (!value || typeof value !== 'object' || Array.isArray(value) || maxBytes < Buffer.byteLength(header, 'utf8')) {
        return '';
    }

    const lines = [header];
    for (const [key, raw] of Object.entries(value).slice(0, 8)) {
        if (!/^[a-z0-9_-]+$/i.test(key) || typeof raw !== 'string') continue;
        const route = raw.replace(/\s+/g, ' ').trim();
        if (!route) continue;
        const candidate = `- ${key}: ${route}`;
        const next = [...lines, candidate].join('\n');
        if (Buffer.byteLength(next, 'utf8') > maxBytes) continue;
        lines.push(candidate);
    }

    return lines.length > 1 ? lines.join('\n') : '';
}

export function buildAgySpillArgPrompt(
    compactBootstrap: string,
    currentPrompt: string,
    maxBytes = 12000,
): string {
    const direct = `${compactBootstrap}\n${currentPrompt}`;
    if (Buffer.byteLength(direct, 'utf8') <= maxBytes) return direct;

    const taskHeader = [AGY_PROMPT_FALLBACK_TEXT, '', '## Current Task Prompt', ''].join('\n');
    const reservedTaskBytes = Math.min(1024, Math.max(0, Math.floor(maxBytes / 3)));
    const bootstrapBudget = Math.max(0, maxBytes - Buffer.byteLength(taskHeader, 'utf8') - reservedTaskBytes - 1);
    const boundedBootstrap = utf8TruncateMiddle(compactBootstrap, bootstrapBudget);
    const prefix = `${boundedBootstrap}\n${taskHeader}`;
    const currentBudget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
    const truncatedCurrent = utf8TruncateMiddle(currentPrompt, currentBudget);

    return `${prefix}${truncatedCurrent}`;
}

export function buildAgySpillWorkspaceFiles(
    systemPrompt: string,
    workingDir: string,
    compactBootstrap: string,
): Record<string, string> {
    const canonical = [
        '# cli-jaw AGY operational instructions',
        '',
        systemPrompt,
        '',
        '---',
        '',
        `Project root: ${workingDir}`,
    ].join('\n');
    const providerPointer = [
        '# cli-jaw instruction pointer',
        '',
        compactBootstrap,
        '',
        'The complete project instructions are stored once in AGENTS.md in this directory.',
        'Treat AGENTS.md as authoritative; do not rediscover the environment or inspect provider configuration.',
    ].join('\n');
    const plainPointer = [
        '# cli-jaw instruction pointer',
        '',
        'Canonical project instructions: AGENTS.md',
    ].join('\n');

    return {
        'AGENTS.md': canonical,
        'GEMINI.md': providerPointer,
        'CLAUDE.md': plainPointer,
        'CONTEXT.md': plainPointer,
    };
}
