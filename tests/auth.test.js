import GLib from 'gi://GLib';

import {isExpired, jwtExpiryMs, parseClaudeCredentials, parseCodexAuth, resolveCodexAuthPath} from '../extension/lib/auth.js';
import {expandPath} from '../extension/lib/files.js';
import {TokenRefresher} from '../extension/lib/provider.js';

let failures = 0;
function check(condition, message) {
    if (!condition) {
        failures++;
        printerr(`FAIL: ${message}`);
    }
}

function fakeJwt(exp) {
    const encode = obj => GLib.base64_encode(new TextEncoder().encode(JSON.stringify(obj)))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    return `${encode({alg: 'none'})}.${encode({exp})}.sig`;
}

const home = GLib.get_home_dir();
check(expandPath('~/x') === `${home}/x`, 'tilde expansion');
check(expandPath('$HOME/y') === `${home}/y`, 'env expansion');
check(expandPath('  ') === '', 'blank path');
check(resolveCodexAuthPath('').endsWith('/auth.json'), 'default codex path');
check(resolveCodexAuthPath('~/custom.json') === `${home}/custom.json`, 'custom codex path');

const future = Math.floor(Date.now() / 1000) + 3600;
const codex = parseCodexAuth({tokens: {access_token: fakeJwt(future), refresh_token: 'r', account_id: 'acc'}});
check(codex.accountId === 'acc' && codex.expiresAtMs === future * 1000, 'codex auth parsed');
check(!isExpired(codex), 'codex token valid');
check(jwtExpiryMs('garbage') === null, 'bad jwt');

let threw = false;
try {
    parseCodexAuth({tokens: {}});
} catch (e) {
    threw = e.name === 'AuthError';
}
check(threw, 'missing codex token throws AuthError');

const claude = parseClaudeCredentials({claudeAiOauth: {accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1000, subscriptionType: 'max'}});
check(claude.plan === 'max' && isExpired(claude), 'claude expired credentials');

// TokenRefresher: expired token -> refresh -> written back; a second load reuses the file.
async function refresherScenario() {
    let file = {claudeAiOauth: {accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000, scopes: ['x']}};
    let writes = 0;
    let refreshes = 0;
    const refresher = new TokenRefresher({
        parse: parseClaudeCredentials,
        refresh: async auth => {
            refreshes++;
            check(auth.refreshToken === 'r1', 'refresh uses stored refresh token');
            return {access_token: 'new', refresh_token: 'r2', expires_in: 3600};
        },
        apply: (data, tokens) => {
            data.claudeAiOauth = {...data.claudeAiOauth, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000};
        },
        readJson: async () => ({data: JSON.parse(JSON.stringify(file)), pretty: false}),
        writeJson: async (_path, data) => {
            writes++;
            file = data;
        },
    });

    const first = await refresher.load('/fake', {autoRefresh: true});
    check(first.accessToken === 'new' && refreshes === 1 && writes === 1, 'expired token refreshed and written');
    check(file.claudeAiOauth.scopes[0] === 'x' && file.claudeAiOauth.refreshToken === 'r2', 'other fields preserved, refresh token rotated');

    const second = await refresher.load('/fake', {autoRefresh: true});
    check(second.accessToken === 'new' && refreshes === 1, 'valid token not refreshed again');

    file.claudeAiOauth.expiresAt = Date.now() - 1;
    let denied = false;
    try {
        await refresher.load('/fake', {autoRefresh: false});
    } catch (e) {
        denied = e.name === 'AuthError';
    }
    check(denied, 'expired token without auto refresh throws');
}

const loop = new GLib.MainLoop(null, false);
refresherScenario().catch(e => {
    failures++;
    printerr(`FAIL: refresher scenario threw ${e}`);
}).finally(() => loop.quit());
loop.run();

if (failures > 0) {
    printerr(`${failures} check(s) failed`);
    imports.system.exit(1);
}
print('auth.test.js: all checks passed');
