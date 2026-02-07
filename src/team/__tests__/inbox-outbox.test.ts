import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  appendOutbox, rotateOutboxIfNeeded, readNewInboxMessages,
  readAllInboxMessages, clearInbox, writeShutdownSignal,
  checkShutdownSignal, deleteShutdownSignal, cleanupWorkerFiles
} from '../inbox-outbox.js';
import type { OutboxMessage, InboxMessage } from '../types.js';

const TEST_TEAM = 'test-team-io';
const TEAMS_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);

beforeEach(() => {
  mkdirSync(join(TEAMS_DIR, 'inbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'outbox'), { recursive: true });
  mkdirSync(join(TEAMS_DIR, 'signals'), { recursive: true });
});

afterEach(() => {
  rmSync(TEAMS_DIR, { recursive: true, force: true });
});

describe('appendOutbox', () => {
  it('appends JSONL message', () => {
    const msg: OutboxMessage = { type: 'idle', message: 'standing by', timestamp: '2026-01-01T00:00:00Z' };
    appendOutbox(TEST_TEAM, 'w1', msg);
    appendOutbox(TEST_TEAM, 'w1', { ...msg, type: 'heartbeat' });
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('idle');
  });
});

describe('rotateOutboxIfNeeded', () => {
  it('rotates when exceeding maxLines', () => {
    const msg: OutboxMessage = { type: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' };
    for (let i = 0; i < 20; i++) {
      appendOutbox(TEST_TEAM, 'w1', { ...msg, message: `msg-${i}` });
    }
    rotateOutboxIfNeeded(TEST_TEAM, 'w1', 10);
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    // Should keep recent messages
    expect(JSON.parse(lines[lines.length - 1]).message).toBe('msg-19');
  });

  it('no-op when under limit', () => {
    appendOutbox(TEST_TEAM, 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' });
    rotateOutboxIfNeeded(TEST_TEAM, 'w1', 100);
    const lines = readFileSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});

describe('readNewInboxMessages', () => {
  it('reads new messages with offset cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg1: InboxMessage = { type: 'message', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    const msg2: InboxMessage = { type: 'context', content: 'ctx', timestamp: '2026-01-01T00:01:00Z' };

    writeFileSync(inbox, JSON.stringify(msg1) + '\n');
    const batch1 = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(batch1).toHaveLength(1);
    expect(batch1[0].content).toBe('hello');

    // Append more - cursor should skip first message
    const content = readFileSync(inbox, 'utf-8');
    writeFileSync(inbox, content + JSON.stringify(msg2) + '\n');
    const batch2 = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(batch2).toHaveLength(1);
    expect(batch2[0].content).toBe('ctx');
  });

  it('returns empty for no inbox file', () => {
    expect(readNewInboxMessages(TEST_TEAM, 'noworker')).toEqual([]);
  });

  it('handles file truncation (cursor reset)', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const longMsg: InboxMessage = { type: 'message', content: 'a'.repeat(100), timestamp: '2026-01-01T00:00:00Z' };
    writeFileSync(inbox, JSON.stringify(longMsg) + '\n');
    readNewInboxMessages(TEST_TEAM, 'w1'); // sets cursor past EOF

    // Truncate file to something smaller
    const shortMsg: InboxMessage = { type: 'message', content: 'new', timestamp: '2026-01-01T00:01:00Z' };
    writeFileSync(inbox, JSON.stringify(shortMsg) + '\n');
    const msgs = readNewInboxMessages(TEST_TEAM, 'w1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });
});

describe('readAllInboxMessages', () => {
  it('reads all messages regardless of cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg1: InboxMessage = { type: 'message', content: 'first', timestamp: '2026-01-01T00:00:00Z' };
    const msg2: InboxMessage = { type: 'message', content: 'second', timestamp: '2026-01-01T00:01:00Z' };
    writeFileSync(inbox, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    const all = readAllInboxMessages(TEST_TEAM, 'w1');
    expect(all).toHaveLength(2);
    expect(all[0].content).toBe('first');
    expect(all[1].content).toBe('second');
  });

  it('returns empty for missing inbox', () => {
    expect(readAllInboxMessages(TEST_TEAM, 'noworker')).toEqual([]);
  });
});

describe('clearInbox', () => {
  it('truncates inbox and resets cursor', () => {
    const inbox = join(TEAMS_DIR, 'inbox', 'w1.jsonl');
    const msg: InboxMessage = { type: 'message', content: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    writeFileSync(inbox, JSON.stringify(msg) + '\n');
    readNewInboxMessages(TEST_TEAM, 'w1'); // advance cursor

    clearInbox(TEST_TEAM, 'w1');

    expect(readFileSync(inbox, 'utf-8')).toBe('');
    expect(readAllInboxMessages(TEST_TEAM, 'w1')).toEqual([]);
  });
});

describe('shutdown signals', () => {
  it('write, check, delete cycle', () => {
    writeShutdownSignal(TEST_TEAM, 'w1', 'req-123', 'done');
    const sig = checkShutdownSignal(TEST_TEAM, 'w1');
    expect(sig?.requestId).toBe('req-123');
    expect(sig?.reason).toBe('done');

    deleteShutdownSignal(TEST_TEAM, 'w1');
    expect(checkShutdownSignal(TEST_TEAM, 'w1')).toBeNull();
  });

  it('returns null when no signal exists', () => {
    expect(checkShutdownSignal(TEST_TEAM, 'nosignal')).toBeNull();
  });
});

describe('cleanupWorkerFiles', () => {
  it('removes inbox, outbox, cursor, signal files', () => {
    appendOutbox(TEST_TEAM, 'w1', { type: 'idle', timestamp: '2026-01-01T00:00:00Z' });
    writeShutdownSignal(TEST_TEAM, 'w1', 'req', 'test');
    writeFileSync(join(TEAMS_DIR, 'inbox', 'w1.jsonl'), '{}');
    writeFileSync(join(TEAMS_DIR, 'inbox', 'w1.offset'), '{}');

    cleanupWorkerFiles(TEST_TEAM, 'w1');
    expect(existsSync(join(TEAMS_DIR, 'outbox', 'w1.jsonl'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'inbox', 'w1.jsonl'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'inbox', 'w1.offset'))).toBe(false);
    expect(existsSync(join(TEAMS_DIR, 'signals', 'w1.shutdown'))).toBe(false);
  });
});
