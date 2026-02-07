// src/team/bridge-entry.ts
//
// Entry point for the bridge daemon, invoked from tmux:
//   node dist/team/bridge-entry.js --config /path/to/config.json
//
// Config via temp file, not inline JSON argument.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runBridge } from './mcp-team-bridge.js';
import { deleteHeartbeat } from './heartbeat.js';
import { unregisterMcpWorker } from './team-registration.js';
function main() {
    // Parse --config flag
    const configIdx = process.argv.indexOf('--config');
    if (configIdx === -1 || !process.argv[configIdx + 1]) {
        console.error('Usage: node bridge-entry.js --config <path-to-config.json>');
        process.exit(1);
    }
    const configPath = resolve(process.argv[configIdx + 1]);
    let config;
    try {
        const raw = readFileSync(configPath, 'utf-8');
        config = JSON.parse(raw);
    }
    catch (err) {
        console.error(`Failed to read config from ${configPath}: ${err.message}`);
        process.exit(1);
    }
    // Validate required fields
    const required = ['teamName', 'workerName', 'provider', 'workingDirectory'];
    for (const field of required) {
        if (!config[field]) {
            console.error(`Missing required config field: ${field}`);
            process.exit(1);
        }
    }
    // Validate provider
    if (config.provider !== 'codex' && config.provider !== 'gemini') {
        console.error(`Invalid provider: ${config.provider}. Must be 'codex' or 'gemini'.`);
        process.exit(1);
    }
    // Apply defaults
    config.pollIntervalMs = config.pollIntervalMs || 3000;
    config.taskTimeoutMs = config.taskTimeoutMs || 600_000;
    config.maxConsecutiveErrors = config.maxConsecutiveErrors || 3;
    config.outboxMaxLines = config.outboxMaxLines || 500;
    // Signal handlers for graceful cleanup on external termination
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            console.error(`[bridge] Received ${sig}, shutting down...`);
            try {
                deleteHeartbeat(config.workingDirectory, config.teamName, config.workerName);
                unregisterMcpWorker(config.teamName, config.workerName, config.workingDirectory);
            }
            catch { /* best-effort cleanup */ }
            process.exit(0);
        });
    }
    // Run bridge (never returns unless shutdown)
    runBridge(config).catch(err => {
        console.error(`[bridge] Fatal error: ${err.message}`);
        process.exit(1);
    });
}
main();
//# sourceMappingURL=bridge-entry.js.map