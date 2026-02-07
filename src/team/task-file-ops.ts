// src/team/task-file-ops.ts

/**
 * Task File Operations for MCP Team Bridge
 *
 * Read/write/scan task JSON files with atomic writes (temp + rename).
 * Tasks live at ~/.claude/tasks/{teamName}/{id}.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { TaskFile, TaskFileUpdate, TaskFailureSidecar } from './types.js';
import { sanitizeName } from './tmux-session.js';

/** Atomic write: write to temp file, then rename (prevents corruption on crash) */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

/** Validate task ID to prevent path traversal */
function sanitizeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
  }
  return taskId;
}

/** Paths helper */
function tasksDir(teamName: string): string {
  return join(homedir(), '.claude', 'tasks', sanitizeName(teamName));
}

function taskPath(teamName: string, taskId: string): string {
  return join(tasksDir(teamName), `${sanitizeTaskId(taskId)}.json`);
}

function failureSidecarPath(teamName: string, taskId: string): string {
  return join(tasksDir(teamName), `${sanitizeTaskId(taskId)}.failure.json`);
}

/** Read a single task file. Returns null if not found or malformed. */
export function readTask(teamName: string, taskId: string): TaskFile | null {
  const filePath = taskPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFile;
  } catch {
    return null;
  }
}

/**
 * Atomic update: reads full task JSON, patches specified fields, writes back.
 * Preserves unknown fields to avoid data loss.
 */
export function updateTask(teamName: string, taskId: string, updates: TaskFileUpdate): void {
  const filePath = taskPath(teamName, taskId);
  let task: Record<string, unknown>;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    task = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Task file not found or malformed: ${taskId}`);
  }
  // Merge updates into existing task (preserving unknown fields)
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      task[key] = value;
    }
  }
  atomicWriteJson(filePath, task);
}

/**
 * Find next executable task for this worker.
 * Returns first task where:
 *   - owner === workerName
 *   - status === 'pending'
 *   - all blockedBy tasks have status 'completed'
 * Sorted by ID ascending.
 *
 * Ownership guard: re-reads task after finding candidate to ensure
 * owner hasn't changed between scan and claim.
 */
export function findNextTask(teamName: string, workerName: string): TaskFile | null {
  const dir = tasksDir(teamName);
  if (!existsSync(dir)) return null;

  const taskIds = listTaskIds(teamName);

  for (const id of taskIds) {
    const task = readTask(teamName, id);
    if (!task) continue;
    if (task.status !== 'pending') continue;
    if (task.owner !== workerName) continue;
    if (!areBlockersResolved(teamName, task.blockedBy)) continue;

    // Ownership guard: re-read to ensure owner hasn't been reassigned
    const freshTask = readTask(teamName, id);
    if (!freshTask || freshTask.owner !== workerName || freshTask.status !== 'pending') {
      continue;
    }

    return freshTask;
  }

  return null;
}

/** Check if all blocker task IDs have status 'completed' */
export function areBlockersResolved(teamName: string, blockedBy: string[]): boolean {
  if (!blockedBy || blockedBy.length === 0) return true;
  for (const blockerId of blockedBy) {
    const blocker = readTask(teamName, blockerId);
    if (!blocker || blocker.status !== 'completed') return false;
  }
  return true;
}

/**
 * Write failure sidecar for a task.
 * If sidecar already exists, increments retryCount.
 */
export function writeTaskFailure(teamName: string, taskId: string, error: string): void {
  const filePath = failureSidecarPath(teamName, taskId);
  const existing = readTaskFailure(teamName, taskId);
  const sidecar: TaskFailureSidecar = {
    taskId,
    lastError: error,
    retryCount: existing ? existing.retryCount + 1 : 1,
    lastFailedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, sidecar);
}

/** Read failure sidecar if it exists */
export function readTaskFailure(teamName: string, taskId: string): TaskFailureSidecar | null {
  const filePath = failureSidecarPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFailureSidecar;
  } catch {
    return null;
  }
}

/** List all task IDs in a team directory, sorted ascending */
export function listTaskIds(teamName: string): string[] {
  const dir = tasksDir(teamName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.failure.'))
      .map(f => f.replace('.json', ''))
      .sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}
