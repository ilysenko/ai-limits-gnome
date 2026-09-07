import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

/**
 * Small promise wrapper around Soup.Session.
 * Every request goes through one session so disable() can abort them all.
 */
export class Http {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
        // Hosts that only publish AAAA records hang for the full timeout on
        // machines without a global IPv6 route (a VPN handing out AAAA but no
        // v6 gateway does this). Binding a v4 local address forces IPv4.
        this._session4 = new Soup.Session({
            timeout: 10,
            local_address: new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_any(Gio.SocketFamily.IPV4),
                port: 0,
            }),
        });
        this._cancellable = new Gio.Cancellable();
    }

    /** Retry once over IPv4 when the default (possibly IPv6) route fails. */
    async request(method, url, options = {}) {
        try {
            return await this._send(this._session, method, url, options);
        } catch (error) {
            if (this._cancellable.is_cancelled() || !isUnreachable(error))
                throw error;
            return this._send(this._session4, method, url, options);
        }
    }

    _send(session, method, url, {headers = {}, json} = {}) {
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

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (source, result) => {
                    let bytes;
                    try {
                        bytes = source.send_and_read_finish(result);
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
        this._session4.abort();
        this._session = null;
        this._session4 = null;
    }
}

/** Network-level failure worth retrying on another address family. */
function isUnreachable(error) {
    return error instanceof GLib.Error && (
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NETWORK_UNREACHABLE) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.HOST_UNREACHABLE) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.HOST_NOT_FOUND) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT) ||
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED));
}
