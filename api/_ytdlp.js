import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// yt-dlp dropped Python 3.9, which is all macOS ships (/usr/bin/python3). Pinning to
// the system interpreter freezes yt-dlp at its last 3.9-compatible release, and a stale
// yt-dlp fails YouTube extraction ("The page needs to be reloaded"). Prefer a modern
// interpreter that can run current yt-dlp.
const CANDIDATES = [
    process.env.YT_DLP_PYTHON,
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(process.env.HOME || '', '.local', 'bin', 'python3.12'),
    path.join(process.env.HOME || '', '.local', 'bin', 'python3.11'),
    path.join(process.env.HOME || '', '.local', 'bin', 'python3.10'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    'python3'
];

let cachedPython = null;

export function resolvePython() {
    if (cachedPython) return cachedPython;
    for (const candidate of CANDIDATES) {
        if (!candidate) continue;
        // Bare command names are resolved via PATH by spawn, so accept them unchecked
        if (!candidate.includes('/') || existsSync(candidate)) {
            cachedPython = candidate;
            return cachedPython;
        }
    }
    cachedPython = 'python3';
    return cachedPython;
}

// yt-dlp prints the Python-version deprecation notice to stderr on every run and
// --no-warnings does not suppress it. It leaks into user-facing error text, so drop it.
export function cleanStderr(stderr) {
    return stderr
        .split('\n')
        .filter(line => !/Deprecated Feature: Support for Python version/i.test(line))
        .join('\n')
        .trim();
}

// Clients are tried in order when YouTube rejects a request. The default (no override)
// works with current yt-dlp; the android clients are fallbacks that survive most
// server-side changes, and cost nothing when the first attempt succeeds.
export const CLIENT_FALLBACKS = [null, 'android', 'android_vr', 'tv'];

function clientArgs(client) {
    return client ? ['--extractor-args', `youtube:player_client=${client}`] : [];
}

function isRetryable(stderr) {
    return /page needs to be reloaded|Requested format is not available|Sign in to confirm|unable to extract|Failed to extract|nsig extraction|HTTP Error 4\d\d/i.test(stderr);
}

/**
 * Run yt-dlp and collect stdout. Retries across player clients on extraction errors.
 */
export function runYtDlp(args, { clients = CLIENT_FALLBACKS } = {}) {
    return new Promise((resolve, reject) => {
        const python = resolvePython();
        let attempt = 0;

        const tryNext = () => {
            const client = clients[attempt];
            const proc = spawn(python, ['-m', 'yt_dlp', '--no-warnings', ...clientArgs(client), ...args]);
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', d => stdout += d);
            proc.stderr.on('data', d => stderr += d);

            proc.on('close', code => {
                if (code === 0) return resolve(stdout.trim());
                const cleaned = cleanStderr(stderr);
                attempt++;
                if (attempt < clients.length && isRetryable(cleaned)) {
                    console.warn(`yt-dlp attempt ${attempt} failed (${client || 'default'}), retrying with ${clients[attempt]}`);
                    return tryNext();
                }
                reject(new Error(cleaned || `yt-dlp exited ${code}`));
            });

            proc.on('error', err => {
                attempt++;
                if (attempt < clients.length) return tryNext();
                reject(err);
            });
        };

        tryNext();
    });
}

/**
 * Stream yt-dlp stdout into a writable response. Retries with the next player client
 * only while no bytes have been written, since a partial stream cannot be restarted.
 *
 * onFirstByte fires just before the first chunk reaches the response, so callers can
 * set download headers only once the stream is known to be good — a failure before
 * that point can still be answered with a JSON error.
 */
export function streamYtDlp(args, res, { clients = CLIENT_FALLBACKS, onFirstByte, onError } = {}) {
    const python = resolvePython();
    let attempt = 0;

    const tryNext = () => {
        const client = clients[attempt];
        const proc = spawn(python, ['-m', 'yt_dlp', '--no-warnings', ...clientArgs(client), ...args]);
        let wroteBytes = false;
        let stderr = '';

        // Registered before pipe() so headers are set before the first chunk is written
        proc.stdout.once('data', () => {
            wroteBytes = true;
            onFirstByte?.();
        });
        // pipe() preserves backpressure; end: false lets us control when the response closes
        proc.stdout.pipe(res, { end: false });

        proc.stderr.on('data', chunk => {
            stderr += chunk;
            process.stderr.write(chunk);
        });

        proc.on('close', code => {
            if (code === 0) return res.end();

            const cleaned = cleanStderr(stderr);
            attempt++;
            if (!wroteBytes && attempt < clients.length && isRetryable(cleaned)) {
                console.warn(`yt-dlp stream attempt ${attempt} failed (${client || 'default'}), retrying with ${clients[attempt]}`);
                return tryNext();
            }
            onError?.(new Error(cleaned || `yt-dlp exited ${code}`), wroteBytes);
        });

        proc.on('error', err => {
            attempt++;
            if (!wroteBytes && attempt < clients.length) return tryNext();
            onError?.(err, wroteBytes);
        });
    };

    tryNext();
}
