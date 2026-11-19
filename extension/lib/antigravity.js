import GLib from 'gi://GLib';

import {normalizeAntigravity} from './model.js';
import {ProviderError} from './provider.js';

const TIMEOUT_SECONDS = 45;

/**
 * The CLI's default install location, then PATH; '' when neither has it.
 * ~/.local/bin comes first because a GNOME session does not always have it on PATH.
 */
export function findAntigravityCli() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'agy']);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
        return local;
    return GLib.find_program_in_path('agy') ?? '';
}

/** Antigravity (Gemini) quota, read by running the Antigravity CLI. */
export class AntigravityProvider {
    constructor(subprocess) {
        this._subprocess = subprocess;
    }

    async fetch() {
        const agy = findAntigravityCli();
        if (!agy)
            throw new ProviderError('The Antigravity CLI (agy) is not installed. Get it from antigravity.google.', 'file');

        // Print mode: no TTY, no conversation, no quota spent. The log file would
        // otherwise pile up one ~20 KB file per call.
        const argv = [agy, '-p', '/usage', '--output-format', 'json', '--log-file', '/dev/null'];
        let result;
        try {
            result = await this._subprocess.run(argv, {timeoutSeconds: TIMEOUT_SECONDS});
        } catch (error) {
            throw new ProviderError(`Cannot run the Antigravity CLI (${agy}).`, 'file');
        }

        if (result.timedOut)
            throw new ProviderError(`The Antigravity CLI did not answer within ${TIMEOUT_SECONDS}s.`, 'network');

        if (!result.ok)
            throw this._failure(result);

        let payload;
        try {
            payload = JSON.parse(result.stdout);
        } catch (error) {
            throw new ProviderError('The Antigravity CLI returned output this version cannot read.', 'http');
        }

        if (payload?.status && payload.status !== 'SUCCESS')
            throw new ProviderError(`The Antigravity CLI reported ${payload.status}.`, 'http');

        return normalizeAntigravity(payload);
    }

    /** The CLI reports a missing login on stderr rather than with its own exit code. */
    _failure(result) {
        const text = `${result.stderr} ${result.stdout}`.toLowerCase();
        if (/auth|login|sign in|credential|unauthor/.test(text))
            return new ProviderError(`The Antigravity CLI is not signed in. Run \`agy\` once and sign in.`, 'auth');

        const detail = result.stderr.trim().split('\n')[0] || `exit status ${result.status}`;
        return new ProviderError(`The Antigravity CLI failed: ${detail}`, 'http');
    }
}
