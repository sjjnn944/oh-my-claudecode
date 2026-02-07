// src/team/inbox-outbox.ts

/**
 * Inbox/Outbox JSONL Messaging for MCP Team Bridge
 *
 * File-based communication channels between team lead and MCP workers.
 * Uses JSONL format with offset cursor for efficient incremental reads.
 */

import {
  appendFileSync, readFileSync, writeFileSync, existsSync,
  mkdirSync, statSync, unlinkSync, renameSync, openSync,
  readSync, closeSync
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { InboxMessage, OutboxMessage, ShutdownSignal, InboxCursor } from './types.js';
import { sanitizeName } from './tmux-session.js';

// --- Path helpers ---

function teamsDir(teamName: string): string {
  return join(homedir(), '.claude', 'teams', sanitizeName(teamName));
}

function inboxPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.jsonl`);
}

function inboxCursorPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.offset`);
}

function outboxPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'outbox', `${sanitizeName(workerName)}.jsonl`);
}

function signalPath(teamName: string, workerName: string): string {
  return join(teamsDir(teamName), 'signals', `${sanitizeName(workerName)}.shutdown`);
}

/** Ensure directory exists for a file path */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Outbox (worker -> lead) ---

/**
 * Append a message to the outbox JSONL file.
 * Creates directories if needed.
 */
export function appendOutbox(teamName: string, workerName: string, message: OutboxMessage): void {
  const filePath = outboxPath(teamName, workerName);
  ensureDir(filePath);
  appendFileSync(filePath, JSON.stringify(message) + '\n', 'utf-8');
}

/**
 * Rotate outbox if it exceeds maxLines.
 * Keeps the most recent maxLines/2 entries, discards older.
 * Prevents unbounded growth.
 */
export function rotateOutboxIfNeeded(teamName: string, workerName: string, maxLines: number): void {
  const filePath = outboxPath(teamName, workerName);
  if (!existsSync(filePath)) return;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length <= maxLines) return;

    // Keep the most recent half
    const keepCount = Math.floor(maxLines / 2);
    const kept = lines.slice(-keepCount);
    const tmpPath = filePath + '.tmp.' + process.pid;
    writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch {
    // Rotation failure is non-fatal
  }
}

// --- Inbox (lead -> worker) ---

/**
 * Read new inbox messages using offset cursor.
 *
 * Uses byte-offset cursor to avoid clock skew issues:
 * 1. Read cursor from {worker}.offset file (default: 0)
 * 2. Open inbox JSONL, seek to offset
 * 3. Read from offset to EOF
 * 4. Parse new JSONL lines
 * 5. Update cursor to new file position
 *
 * Handles file truncation (cursor > file size) by resetting cursor.
 */
export function readNewInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);

  if (!existsSync(inbox)) return [];

  // Read cursor
  let offset = 0;
  if (existsSync(cursorFile)) {
    try {
      const cursor: InboxCursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
      offset = cursor.bytesRead;
    } catch { /* reset to 0 */ }
  }

  // Check file size
  const stat = statSync(inbox);

  // Handle file truncation (cursor beyond file size)
  if (stat.size < offset) {
    offset = 0;
  }

  if (stat.size <= offset) return []; // No new data

  // Read from offset
  const fd = openSync(inbox, 'r');
  const buffer = Buffer.alloc(stat.size - offset);
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }

  const newData = buffer.toString('utf-8');
  const messages: InboxMessage[] = [];
  let lastNewlineOffset = 0; // Track bytes consumed through last complete line

  const lines = newData.split('\n');
  let bytesProcessed = 0;
  for (const line of lines) {
    bytesProcessed += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
      lastNewlineOffset = bytesProcessed;
    } catch {
      // Stop at first malformed line — don't skip past it
      break;
    }
  }

  // Advance cursor only through last successfully parsed newline boundary
  const newOffset = offset + (lastNewlineOffset > 0 ? lastNewlineOffset : 0);
  ensureDir(cursorFile);
  const newCursor: InboxCursor = { bytesRead: newOffset > offset ? newOffset : offset };
  writeFileSync(cursorFile, JSON.stringify(newCursor), 'utf-8');

  return messages;
}

/** Read ALL inbox messages (for initial load or debugging) */
export function readAllInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  const inbox = inboxPath(teamName, workerName);
  if (!existsSync(inbox)) return [];

  try {
    const content = readFileSync(inbox, 'utf-8');
    const messages: InboxMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    return messages;
  } catch {
    return [];
  }
}

/** Clear inbox (truncate file + reset cursor) */
export function clearInbox(teamName: string, workerName: string): void {
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);

  if (existsSync(inbox)) {
    try { writeFileSync(inbox, '', 'utf-8'); } catch { /* ignore */ }
  }
  if (existsSync(cursorFile)) {
    try { writeFileSync(cursorFile, JSON.stringify({ bytesRead: 0 }), 'utf-8'); } catch { /* ignore */ }
  }
}

// --- Shutdown signals ---

/** Write a shutdown signal file */
export function writeShutdownSignal(teamName: string, workerName: string, requestId: string, reason: string): void {
  const filePath = signalPath(teamName, workerName);
  ensureDir(filePath);
  const signal: ShutdownSignal = {
    requestId,
    reason,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(signal, null, 2), 'utf-8');
}

/** Check if shutdown signal exists, return parsed content or null */
export function checkShutdownSignal(teamName: string, workerName: string): ShutdownSignal | null {
  const filePath = signalPath(teamName, workerName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ShutdownSignal;
  } catch {
    return null;
  }
}

/** Delete the shutdown signal file after processing */
export function deleteShutdownSignal(teamName: string, workerName: string): void {
  const filePath = signalPath(teamName, workerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// --- Cleanup ---

/** Remove all inbox/outbox/signal files for a worker */
export function cleanupWorkerFiles(teamName: string, workerName: string): void {
  const files = [
    inboxPath(teamName, workerName),
    inboxCursorPath(teamName, workerName),
    outboxPath(teamName, workerName),
    signalPath(teamName, workerName),
  ];
  for (const f of files) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
