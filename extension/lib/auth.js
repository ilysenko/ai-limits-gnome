import GLib from 'gi://GLib';

import {expandPath} from './files.js';

export class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
    }
}

export function defaultCodexAuthPath() {
    const codexHome = (GLib.getenv('CODEX_HOME') ?? '').trim();
    const dir = codexHome || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
    return GLib.build_filenamev([dir, 'auth.json']);
}

export function defaultClaudeCredentialsPath() {
    const configDir = (GLib.getenv('CLAUDE_CONFIG_DIR') ?? '').trim();
    const dir = configDir || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([dir, '.credentials.json']);
}

export function resolveCodexAuthPath(setting) {
    return expandPath(setting) || defaultCodexAuthPath();
}

export function resolveClaudeCredentialsPath(setting) {
    return expandPath(setting) || defaultClaudeCredentialsPath();
}

/** Expiry (ms since epoch) from a JWT's `exp` claim, or null. */
export function jwtExpiryMs(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3)
        return null;

    try {
        let payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
        while (payload.length % 4 !== 0)
            payload += '=';
        const claims = JSON.parse(new TextDecoder().decode(GLib.base64_decode(payload)));
        return Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
    } catch (error) {
        return null;
    }
}

/** Tokens from the Codex CLI auth.json. */
export function parseCodexAuth(data) {
    const tokens = data?.tokens;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
    if (!accessToken)
        throw new AuthError('No Codex access token found. Run `codex login`.');

    return {
        accessToken,
        refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
        expiresAtMs: jwtExpiryMs(accessToken),
        plan: null,
    };
}

/** Tokens from the Claude Code .credentials.json. */
export function parseClaudeCredentials(data) {
    const oauth = data?.claudeAiOauth;
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
    if (!accessToken)
        throw new AuthError('No Claude access token found. Run `claude` and sign in.');

    return {
        accessToken,
        refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null,
        accountId: null,
        expiresAtMs: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
        plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter(s => typeof s === 'string') : [],
    };
}

export function isExpired(auth, skewMs = 60_000) {
    return auth.expiresAtMs !== null && auth.expiresAtMs - skewMs <= Date.now();
}
