import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

/**
 * Small promise wrapper around Soup.Session.
 * Every request goes through one session so disable() can abort them all.
 */
export class Http {
    constructor() {
        this._session = new Soup.Session({timeout: 30});
        this._cancellable = new Gio.Cancellable();
    }

    request(method, url, {headers = {}, json} = {}) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new(method, url);
            if (!message) {
                reject(new Error(`Invalid URL: ${url}`));
                return;
            }

            for (const [name, value] of Object.entries(headers))
                message.request_headers.replace(name, String(value));

            if (json !== undefined) {
                const body = new TextEncoder().encode(JSON.stringify(json));
                message.set_request_body_from_bytes('application/json', new GLib.Bytes(body));
            }

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    let bytes;
                    try {
                        bytes = session.send_and_read_finish(result);
                    } catch (error) {
                        reject(error);
                        return;
                    }

                    // status_code is a plain integer; get_status() maps to the
                    // Soup.Status enum and throws for codes it does not know (429).
                    const status = message.status_code;
                    const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                    resolve({
                        status,
                        ok: status >= 200 && status < 300,
                        text,
                        json() {
                            return JSON.parse(text);
                        },
                    });
                });
        });
    }

    dispose() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
    }
}
