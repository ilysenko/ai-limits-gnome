import GLib from 'gi://GLib';

import {expandPath} from './files.js';
import {normalizeAntigravity} from './model.js';
import {ProviderError} from './provider.js';

const DEFAULT_COMMAND = 'agy';
// Print mode: no TTY, no conversation, no quota spent. The log file would
// otherwise pile up one ~20 KB file per call.
const ARGS = ['-p', '/usage', '--output-format', 'json', '--log-file', '/dev/null'];
const TIMEOUT_SECONDS = 45;
const INSTALL_HINT = 'Install it from antigravity.google or set its path in the settings.';

/** Antigravity (Gemini) quota, read by running the Antigravity CLI. */
export class AntigravityProvider {
    constructor(subprocess, options) {
        this._subprocess = subprocess;
        this._options = options; // {getCommand}
    }

    get name() {
        return 'Antigravity';
    }

    async fetch() {
        const command = this._resolveCommand();
        let result;

        try {
            result = await this._subprocess.run([command, ...ARGS], {timeoutSeconds: TIMEOUT_SECONDS});
        } catch (error) {
            throw new ProviderError(`Cannot run the Antigravity CLI (${command}). ${INSTALL_HINT}`, 'file');
        }

        if (result.timedOut)
            throw new ProviderError(`The Antigravity CLI did not answer within ${TIMEOUT_SECONDS}s.`, 'network');

        if (!result.ok)
            throw this._failure(command, result);

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

    _resolveCommand() {
        const configured = expandPath(this._options.getCommand());
        if (configured)
            return configured;
        // Spawning by name needs it on PATH, which a GNOME session does not always share.
        const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', DEFAULT_COMMAND]);
        if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
            return local;
        return GLib.find_program_in_path(DEFAULT_COMMAND) ?? DEFAULT_COMMAND;
    }

    /** The CLI reports a missing login on stderr rather than with its own exit code. */
    _failure(command, result) {
        const text = `${result.stderr} ${result.stdout}`.toLowerCase();
        if (/auth|login|sign in|credential|unauthor/.test(text))
            return new ProviderError(`The Antigravity CLI is not signed in. Run \`${command}\` once and sign in.`, 'auth');

        const detail = result.stderr.trim().split('\n')[0] || `exit status ${result.status}`;
        return new ProviderError(`The Antigravity CLI failed: ${detail}`, 'http');
    }
}
