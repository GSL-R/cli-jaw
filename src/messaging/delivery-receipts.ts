import fs from 'node:fs';
import path from 'node:path';
import { JAW_HOME } from '../core/config.js';
import type { ChannelSendRequest } from './send.js';

export type DeliveryReceiptStatus = 'pending' | 'sent' | 'deferred' | 'failed';

export type DeliveryReceipt = {
    version: 1;
    id: string;
    status: DeliveryReceiptStatus;
    createdAt: string;
    updatedAt: string;
    durationMs?: number;
    request: {
        channel: string;
        type: string;
        targetId?: string;
        contentBytes: number;
    };
    result?: Record<string, unknown>;
    error?: string;
};

const DELIVERY_ID_RE = /^[a-f0-9-]{16,64}$/i;
const RECEIPT_TTL_MS = 48 * 60 * 60 * 1000;
let pruned = false;

function receiptDir(): string {
    return path.join(JAW_HOME, 'state', 'channel-deliveries');
}
export function isValidDeliveryId(value: unknown): value is string {
    return typeof value === 'string' && DELIVERY_ID_RE.test(value);
}

function receiptPath(id: string): string {
    if (!isValidDeliveryId(id)) throw Object.assign(new Error('invalid_delivery_id'), { statusCode: 400 });
    return path.join(receiptDir(), `${id}.json`);
}

function writeReceipt(receipt: DeliveryReceipt): void {
    const dir = receiptDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = receiptPath(receipt.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function pruneReceipts(now = Date.now()): void {
    if (pruned) return;
    pruned = true;
    const dir = receiptDir();
    try {
        for (const name of fs.readdirSync(dir).slice(0, 2000)) {
            if (!name.endsWith('.json')) continue;
            const file = path.join(dir, name);
            try {
                if (now - fs.statSync(file).mtimeMs > RECEIPT_TTL_MS) fs.unlinkSync(file);
            } catch { /* ignore raced or invalid files */ }
        }
    } catch { /* directory may not exist yet */ }
}

export function getDeliveryReceipt(id: string): DeliveryReceipt | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(receiptPath(id), 'utf8')) as DeliveryReceipt;
        return parsed?.version === 1 && parsed.id === id ? parsed : null;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if ((err as Error).message === 'invalid_delivery_id') throw err;
        return null;
    }
}

export function beginDeliveryReceipt(id: string, req: ChannelSendRequest): DeliveryReceipt {
    pruneReceipts();
    const existing = getDeliveryReceipt(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const contentBytes = Buffer.byteLength(req.text || '') + Buffer.byteLength(req.caption || '');
    const receipt: DeliveryReceipt = {
        version: 1,
        id,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        request: {
            channel: String(req.channel || 'active'),
            type: req.type,
            ...(req.target?.targetId != null && { targetId: String(req.target.targetId) }),
            contentBytes,
        },
    };
    writeReceipt(receipt);
    return receipt;
}

export function completeDeliveryReceipt(
    id: string,
    status: Exclude<DeliveryReceiptStatus, 'pending'>,
    result: Record<string, unknown>,
): DeliveryReceipt {
    const receipt = getDeliveryReceipt(id);
    if (!receipt) throw Object.assign(new Error('delivery_receipt_not_found'), { statusCode: 404 });
    const now = Date.now();
    const completed: DeliveryReceipt = {
        ...receipt,
        status,
        updatedAt: new Date(now).toISOString(),
        durationMs: Math.max(0, now - Date.parse(receipt.createdAt)),
        result,
        ...(status === 'failed' && { error: String(result['error'] || 'delivery failed') }),
    };
    writeReceipt(completed);
    return completed;
}
