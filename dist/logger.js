import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.config', 'opencode-multi-auth', 'logs');
const LOG_FILE = process.env.CODEX_SOFT_LOG_PATH || path.join(DEFAULT_LOG_DIR, 'codex-soft.log');
const MAX_LOG_LINES = 400;
// Fixed log path for openai-router — used by log() and error()
const ROUTER_LOG_PATH = '/tmp/openai-router.log';
function ensureDir() {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
function sanitize(message) {
    return message
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
        .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[token]');
}
function append(level, message) {
    try {
        ensureDir();
        const line = `${new Date().toISOString()} [${level}] ${sanitize(message)}\n`;
        fs.appendFileSync(LOG_FILE, line, { encoding: 'utf-8', mode: 0o600 });
    }
    catch {
        // Ignore log write failures
    }
}
export function logInfo(message) {
    append('info', message);
}
export function logWarn(message) {
    append('warn', message);
}
export function logError(message) {
    append('error', message);
}
export function getLogPath() {
    return LOG_FILE;
}
export function readLogTail(maxLines = MAX_LOG_LINES) {
    try {
        if (!fs.existsSync(LOG_FILE))
            return [];
        const data = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = data.split('\n').filter(Boolean);
        return lines.slice(Math.max(0, lines.length - maxLines));
    }
    catch {
        return [];
    }
}
// ─── Router-specific log functions (silent TUI) ───────────────────────
function ensureRouterLogDir() {
    const dir = path.dirname(ROUTER_LOG_PATH);
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        catch {
            // ignore
        }
    }
}
/**
 * Write a log message to /tmp/openai-router.log.
 * Silently ignores write failures.
 */
export function log(message) {
    try {
        ensureRouterLogDir();
        const line = `${new Date().toISOString()} [info] ${message}\n`;
        fs.appendFileSync(ROUTER_LOG_PATH, line, { encoding: 'utf-8', mode: 0o600 });
    }
    catch {
        // ignore
    }
}
/**
 * Write an error message to /tmp/openai-router.log.
 * Silently ignores write failures.
 */
export function error(message) {
    try {
        ensureRouterLogDir();
        const line = `${new Date().toISOString()} [error] ${message}\n`;
        fs.appendFileSync(ROUTER_LOG_PATH, line, { encoding: 'utf-8', mode: 0o600 });
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=logger.js.map