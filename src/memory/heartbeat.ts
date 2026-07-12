// ─── Heartbeat (Scheduled Jobs + fs.watch) ───────────

import fs from 'fs';
import { basename, dirname, join } from 'path';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { JAW_HOME, settings, HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { isAgentBusy, messageQueue } from '../agent/spawn.js';
import { orchestrateAndCollectData } from '../orchestrator/collect.js';
import { claimWorker, failWorker, finishWorker, WorkerBusyError } from '../orchestrator/worker-registry.js';
import { hasPendingWorkerReplays } from '../orchestrator/worker-registry.js';
import { broadcast } from '../core/bus.js';
import { sendChannelOutput } from '../messaging/send.js';
import { getEmployees, insertHeartbeatAnchor } from '../core/db.js';
import type { EmployeeRow } from '../core/employees.js';
import { runSingleAgent } from '../orchestrator/distribute.js';
import { getState } from '../orchestrator/state-machine.js';
import { getGoalContinuationPrompt } from '../goal/heartbeat.js';
import { log } from '../core/logger.js';
import { applyOutputPolicy, loadPolicyHooksConfig } from '../core/policy-hooks.js';
import { setRecordPending } from '../core/policy-flags.js';
import { parseHeartbeatReport, type HeartbeatReport } from './heartbeat-report.js';
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
import { HeartbeatSlotReceiptStore } from './heartbeat-slot-receipts.js';
import { HeartbeatEventQueue } from './heartbeat-event-queue.js';

const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatSlotReceipts = new HeartbeatSlotReceiptStore(join(JAW_HOME, 'state', 'heartbeat-slot-receipts.json'));
const HEARTBEAT_SLOT_KEY = '__jawHeartbeatSlotKey';
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

export function isHeartbeatQuietOutput(result: string, extraMarkers: string[] = []): boolean {
    return ['[SILENT]', ...extraMarkers].some(marker => marker.length > 0 && result.includes(marker));
}

function heartbeatEventQueue(job: Record<string, any>): HeartbeatEventQueue | null {
    const filePath = typeof job['eventQueuePath'] === 'string' ? job['eventQueuePath'].trim() : '';
    return filePath ? new HeartbeatEventQueue(filePath) : null;
}

function settleHeartbeatEvents(job: Record<string, any>, since: number, status: 'delivered_by_arona' | 'delivery_uncertain'): void {
    const queue = heartbeatEventQueue(job);
    if (!queue) return;
    try {
        const events = queue.pendingSince(since);
        queue.mark(events.map(event => event.id), status);
    } catch (error) {
        log.error(`[heartbeat:${job['name']}] event queue settle failed:`, (error as Error).message);
    }
}

async function sendHeartbeatEventFallback(job: Record<string, any>, since: number, reason: string): Promise<boolean> {
    const queue = heartbeatEventQueue(job);
    if (!queue) return false;
    try {
        const events = queue.pendingSince(since);
        const texts = events.map(event => event.fallbackText.trim()).filter(Boolean);
        if (texts.length === 0) return false;
        const sendResult = await sendChannelOutput({ channel: 'active', type: 'text', text: texts.join('\n\n') });
        if (!sendResult.ok) {
            log.error(`[heartbeat:${job['name']}] event fallback send failed: ${sendResult.error}`);
            return false;
        }
        queue.mark(events.map(event => event.id), 'fallback_sent');
        log.warn(`[heartbeat:${job['name']}] sent ${events.length} event fallback(s): ${reason}`);
        return true;
    } catch (error) {
        log.error(`[heartbeat:${job['name']}] event fallback failed:`, (error as Error).message);
        return false;
    }
}

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
}

export interface HeartbeatReportDecision { send: boolean; anchor: boolean; delivered: boolean }

export function decideHeartbeatReport(report: HeartbeatReport, policy: string): HeartbeatReportDecision {
    if (policy === 'silent') return { send: false, anchor: true, delivered: false };
    if (policy === 'anomaly_only') {
        const send = report.status !== 'ok' || report.userVisible;
        return { send, anchor: true, delivered: send };
    }
    return { send: true, anchor: true, delivered: true };
}

export function runHeartbeatScript(command: string[]): Promise<HeartbeatReport> {
    return new Promise(resolve => {
        const [file, ...args] = command;
        if (!file) { resolve(parseHeartbeatReport('', 1)); return; }
        execFile(file, args, { timeout: 10 * 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
            resolve(parseHeartbeatReport([stdout, stderr].filter(Boolean).join('\n'), code));
        });
    });
}

function buildScriptEscalationPrompt(prompt: string, report: HeartbeatReport): string {
    const evidence = report.raw.slice(0, 12 * 1024);
    return [
        prompt,
        '',
        '--- Script runner result ---',
        'The scheduled script has already completed. Do not run it again.',
        'Use only the facts in its structured event output and relevant recent conversation context.',
        'Write one natural user-facing response. Do not expose event IDs, raw JSON, internal paths, or commands.',
        evidence,
        '--- End script runner result ---',
    ].join('\n');
}

async function runEmployee(job: Record<string, any>, prompt: string): Promise<HeartbeatReport> {
    const emp = (getEmployees.all() as EmployeeRow[]).find(row => row.name === job["employee"]);
    if (!emp) return parseHeartbeatReport('status: failed\nsummary: employee not found');
    try {
        const slot = claimWorker(emp, prompt, { origin: 'heartbeat' });
        try {
            const ap = { agent: emp.name, role: emp.role || 'general developer', task: prompt, parallel: false, currentPhase: 0, currentPhaseIdx: 0, phaseProfile: [0], mutable: false, scope: null, task_tags: ['heartbeat'] };
            const result = await runSingleAgent(ap, emp, { tag: `heartbeat:${job["id"] || job["name"]}` }, 1, { origin: 'heartbeat' }, []);
            const text = String(result["text"] || '');
            finishWorker(slot.agentId, text, Array.isArray(result["tools"]) ? result["tools"] : []);
            return parseHeartbeatReport(text);
        } catch (error) {
            failWorker(slot.agentId, error instanceof Error ? error.message : String(error));
            throw error;
        }
    } catch (error) {
        if (error instanceof WorkerBusyError) return parseHeartbeatReport('status: warning\nsummary: skipped: employee busy');
        throw error;
    }
}

export async function runHeartbeatJob(job: Record<string, any>) {
    const slotKey = typeof job[HEARTBEAT_SLOT_KEY] === 'string' ? job[HEARTBEAT_SLOT_KEY] : '';
    let started = false;
    let outcome: 'completed' | 'failed' = 'completed';
    const runner = job["runner"] || 'main';
    if (runner === 'main' && getState('default') !== 'IDLE') {
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
    if (runner === 'main' && isAgentBusy()) {
        const queued = queueHeartbeatJob(job, 'agent_busy', 'defer');
        log.info(`[heartbeat:${job["name"]}] ${queued ? 'deferred' : 'already deferred'} during active main agent (${pendingJobs.length} pending)`);
        return;
    }
    // Main IDLE runs historically reached orchestrateAndCollect(prompt); wp4 uses its data-returning form.
    heartbeatBusy = true;
    started = true;
    const eventWindowStart = Date.now();
    try {
        const schedule = normalizeHeartbeatSchedule(job["schedule"]);
        const timeZone = getHeartbeatScheduleTimeZone(schedule);
        const now = formatHeartbeatNow(schedule);
        const goalPrompt = getGoalContinuationPrompt();
        const goalSection = goalPrompt ? `\n\n--- Active Goal ---\n${goalPrompt}\n--- End Goal ---\n` : '';
        const prompt = `[heartbeat:${job["name"]}] 현재 시간: ${now} (${timeZone})\n\nHeartbeat task rule: run the job's explicit script or narrow task first. Do not perform startup self-audit, provider config inspection, broad file search, or memory search unless the job itself needs historical context and no canonical tool/path is available.${goalSection}\n\n${job["prompt"] || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        log.info(`[heartbeat:${job["name"]}] tick (${describeHeartbeatSchedule(schedule)})`);
        let rawResult: string;
        let scriptEscalated = false;
        let scriptQuiet = false;
        if (runner === 'employee') {
            rawResult = (await runEmployee(job, prompt)).raw;
        } else if (runner === 'script') {
            const scriptReport = await runHeartbeatScript(job["command"] || []);
            if (job["escalateToMain"] === 'user_visible' && scriptReport.status === 'ok' && scriptReport.userVisible) {
                if (isAgentBusy()) {
                    const fallbackSent = await sendHeartbeatEventFallback(job, eventWindowStart, 'main agent busy during script escalation');
                    if (fallbackSent) return;
                    rawResult = `${scriptReport.raw}\nstatus: warning\nuser_visible: true\nsummary: ${scriptReport.summary || 'script event ready while main agent busy'}`;
                } else {
                    scriptEscalated = true;
                    const escalationPrompt = buildScriptEscalationPrompt(prompt, scriptReport);
                    const first = await orchestrateAndCollectData(escalationPrompt, { origin: 'heartbeat', requestId: crypto.randomUUID() });
                    const collected = first.data.agyPlannerOnly === true
                        ? await orchestrateAndCollectData(escalationPrompt, { origin: 'heartbeat', requestId: crypto.randomUUID() })
                        : first;
                    rawResult = String(collected.text);
                }
            } else {
                scriptQuiet = job["escalateToMain"] === 'user_visible' && scriptReport.status === 'ok';
                rawResult = scriptReport.status === 'failed' && !/^status:/m.test(scriptReport.raw)
                    ? `${scriptReport.raw}\nstatus: failed\nsummary: ${scriptReport.summary || 'script failed'}`
                    : scriptReport.raw;
            }
        } else {
            const first = await orchestrateAndCollectData(prompt, { origin: 'heartbeat', requestId: crypto.randomUUID() });
            const collected = first.data.agyPlannerOnly === true
                ? await orchestrateAndCollectData(prompt, { origin: 'heartbeat', requestId: crypto.randomUUID() })
                : first;
            rawResult = String(collected.text);
        }
        const result = applyOutputPolicy(rawResult, { scope: 'heartbeat', channel: 'active' }).text;

        const quietConfig = loadPolicyHooksConfig()?.flags?.heartbeatQuietOk;
        const extraQuietMarkers = quietConfig?.enabled ? (quietConfig.markers || []) : [];
        if (isHeartbeatQuietOutput(result, extraQuietMarkers)) {
            const fallbackSent = await sendHeartbeatEventFallback(job, eventWindowStart, 'agent returned silent');
            if (fallbackSent) return;
            log.info(`[heartbeat:${job["name"]}] silent`);
            return;
        }

        const report = parseHeartbeatReport(result);
        if (report.recordRequired) setRecordPending(report.evidence || report.summary || result);
        const policy = scriptEscalated ? 'always' : scriptQuiet ? 'silent' : job["reportPolicy"] || 'always';
        const decision = decideHeartbeatReport(report, policy);
        const deliveryText = report.summary || result;
        const formatted = report.status === 'ok' ? deliveryText : `[${report.status}] ${deliveryText}`;

        log.info(`[heartbeat:${job["name"]}] response: ${result.slice(0, 80)}`);

        // Send heartbeat result via active messaging channel
        const sendResult = decision.send ? await sendChannelOutput({ channel: 'active', type: 'text', text: formatted }) : { ok: true as const };
        if (!sendResult.ok) {
            log.error(`[heartbeat:${job["name"]}] send failed: ${sendResult.error}`);
            settleHeartbeatEvents(job, eventWindowStart, 'delivery_uncertain');
        }

        // Record heartbeat anchor for context injection on next user turn
        if (decision.anchor && sendResult.ok) {
            if (decision.send) settleHeartbeatEvents(job, eventWindowStart, 'delivered_by_arona');
            const now = Date.now();
            try {
                insertHeartbeatAnchor.run(
                    job["id"], job["name"], settings["workingDir"], 'active', null,
                    job["prompt"], decision.delivered ? formatted : `[quiet] ${formatted}`, now, decision.delivered ? now : null,
                );
            } catch (e) {
                log.error(`[heartbeat:${job["name"]}] anchor save failed:`, (e as Error).message);
            }
        }
    } catch (err) {
        outcome = 'failed';
        log.error(`[heartbeat:${job["name"]}] error:`, (err as Error).message);
        await sendHeartbeatEventFallback(job, eventWindowStart, 'agent execution failed');
    } finally {
        if (started && slotKey) heartbeatSlotReceipts.finish(String(job['id']), slotKey, outcome);
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
    if (!heartbeatSlotReceipts.claim(String(job['id']), slotKey)) {
        log.info(`[heartbeat:${job["name"]}] already claimed slot ${slotKey}, skip`);
        return;
    }
    void runHeartbeatJob({ ...job, [HEARTBEAT_SLOT_KEY]: slotKey });
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
