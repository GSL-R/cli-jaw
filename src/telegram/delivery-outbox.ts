import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';
import type { ChannelSendRequest } from '../messaging/send.js';

type OutboxRecord = {
    version: 1;
    id: string;
    status: 'deferred';
    createdAt: string;
    lastDeferredAt: string;
    occurrences: number;
    retryAfter?: number;
    error: string;
    request: ChannelSendRequest;
};

function serializableRequest(req: ChannelSendRequest): ChannelSendRequest {
    return {
        channel: 'telegram',
        type: req.type,
        ...(req.text != null && { text: req.text }),
        ...(req.filePath != null && { filePath: req.filePath }),
        ...(req.caption != null && { caption: req.caption }),
        ...(req.target != null && { target: req.target }),
        ...(req.chatId != null && { chatId: req.chatId }),
    };
}

export function persistTelegramOutbox(
    req: ChannelSendRequest,
    error: string,
    retryAfter?: number,
    outboxDir = path.join(JAW_HOME, 'state', 'telegram-outbox'),
): string {
    const request = serializableRequest(req);
    const id = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 20);
    fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    const file = path.join(outboxDir, `${id}.json`);
    const now = new Date().toISOString();
    let existing: OutboxRecord | null = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) as OutboxRecord; } catch { /* first occurrence */ }
    const record: OutboxRecord = {
        version: 1,
        id,
        status: 'deferred',
        createdAt: existing?.createdAt || now,
        lastDeferredAt: now,
        occurrences: (existing?.occurrences || 0) + 1,
        ...(retryAfter != null && retryAfter > 0 && { retryAfter }),
        error,
        request,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return id;
}

