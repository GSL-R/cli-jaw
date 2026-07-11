import fs from 'node:fs';
import { dirname } from 'node:path';

export type HeartbeatEventStatus = 'pending' | 'delivered_by_arona' | 'fallback_sent' | 'delivery_uncertain';

export interface HeartbeatEvent {
    id: string;
    createdAt: number;
    updatedAt: number;
    status: HeartbeatEventStatus;
    fallbackText: string;
    [key: string]: unknown;
}

interface HeartbeatEventFile {
    version: 1;
    events: HeartbeatEvent[];
}

function emptyEventFile(): HeartbeatEventFile {
    return { version: 1, events: [] };
}

/**
 * A tiny durable handoff queue for scripts that know the facts but leave the
 * user-facing wording to the heartbeat agent.
 */
export class HeartbeatEventQueue {
    constructor(private readonly filePath: string) {}

    pendingSince(since: number): HeartbeatEvent[] {
        return this.read().events.filter(event => event.status === 'pending' && event.createdAt >= since);
    }

    mark(ids: string[], status: Exclude<HeartbeatEventStatus, 'pending'>, now: number = Date.now()): void {
        if (ids.length === 0) return;
        const wanted = new Set(ids);
        const state = this.read();
        let changed = false;
        for (const event of state.events) {
            if (wanted.has(event.id) && event.status === 'pending') {
                event.status = status;
                event.updatedAt = now;
                changed = true;
            }
        }
        if (changed) this.write(state);
    }

    private read(): HeartbeatEventFile {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<HeartbeatEventFile>;
            if (parsed.version !== 1 || !Array.isArray(parsed.events)) return emptyEventFile();
            return {
                version: 1,
                events: parsed.events.filter((event): event is HeartbeatEvent => (
                    !!event
                    && typeof event.id === 'string'
                    && typeof event.createdAt === 'number'
                    && typeof event.updatedAt === 'number'
                    && typeof event.fallbackText === 'string'
                    && typeof event.status === 'string'
                )),
            };
        } catch {
            return emptyEventFile();
        }
    }

    private write(state: HeartbeatEventFile): void {
        fs.mkdirSync(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(tempPath, this.filePath);
    }
}
