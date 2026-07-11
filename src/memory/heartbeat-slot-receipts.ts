import fs from 'node:fs';
import { dirname } from 'node:path';

export const HEARTBEAT_RECEIPT_RETENTION_MS = 48 * 60 * 60 * 1000;

export type HeartbeatSlotReceiptStatus = 'running' | 'completed' | 'failed';

export interface HeartbeatSlotReceipt {
    jobId: string;
    slotKey: string;
    status: HeartbeatSlotReceiptStatus;
    createdAt: number;
    updatedAt: number;
}

interface HeartbeatSlotReceiptFile {
    version: 1;
    receipts: Record<string, HeartbeatSlotReceipt>;
}

function receiptId(jobId: string, slotKey: string): string {
    return `${jobId}\u0000${slotKey}`;
}

function emptyReceiptFile(): HeartbeatSlotReceiptFile {
    return { version: 1, receipts: {} };
}

/**
 * Persists one claim per scheduled cron minute so a heartbeat.json reload
 * cannot replay a job that already began in the same slot.
 */
export class HeartbeatSlotReceiptStore {
    constructor(
        private readonly filePath: string,
        private readonly retentionMs: number = HEARTBEAT_RECEIPT_RETENTION_MS,
    ) {}

    claim(jobId: string, slotKey: string, now: number = Date.now()): boolean {
        const state = this.read();
        this.prune(state, now);
        const id = receiptId(jobId, slotKey);
        if (state.receipts[id]) return false;

        state.receipts[id] = { jobId, slotKey, status: 'running', createdAt: now, updatedAt: now };
        this.write(state);
        return true;
    }

    finish(jobId: string, slotKey: string, status: Exclude<HeartbeatSlotReceiptStatus, 'running'>, now: number = Date.now()): void {
        const state = this.read();
        this.prune(state, now);
        const id = receiptId(jobId, slotKey);
        const receipt = state.receipts[id];
        if (!receipt) return;
        receipt.status = status;
        receipt.updatedAt = now;
        this.write(state);
    }

    private read(): HeartbeatSlotReceiptFile {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<HeartbeatSlotReceiptFile>;
            if (parsed.version !== 1 || !parsed.receipts || typeof parsed.receipts !== 'object' || Array.isArray(parsed.receipts)) {
                return emptyReceiptFile();
            }
            return { version: 1, receipts: parsed.receipts as Record<string, HeartbeatSlotReceipt> };
        } catch {
            return emptyReceiptFile();
        }
    }

    private prune(state: HeartbeatSlotReceiptFile, now: number): void {
        const cutoff = now - this.retentionMs;
        for (const [id, receipt] of Object.entries(state.receipts)) {
            if (!receipt || typeof receipt.updatedAt !== 'number' || receipt.updatedAt < cutoff) delete state.receipts[id];
        }
    }

    private write(state: HeartbeatSlotReceiptFile): void {
        fs.mkdirSync(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(tempPath, this.filePath);
    }
}
