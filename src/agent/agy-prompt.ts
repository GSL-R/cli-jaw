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
