export type AgyPromptOrder = 'task-first' | 'context-first';

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
