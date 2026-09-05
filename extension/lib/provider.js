import {AuthError, isExpired} from './auth.js';

/** Error shown in the popup; `kind` drives the panel marker and backoff. */
export class ProviderError extends Error {
    constructor(message, kind, status = 0) {
        super(message);
        this.name = 'ProviderError';
        this.kind = kind; // 'file' | 'auth' | 'ratelimit' | 'http' | 'network'
        this.status = status;
    }

    static throwIfFailed(response, service, loginCommand) {
        if (response.ok)
            return;
        if (response.status === 401 || response.status === 403)
            throw new ProviderError(`${service} rejected the token (HTTP ${response.status}). Run \`${loginCommand}\` to sign in again.`, 'auth', response.status);
        if (response.status === 429)
            throw new ProviderError(`${service} is rate limiting usage requests (HTTP 429).`, 'ratelimit', response.status);
        throw new ProviderError(`${service} usage request failed (HTTP ${response.status}).`, 'http', response.status);
    }

    static from(error) {
        if (error instanceof ProviderError)
            return error;
        if (error instanceof AuthError)
            return new ProviderError(error.message, 'auth');
        if (error?.message?.startsWith('Cannot read') || error?.message?.endsWith('not valid JSON'))
            return new ProviderError(error.message, 'file');
        return new ProviderError(error?.message ?? String(error), 'network');
    }
}

/**
 * Loads a login file, refreshes the access token when it has expired and
 * writes the rotated tokens back, the way the CLIs themselves do.
 *
 * Refresh tokens are single use, so a refresh is only attempted after
 * re-reading the file (the CLI may have refreshed it in the meantime) and a
 * successful exchange is always persisted before it is used.
 */
export class TokenRefresher {
    constructor({parse, refresh, apply, readJson, writeJson}) {
        this._parse = parse;
        this._refresh = refresh;
        this._apply = apply;
        this._readJson = readJson;
        this._writeJson = writeJson;
        this._inflight = null;
    }

    async load(path, {autoRefresh}) {
        const {data} = await this._readJson(path);
        const auth = this._parse(data);
        if (!isExpired(auth))
            return auth;
        if (!autoRefresh)
            throw new AuthError('Access token has expired. Enable token refresh in the settings or run the CLI once.');
        return this.forceRefresh(path);
    }

    forceRefresh(path) {
        if (!this._inflight) {
            this._inflight = this._doRefresh(path).finally(() => {
                this._inflight = null;
            });
        }
        return this._inflight;
    }

    async _doRefresh(path) {
        const {data, pretty} = await this._readJson(path);
        const current = this._parse(data);
        if (!isExpired(current, 0))
            return current; // the CLI already refreshed it

        let tokens;
        try {
            tokens = await this._refresh(current);
        } catch (error) {
            // A competing refresh may have rotated the token under us: re-read once.
            const {data: latest} = await this._readJson(path);
            const fresh = this._parse(latest);
            if (fresh.accessToken !== current.accessToken && !isExpired(fresh, 0))
                return fresh;
            throw error;
        }

        this._apply(data, tokens);
        await this._writeJson(path, data, pretty);
        return this._parse(data);
    }
}
