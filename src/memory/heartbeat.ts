// ─── Heartbeat (Scheduled Jobs + fs.watch) ───────────

import fs from 'fs';
import { basename, dirname } from 'path';
import crypto from 'crypto';
import { settings, HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { getEmployees } from '../core/db.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { isAgentBusy, messageQueue, spawnAgent } from '../agent/spawn.js';
import { getEmployeePrompt } from '../prompt/builder.js';
import { findEmployee } from '../orchestrator/distribute.js';
import {
    claimWorker,
    failWorker,
    finishWorker,
    hasPendingWorkerReplays,
    updateWorkerTools,
    WorkerBusyError,
} from '../orchestrator/worker-registry.js';
import { broadcast } from '../core/bus.js';
import { sendChannelOutput } from '../messaging/send.js';
import { insertHeartbeatAnchor } from '../core/db.js';
import { getState } from '../orchestrator/state-machine.js';
import { getGoalContinuationPrompt } from '../goal/heartbeat.js';
import { log } from '../core/logger.js';
import {
    describeHeartbeatSchedule,
    formatHeartbeatNow,
    getHeartbeatMinuteSlotKey,
    getHeartbeatScheduleTimeZone,
    matchesHeartbeatCron,
    normalizeHeartbeatSchedule,
    startHeartbeatCronLoop,
    validateHeartbeatCron,
} from './heartbeat-schedule.js';

const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatCronSlots = new Map<string, string>();
let heartbeatWatcher: fs.FSWatcher | null = null;
let heartbeatBusy = false;
type HeartbeatPendingReason = 'busy' | 'pabcd_active' | 'agent_busy';
type HeartbeatPendingPolicy = 'defer';
interface PendingHeartbeatJob {
    job: Record<string, any>;
    reason: HeartbeatPendingReason;
    policy?: HeartbeatPendingPolicy;
}
const pendingJobs: PendingHeartbeatJob[] = [];

type HeartbeatRunResult = {
    text: string;
    visible: boolean;
};

function pendingSnapshot(reason?: HeartbeatPendingReason, policy?: HeartbeatPendingPolicy) {
    const deferredPending = pendingJobs.filter(item => item.policy === 'defer').length;
    const agentBusyPending = pendingJobs.filter(item => item.reason === 'agent_busy').length;
    return {
        pending: pendingJobs.length,
        deferredPending,
        agentBusyPending,
        ...(reason ? { reason } : {}),
        ...(policy ? { policy } : {}),
    };
}

function queueHeartbeatJob(
    job: Record<string, any>,
    reason: HeartbeatPendingReason,
    policy?: HeartbeatPendingPolicy,
): boolean {
    if (pendingJobs.some(item => item.job["id"] === job["id"])) return false;
    pendingJobs.push(stripUndefined({ job, reason, policy }));
    broadcast('heartbeat_pending', {
        ...pendingSnapshot(reason, policy),
        jobId: job["id"],
        jobName: job["name"],
    });
    return true;
}

export function getHeartbeatRuntimeState() {
    return pendingSnapshot();
}

function heartbeatReportPolicy(job: Record<string, any>): 'always' | 'anomaly_only' | 'silent' {
    const raw = typeof job["reportPolicy"] === 'string' ? job["reportPolicy"].toLowerCase() : '';
    if (raw === 'anomaly_only' || raw === 'silent' || raw === 'always') return raw;
    return 'always';
}

function isEmployeeHeartbeat(job: Record<string, any>): boolean {
    return job["runner"] === 'employee' || typeof job["employee"] === 'string';
}

function shouldShowEmployeeResult(text: string, policy: 'always' | 'anomaly_only' | 'silent'): boolean {
    if (policy === 'always') return true;
    if (policy === 'silent') return false;
    const lower = text.toLowerCase();
    if (/status\s*:\s*(warning|failed|fail|error)/i.test(text)) return true;
    if (/user_visible\s*:\s*(yes|true)/i.test(text)) return true;
    if (/record_required\s*:\s*(yes|true)/i.test(text)) return true;
    if (lower.includes('warning') || lower.includes('failed') || lower.includes('error')) return true;
    if (text.includes('⚠') || text.includes('❌')) return true;
    return false;
}

async function runEmployeeHeartbeatJob(job: Record<string, any>, prompt: string): Promise<HeartbeatRunResult> {
    const employeeName = String(job["employee"] || job["agent"] || '').trim();
    if (!employeeName) {
        return {
            text: `❌ heartbeat employee runner requires job.employee`,
            visible: true,
        };
    }
    const emps = getEmployees.all() as Record<string, any>[];
    const emp = findEmployee(emps, { agent: employeeName });
    if (!emp) {
        return {
            text: `❌ heartbeat employee not found: ${employeeName}`,
            visible: true,
        };
    }

    const task = [
        prompt,
        '',
        '## Heartbeat Employee Report Contract',
        'Return a concise report in this exact shape:',
        'status: ok | warning | failed',
        'changed: yes | no',
        'record_required: yes | no',
        'user_visible: yes | no',
        'summary: ...',
        'evidence: ...',
        'next_action: ...',
        '',
        'If everything is normal and no user-facing action is needed, set status: ok and user_visible: no.',
    ].join('\n');

    let slot: ReturnType<typeof claimWorker> | null = null;
    try {
        slot = claimWorker({ id: String(emp["id"]), name: String(emp["name"] || emp["id"]) }, task, { origin: 'heartbeat' });
    } catch (err) {
        if (err instanceof WorkerBusyError) {
            return {
                text: `❌ heartbeat employee busy: ${err.existing.employeeName}`,
                visible: true,
            };
        }
        throw err;
    }

    try {
        const sysPrompt = getEmployeePrompt({
            name: String(emp["name"] || emp["id"]),
            role: String(job["role"] || emp["role"] || 'heartbeat maintenance worker'),
            id: String(emp["id"]),
        });
        const { promise } = spawnAgent(task, {
            agentId: String(emp["id"]),
            cli: String(emp["cli"] || settings["cli"] || ''),
            model: String(emp["model"] || ''),
            forceNew: job["resumeEmployee"] !== true,
            sysPrompt,
            origin: 'heartbeat',
            env: {
                JAW_EMPLOYEE_MODE: '1',
                JAW_EMPLOYEE_NAME: String(emp["name"] || ''),
                JAW_EMPLOYEE_ROLE: String(job["role"] || emp["role"] || 'heartbeat maintenance worker'),
                JAW_WORKSPACE_ROOT: settings["workingDir"] || '',
                PORT: String(process.env["PORT"] || ''),
            },
        });
        const result = await promise as Record<string, unknown>;
        const text = String(result["text"] || '').trim() || '[SILENT]';
        const tools = Array.isArray(result["tools"]) ? result["tools"] : [];
        updateWorkerTools(slot.agentId, tools as any[]);
        finishWorker(slot.agentId, text, tools as any[]);
        const policy = heartbeatReportPolicy(job);
        return {
            text,
            visible: shouldShowEmployeeResult(text, policy),
        };
    } catch (err) {
        const text = `❌ heartbeat employee runner failed: ${(err as Error).message}`;
        if (slot) failWorker(slot.agentId, text);
        return { text, visible: true };
    }
}

export function startHeartbeat() {
    stopHeartbeat();
    const { jobs } = loadHeartbeatFile();
    for (const job of jobs) {
        if (!job?.enabled || !job.id) continue;
        const schedule = normalizeHeartbeatSchedule(job.schedule);
        if (schedule.kind === 'cron') {
            const cronError = validateHeartbeatCron(schedule.cron);
            if (cronError) {
                log.warn(`[heartbeat:${job.name}] invalid cron "${schedule.cron}": ${cronError}`);
                continue;
            }
            scheduleCronJob(job);
            continue;
        }
        const ms = schedule.minutes * 60_000;
        const timer = setInterval(() => runHeartbeatJob(job), ms);
        timer.unref?.();
        heartbeatTimers.set(job.id, timer);
    }
    const n = heartbeatTimers.size;
    log.info(`[heartbeat] ${n} job${n !== 1 ? 's' : ''} active`);
}

export function stopHeartbeat() {
    for (const timer of heartbeatTimers.values()) clearTimeout(timer);
    heartbeatTimers.clear();
    heartbeatCronSlots.clear();
}

async function runHeartbeatJob(job: Record<string, any>) {
    if (getState('default') !== 'IDLE') {
        const queued = queueHeartbeatJob(job, 'pabcd_active', 'defer');
        log.info(`[heartbeat:${job["name"]}] ${queued ? 'deferred' : 'already deferred'} during active PABCD (${pendingJobs.length} pending)`);
        return;
    }
    if (heartbeatBusy) {
        if (queueHeartbeatJob(job, 'busy')) {
            log.info(`[heartbeat:${job["name"]}] queued (${pendingJobs.length} pending)`);
        } else {
            log.info(`[heartbeat:${job["name"]}] already queued, skip`);
        }
        return;
    }
    if (isAgentBusy()) {
        const queued = queueHeartbeatJob(job, 'agent_busy', 'defer');
        log.info(`[heartbeat:${job["name"]}] ${queued ? 'deferred' : 'already deferred'} during active main agent (${pendingJobs.length} pending)`);
        return;
    }
    heartbeatBusy = true;
    try {
        const schedule = normalizeHeartbeatSchedule(job["schedule"]);
        const timeZone = getHeartbeatScheduleTimeZone(schedule);
        const now = formatHeartbeatNow(schedule);
        const goalPrompt = getGoalContinuationPrompt();
        const goalSection = goalPrompt ? `\n\n--- Active Goal ---\n${goalPrompt}\n--- End Goal ---\n` : '';
        const prompt = `[heartbeat:${job["name"]}] 현재 시간: ${now} (${timeZone})\n\nHeartbeat task rule: run the job's explicit script or narrow task first. Do not perform startup self-audit, provider config inspection, broad file search, or memory search unless the job itself needs historical context and no canonical tool/path is available.${goalSection}\n\n${job["prompt"] || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        log.info(`[heartbeat:${job["name"]}] tick (${describeHeartbeatSchedule(schedule)})`);
        const requestId = crypto.randomUUID();
        const runResult = isEmployeeHeartbeat(job)
            ? await runEmployeeHeartbeatJob(job, prompt)
            : { text: String(await orchestrateAndCollect(prompt, { origin: 'heartbeat', requestId })), visible: true };
        const result = runResult.text;

        if (!runResult.visible || result.includes('[SILENT]')) {
            log.info(`[heartbeat:${job["name"]}] silent`);
            return;
        }

        log.info(`[heartbeat:${job["name"]}] response: ${result.slice(0, 80)}`);

        // Send heartbeat result via active messaging channel
        const sendResult = await sendChannelOutput({
            channel: 'active',
            type: 'text',
            text: result,
        });
        if (!sendResult.ok) {
            log.error(`[heartbeat:${job["name"]}] send failed: ${sendResult.error}`);
        }

        // Record heartbeat anchor for context injection on next user turn
        if (sendResult.ok) {
            const now = Date.now();
            try {
                insertHeartbeatAnchor.run(
                    job["id"], job["name"], settings["workingDir"], 'active', null,
                    job["prompt"], result, now, now,
                );
            } catch (e) {
                log.error(`[heartbeat:${job["name"]}] anchor save failed:`, (e as Error).message);
            }
        }
    } catch (err) {
        log.error(`[heartbeat:${job["name"]}] error:`, (err as Error).message);
    } finally {
        heartbeatBusy = false;
        await drainPending();
    }
}

export async function drainPending() {
    if (pendingJobs.length === 0) return;
    if (isAgentBusy() || messageQueue.length > 0 || hasPendingWorkerReplays()) return;
    const next = pendingJobs.shift()?.job;
    if (!next) return;
    broadcast('heartbeat_pending', pendingSnapshot());
    log.info(`[heartbeat:${next["name"]}] dequeued (${pendingJobs.length} remaining)`);
    await runHeartbeatJob(next);
}

function scheduleCronJob(job: Record<string, any>) {
    const armNextTick = (tick: () => void) => {
        const timer = setTimeout(tick, msUntilNextMinute());
        timer.unref?.();
        heartbeatTimers.set(job["id"], timer);
    };
    startHeartbeatCronLoop(() => maybeRunCronJob(job), armNextTick);
}

function maybeRunCronJob(job: Record<string, any>) {
    const schedule = normalizeHeartbeatSchedule(job["schedule"]);
    if (schedule.kind !== 'cron') return;
    const timeZone = getHeartbeatScheduleTimeZone(schedule);
    if (!matchesHeartbeatCron(schedule.cron, new Date(), timeZone)) return;
    const slotKey = getHeartbeatMinuteSlotKey(schedule);
    if (heartbeatCronSlots.get(job["id"]) === slotKey) return;
    heartbeatCronSlots.set(job["id"], slotKey);
    void runHeartbeatJob(job);
}

function msUntilNextMinute(): number {
    const now = Date.now();
    const remainder = now % 60_000;
    return (remainder === 0 ? 60_000 : 60_000 - remainder) + 250;
}

// ─── fs.watch — auto-reload on file change ───────────

export function watchHeartbeatFile() {
    closeHeartbeatWatcher();
    try {
        let watchDebounce: ReturnType<typeof setTimeout> | undefined;
        const dir = dirname(HEARTBEAT_JOBS_PATH);
        const name = basename(HEARTBEAT_JOBS_PATH);
        heartbeatWatcher = fs.watch(dir, (_event, changed) => {
            if (changed && changed !== name) return;
            clearTimeout(watchDebounce);
            watchDebounce = setTimeout(() => {
                log.info('[heartbeat] file changed — reloading');
                startHeartbeat();
            }, 500);
        });
        heartbeatWatcher.on('error', () => {});
    } catch { /* expected: home dir missing in tests */ }
}

export function closeHeartbeatWatcher() {
    if (heartbeatWatcher) {
        heartbeatWatcher.close();
        heartbeatWatcher = null;
    }
}

// Re-export for route handlers
export { loadHeartbeatFile, saveHeartbeatFile };
