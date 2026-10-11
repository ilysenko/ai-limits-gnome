import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/**
 * Runs short-lived helper commands.
 *
 * Every process is tracked so disable() can end it, and each one gets a
 * deadline: a CLI that hangs must not keep a child alive behind the shell.
 */
export class Subprocess {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._running = new Set();
    }

    /**
     * Resolves to {ok, timedOut, status, stdout, stderr}; throws only if the
     * program cannot be started.
     *
     * The deadline settles the promise on its own rather than waiting for the
     * pipes to close: a child that leaves a grandchild holding stdout would
     * otherwise never let go, and one stuck call would block every later one.
     */
    async run(argv, {timeoutSeconds = 45} = {}) {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._running.add(proc);

        let timeoutId = 0;
        const deadline = new Promise(resolve => {
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timeoutId = 0;
                proc.force_exit();
                resolve({ok: false, timedOut: true, status: -1, stdout: '', stderr: ''});
                return GLib.SOURCE_REMOVE;
            });
        });

        const communicate = proc.communicate_utf8_async(null, this._cancellable).then(
            ([stdout, stderr]) => ({
                ok: proc.get_successful(),
                timedOut: false,
                status: proc.get_if_exited() ? proc.get_exit_status() : -1,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
            }),
            error => {
                if (this._cancellable.is_cancelled())
                    return {ok: false, timedOut: false, status: -1, stdout: '', stderr: 'cancelled'};
                throw error;
            });

        try {
            return await Promise.race([communicate, deadline]);
        } finally {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            this._running.delete(proc);
        }
    }

    dispose() {
        this._cancellable.cancel();
        for (const proc of this._running)
            proc.force_exit();
        this._running.clear();
    }
}
