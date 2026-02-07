// src/team/mcp-team-bridge.ts
/**
 * MCP Team Bridge Daemon
 *
 * Core bridge process that runs in a tmux session alongside a Codex/Gemini CLI.
 * Polls task files, builds prompts, spawns CLI processes, reports results.
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { findNextTask, updateTask, writeTaskFailure, readTaskFailure } from './task-file-ops.js';
import { readNewInboxMessages, appendOutbox, rotateOutboxIfNeeded, checkShutdownSignal, deleteShutdownSignal } from './inbox-outbox.js';
import { unregisterMcpWorker } from './team-registration.js';
import { writeHeartbeat, deleteHeartbeat } from './heartbeat.js';
import { killSession } from './tmux-session.js';
/** Simple logger */
function log(message) {
    const ts = new Date().toISOString();
    console.log(`${ts} ${message}`);
}
/** Sleep helper */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** Maximum stdout/stderr buffer size (10MB) */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
/** Build heartbeat data */
function buildHeartbeat(config, status, currentTaskId, consecutiveErrors) {
    return {
        workerName: config.workerName,
        teamName: config.teamName,
        provider: config.provider,
        pid: process.pid,
        lastPollAt: new Date().toISOString(),
        currentTaskId: currentTaskId || undefined,
        consecutiveErrors,
        status,
    };
}
/** Build prompt for CLI from task + inbox messages */
function buildTaskPrompt(task, messages, config) {
    let inboxContext = '';
    if (messages.length > 0) {
        inboxContext = '\nCONTEXT FROM TEAM LEAD:\n' +
            messages.map(m => `[${m.timestamp}] ${m.content}`).join('\n') + '\n';
    }
    return `CONTEXT: You are an autonomous code executor working on a specific task.
You have FULL filesystem access within the working directory.
You can read files, write files, run shell commands, and make code changes.

TASK:
${task.subject}

DESCRIPTION:
${task.description}

WORKING DIRECTORY: ${config.workingDirectory}
${inboxContext}
INSTRUCTIONS:
- Complete the task described above
- Make all necessary code changes directly
- Run relevant verification commands (build, test, lint) to confirm your changes work
- Write a clear summary of what you did to the output file
- If you encounter blocking issues, document them clearly in your output

OUTPUT EXPECTATIONS:
- Document all files you modified
- Include verification results (build/test output)
- Note any issues or follow-up work needed
`;
}
/** Write prompt to a file for audit trail */
function writePromptFile(config, taskId, prompt) {
    const dir = join(config.workingDirectory, '.omc', 'prompts');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const filename = `team-${config.teamName}-task-${taskId}-${Date.now()}.md`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, prompt, 'utf-8');
    return filePath;
}
/** Get output file path for a task */
function getOutputPath(config, taskId) {
    const dir = join(config.workingDirectory, '.omc', 'outputs');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, `team-${config.teamName}-task-${taskId}-${Date.now()}.md`);
}
/** Read output summary (first 500 chars) */
function readOutputSummary(outputFile) {
    try {
        if (!existsSync(outputFile))
            return '(no output file)';
        const content = readFileSync(outputFile, 'utf-8');
        if (content.length > 500) {
            return content.slice(0, 500) + '... (truncated)';
        }
        return content || '(empty output)';
    }
    catch {
        return '(error reading output)';
    }
}
/** Parse Codex JSONL output to extract text responses */
function parseCodexOutput(output) {
    const lines = output.trim().split('\n').filter(l => l.trim());
    const messages = [];
    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
                messages.push(event.item.text);
            }
            if (event.type === 'message' && event.content) {
                if (typeof event.content === 'string')
                    messages.push(event.content);
                else if (Array.isArray(event.content)) {
                    for (const part of event.content) {
                        if (part.type === 'text' && part.text)
                            messages.push(part.text);
                    }
                }
            }
            if (event.type === 'output_text' && event.text)
                messages.push(event.text);
        }
        catch { /* skip non-JSON lines */ }
    }
    return messages.join('\n') || output;
}
/**
 * Spawn a CLI process and return both the child handle and a result promise.
 * This allows the bridge to kill the child on shutdown while still awaiting the result.
 */
function spawnCliProcess(provider, prompt, model, cwd, timeoutMs) {
    let args;
    let cmd;
    if (provider === 'codex') {
        cmd = 'codex';
        args = ['exec', '-m', model || 'gpt-5.3-codex', '--json', '--full-auto'];
    }
    else {
        cmd = 'gemini';
        args = ['--yolo'];
        if (model)
            args.push('--model', model);
    }
    const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        ...(process.platform === 'win32' ? { shell: true } : {})
    });
    const result = new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
                reject(new Error(`CLI timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);
        child.stdout?.on('data', (data) => {
            if (stdout.length < MAX_BUFFER_SIZE)
                stdout += data.toString();
        });
        child.stderr?.on('data', (data) => {
            if (stderr.length < MAX_BUFFER_SIZE)
                stderr += data.toString();
        });
        child.on('close', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                if (code === 0 || stdout.trim()) {
                    const response = provider === 'codex' ? parseCodexOutput(stdout) : stdout.trim();
                    resolve(response);
                }
                else {
                    reject(new Error(`CLI exited with code ${code}: ${stderr || 'No output'}`));
                }
            }
        });
        child.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
            }
        });
        // Write prompt via stdin
        child.stdin?.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                child.kill('SIGTERM');
                reject(new Error(`Stdin write error: ${err.message}`));
            }
        });
        child.stdin?.write(prompt);
        child.stdin?.end();
    });
    return { child, result };
}
/** Handle graceful shutdown */
async function handleShutdown(config, signal, activeChild) {
    const { teamName, workerName, workingDirectory } = config;
    log(`[bridge] Shutdown signal received: ${signal.reason}`);
    // 1. Kill running CLI subprocess
    if (activeChild && !activeChild.killed) {
        let closed = false;
        activeChild.on('close', () => { closed = true; });
        activeChild.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => activeChild.on('close', () => resolve())),
            sleep(5000)
        ]);
        if (!closed) {
            activeChild.kill('SIGKILL');
        }
    }
    // 2. Write shutdown ack to outbox
    appendOutbox(teamName, workerName, {
        type: 'shutdown_ack',
        requestId: signal.requestId,
        timestamp: new Date().toISOString()
    });
    // 3. Unregister from config.json / shadow registry
    try {
        unregisterMcpWorker(teamName, workerName, workingDirectory);
    }
    catch { /* ignore */ }
    // 4. Clean up signal file
    deleteShutdownSignal(teamName, workerName);
    // 5. Clean up heartbeat
    deleteHeartbeat(workingDirectory, teamName, workerName);
    // 6. Outbox/inbox preserved for lead to read final ack
    log(`[bridge] Shutdown complete. Goodbye.`);
    // 7. Kill own tmux session (terminates this process)
    try {
        killSession(teamName, workerName);
    }
    catch { /* ignore — this kills us */ }
}
/** Main bridge daemon entry point */
export async function runBridge(config) {
    const { teamName, workerName, provider, workingDirectory } = config;
    let consecutiveErrors = 0;
    let idleNotified = false;
    let quarantineNotified = false;
    let activeChild = null;
    log(`[bridge] ${workerName}@${teamName} starting (${provider})`);
    while (true) {
        try {
            // --- 1. Check shutdown signal ---
            const shutdown = checkShutdownSignal(teamName, workerName);
            if (shutdown) {
                await handleShutdown(config, shutdown, activeChild);
                break;
            }
            // --- 2. Check self-quarantine ---
            if (consecutiveErrors >= config.maxConsecutiveErrors) {
                if (!quarantineNotified) {
                    appendOutbox(teamName, workerName, {
                        type: 'error',
                        message: `Self-quarantined after ${consecutiveErrors} consecutive errors. Awaiting lead intervention or shutdown.`,
                        timestamp: new Date().toISOString()
                    });
                    quarantineNotified = true;
                }
                writeHeartbeat(workingDirectory, buildHeartbeat(config, 'quarantined', null, consecutiveErrors));
                // Stay alive but stop processing — just check shutdown signals
                await sleep(config.pollIntervalMs * 3);
                continue;
            }
            // --- 3. Write heartbeat ---
            writeHeartbeat(workingDirectory, buildHeartbeat(config, 'polling', null, consecutiveErrors));
            // --- 4. Read inbox ---
            const messages = readNewInboxMessages(teamName, workerName);
            // --- 5. Find next task ---
            const task = findNextTask(teamName, workerName);
            if (task) {
                idleNotified = false;
                // --- 6. Mark in_progress ---
                updateTask(teamName, task.id, { status: 'in_progress' });
                writeHeartbeat(workingDirectory, buildHeartbeat(config, 'executing', task.id, consecutiveErrors));
                // Re-check shutdown before spawning CLI (prevents race #11)
                const shutdownBeforeSpawn = checkShutdownSignal(teamName, workerName);
                if (shutdownBeforeSpawn) {
                    updateTask(teamName, task.id, { status: 'pending' }); // Revert
                    await handleShutdown(config, shutdownBeforeSpawn, null);
                    return;
                }
                // --- 7. Build prompt ---
                const prompt = buildTaskPrompt(task, messages, config);
                const promptFile = writePromptFile(config, task.id, prompt);
                const outputFile = getOutputPath(config, task.id);
                log(`[bridge] Executing task ${task.id}: ${task.subject}`);
                // --- 8. Execute CLI ---
                try {
                    const { child, result } = spawnCliProcess(provider, prompt, config.model, workingDirectory, config.taskTimeoutMs);
                    activeChild = child;
                    const response = await result;
                    activeChild = null;
                    // Write response to output file
                    writeFileSync(outputFile, response, 'utf-8');
                    // --- 9. Mark complete ---
                    updateTask(teamName, task.id, { status: 'completed' });
                    consecutiveErrors = 0;
                    // --- 10. Report to lead ---
                    const summary = readOutputSummary(outputFile);
                    appendOutbox(teamName, workerName, {
                        type: 'task_complete',
                        taskId: task.id,
                        summary,
                        timestamp: new Date().toISOString()
                    });
                    log(`[bridge] Task ${task.id} completed`);
                }
                catch (err) {
                    activeChild = null;
                    consecutiveErrors++;
                    // --- Failure state policy ---
                    const errorMsg = err.message;
                    writeTaskFailure(teamName, task.id, errorMsg);
                    updateTask(teamName, task.id, { status: 'pending' });
                    const failure = readTaskFailure(teamName, task.id);
                    appendOutbox(teamName, workerName, {
                        type: 'task_failed',
                        taskId: task.id,
                        error: `${errorMsg} (attempt ${failure?.retryCount || 1})`,
                        timestamp: new Date().toISOString()
                    });
                    log(`[bridge] Task ${task.id} failed: ${errorMsg}`);
                }
            }
            else {
                // --- No tasks available ---
                if (!idleNotified) {
                    appendOutbox(teamName, workerName, {
                        type: 'idle',
                        message: 'All assigned tasks complete. Standing by.',
                        timestamp: new Date().toISOString()
                    });
                    idleNotified = true;
                }
            }
            // --- 11. Rotate outbox if needed ---
            rotateOutboxIfNeeded(teamName, workerName, config.outboxMaxLines);
            // --- 12. Poll interval ---
            await sleep(config.pollIntervalMs);
        }
        catch (err) {
            // Broad catch to prevent daemon crash on transient I/O errors
            log(`[bridge] Poll cycle error: ${err.message}`);
            consecutiveErrors++;
            await sleep(config.pollIntervalMs);
        }
    }
}
//# sourceMappingURL=mcp-team-bridge.js.map