import {readJson, writeJsonPrivate} from './files.js';
import {AuthError, parseClaudeCredentials} from './auth.js';
import {normalizeClaude} from './model.js';
import {ProviderError, TokenRefresher} from './provider.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URLS = [
    'https://platform.claude.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token',
];
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = ['user:inference', 'user:profile'];
const BETA_HEADER = 'oauth-2025-04-20';
// Both endpoints are gated on Claude Code's own user agent: with anything else
// the usage endpoint falls into a much stricter rate-limit bucket and the token
// endpoint answers 429 outright.
const USER_AGENT = 'claude-cli/2.1.259 (external, cli)';

/** Claude usage through the Claude Code login (.credentials.json). */
export class ClaudeProvider {
    constructor(http, options) {
        this._http = http;
        this._options = options; // {getPath, autoRefresh}
        this._refresher = new TokenRefresher({
            parse: parseClaudeCredentials,
            refresh: auth => this._exchange(auth),
            apply: (data, tokens) => {
                data.claudeAiOauth = {
                    ...data.claudeAiOauth,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token ?? data.claudeAiOauth.refreshToken,
                    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    ...(Number.isFinite(tokens.refresh_token_expires_in)
                        ? {refreshTokenExpiresAt: Date.now() + tokens.refresh_token_expires_in * 1000} : {}),
                    ...(typeof tokens.scope === 'string' ? {scopes: tokens.scope.split(' ').filter(Boolean)} : {}),
                };
            },
            readJson,
            writeJson: writeJsonPrivate,
        });
    }

    get name() {
        return 'Claude';
    }

    async fetch() {
        const path = this._options.getPath();
        const autoRefresh = this._options.autoRefresh();

        let auth = await this._refresher.load(path, {autoRefresh});
        let response = await this._request(auth);

        if (response.status === 401 && autoRefresh) {
            auth = await this._refresher.forceRefresh(path);
            response = await this._request(auth);
        }

        ProviderError.throwIfFailed(response, 'Claude', 'claude');
        return normalizeClaude(response.json(), {plan: auth.plan});
    }

    _request(auth) {
        return this._http.request('GET', USAGE_URL, {
            headers: {
                'Authorization': `Bearer ${auth.accessToken}`,
                'anthropic-beta': BETA_HEADER,
                'Accept': 'application/json',
                'User-Agent': USER_AGENT,
            },
        });
    }

    async _exchange(auth) {
        if (!auth.refreshToken)
            throw new AuthError('Claude token expired and no refresh token is stored. Run `claude` to sign in again.');

        let lastStatus = 0;
        for (const url of TOKEN_URLS) {
            const response = await this._http.request('POST', url, {
                headers: {'Accept': 'application/json', 'User-Agent': USER_AGENT},
                json: {
                    grant_type: 'refresh_token',
                    refresh_token: auth.refreshToken,
                    client_id: CLIENT_ID,
                    scope: (auth.scopes?.length ? auth.scopes : DEFAULT_SCOPES).join(' '),
                },
            });
            lastStatus = response.status;
            if (response.status === 404)
                continue;
            if (!response.ok)
                break;

            const tokens = response.json();
            if (typeof tokens.access_token !== 'string')
                throw new AuthError('Claude token refresh returned no access token.');
            return tokens;
        }

        throw new AuthError(`Claude token refresh failed (HTTP ${lastStatus}). Run \`claude\` to sign in again.`);
    }
}
