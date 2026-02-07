import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { BridgeConfig, TaskFile, OutboxMessage } from '../types.js';
import { readTask, updateTask } from '../task-file-ops.js';
import { checkShutdownSignal, writeShutdownSignal } from '../inbox-outbox.js';
import { writeHeartbeat, readHeartbeat } from '../heartbeat.js';

const TEST_TEAM = 'test-bridge-int';
const TASKS_DIR = join(homedir(), '.claude', 'tasks', TEST_TEAM);
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);
const WORK_DIR = join(tmpdir(), '__test_bridge_work__');

function writeTask(task: TaskFile): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function readOutbox(): OutboxMessage[] {
  const outboxFile = join(TEAMS_DIR, 'outbox', `worker1.jsonl`);
  if (!existsSync(outboxFile)) return [];
  return readFileSync(outboxFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    teamName: TEST_TEAM,
    workerName: 'worker1',
    provider: 'codex',
    workingDirectory: WORK_DIR,
    pollIntervalMs: 100,        // Fast polling for tests
    taskTimeoutMs: 5000,
    maxConsecutiveErrors: 3,
    outboxMaxLines: 100,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TASKS_DIR, { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'inbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'signals'), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(join(WORK_DIR, '.omc', 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(TASKS_DIR, { recursive: true, force: true });
  rmSync(TEAMS_DIR, { recursive: true, force: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
});

describe('Bridge Integration', () => {
  describe('Task lifecycle', () => {
    it('writes heartbeat files correctly', () => {
      const config = makeConfig();
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: 0,
        status: 'polling',
      });

      const hb = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
      expect(hb).not.toBeNull();
      expect(hb?.status).toBe('polling');
      expect(hb?.workerName).toBe('worker1');
    });

    it('task can transition pending -> in_progress -> completed', () => {
      writeTask({
        id: '1', subject: 'Test task', description: 'Do something',
        status: 'pending', owner: 'worker1', blocks: [], blockedBy: [],
      });

      updateTask(TEST_TEAM, '1', { status: 'in_progress' });
      let task = readTask(TEST_TEAM, '1');
      expect(task?.status).toBe('in_progress');

      updateTask(TEST_TEAM, '1', { status: 'completed' });
      task = readTask(TEST_TEAM, '1');
      expect(task?.status).toBe('completed');
    });
  });

  describe('Shutdown signaling', () => {
    it('shutdown signal write/read/delete cycle', () => {
      const config = makeConfig();

      // No signal initially
      expect(checkShutdownSignal(config.teamName, config.workerName)).toBeNull();

      // Write signal
      writeShutdownSignal(config.teamName, config.workerName, 'req-001', 'Task complete');
      const signal = checkShutdownSignal(config.teamName, config.workerName);
      expect(signal).not.toBeNull();
      expect(signal?.requestId).toBe('req-001');
      expect(signal?.reason).toBe('Task complete');
    });
  });

  describe('Quarantine behavior', () => {
    it('quarantine is reflected in heartbeat status', () => {
      const config = makeConfig();
      writeHeartbeat(config.workingDirectory, {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        consecutiveErrors: config.maxConsecutiveErrors,
        status: 'quarantined',
      });

      const hb = readHeartbeat(config.workingDirectory, config.teamName, config.workerName);
      expect(hb?.status).toBe('quarantined');
      expect(hb?.consecutiveErrors).toBe(3);
    });
  });

  describe('Task with blockers', () => {
    it('blocked task not picked up until blocker completes', async () => {
      writeTask({
        id: '1', subject: 'Blocker', description: 'Must finish first',
        status: 'pending', owner: 'other', blocks: ['2'], blockedBy: [],
      });
      writeTask({
        id: '2', subject: 'Blocked', description: 'Depends on 1',
        status: 'pending', owner: 'worker1', blocks: [], blockedBy: ['1'],
      });

      // Task 2 should not be found — blocker is pending
      const { findNextTask } = await import('../task-file-ops.js');
      expect(findNextTask(TEST_TEAM, 'worker1')).toBeNull();

      // Complete blocker
      updateTask(TEST_TEAM, '1', { status: 'completed' });
      const next = findNextTask(TEST_TEAM, 'worker1');
      expect(next?.id).toBe('2');
    });
  });
});
