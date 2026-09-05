import {readJson, writeJsonPrivate} from './files.js';
import {AuthError, parseCodexAuth} from './auth.js';
import {normalizeCodex} from './model.js';
import {ProviderError, TokenRefresher} from './provider.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USER_AGENT = 'ai-limits-gnome/1.0';

/** Codex usage through the Codex CLI login (auth.json). */
export class CodexProvider {
    constructor(http, options) {
        this._http = http;
        this._options = options; // {getPath, autoRefresh}
        this._refresher = new TokenRefresher({
            parse: parseCodexAuth,
            refresh: auth => this._exchange(auth),
            apply: (data, tokens) => {
                data.tokens = {
                    ...data.tokens,
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token ?? data.tokens.refresh_token,
                    id_token: tokens.id_token ?? data.tokens.id_token,
                };
                data.last_refresh = new Date().toISOString();
            },
            readJson,
            writeJson: writeJsonPrivate,
        });
    }

    get name() {
        return 'Codex';
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

        ProviderError.throwIfFailed(response, 'Codex', 'codex login');
        return normalizeCodex(response.json(), {plan: auth.plan});
    }

    _request(auth) {
        const headers = {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Accept': 'application/json',
            'User-Agent': USER_AGENT,
        };
        if (auth.accountId)
            headers['ChatGPT-Account-Id'] = auth.accountId;
        return this._http.request('GET', USAGE_URL, {headers});
    }

    async _exchange(auth) {
        if (!auth.refreshToken)
            throw new AuthError('Codex token expired and no refresh token is stored. Run `codex login`.');

        const response = await this._http.request('POST', TOKEN_URL, {
            headers: {'Accept': 'application/json', 'User-Agent': USER_AGENT},
            json: {client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: auth.refreshToken},
        });
        if (!response.ok)
            throw new AuthError(`Codex token refresh failed (HTTP ${response.status}). Run \`codex login\`.`);

        const tokens = response.json();
        if (typeof tokens.access_token !== 'string')
            throw new AuthError('Codex token refresh returned no access token.');
        return tokens;
    }
}
