import GLib from 'gi://GLib';

import {
    colorFor,
    formatDuration,
    formatReset,
    normalizeClaude,
    normalizeCodex,
    pickPanelWindow,
} from '../extension/lib/model.js';

let failures = 0;
function check(condition, message) {
    if (!condition) {
        failures++;
        printerr(`FAIL: ${message}`);
    }
}

function loadFixture(name) {
    const path = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', 'fixtures', name]);
    const [, contents] = GLib.file_get_contents(path);
    return JSON.parse(new TextDecoder().decode(contents));
}

// Codex Pro: only a weekly window at the top level, 5h window missing.
const pro = normalizeCodex(loadFixture('codex-usage.json'));
check(pro.plan === 'pro', 'codex pro plan');
check(pro.session === null, 'codex pro has no session window');
check(pro.weekly?.usedPct === 72 && pro.weekly.remainingPct === 28, 'codex pro weekly window from primary slot');
check(pro.weekly.resetsAt === 1788750437000, 'codex reset_at converted to ms');
check(pro.extra.length === 1 && pro.extra[0].label === 'GPT-5.3-Codex-Spark', 'codex additional limit kept');
check(pro.extra[0].session?.remainingPct === 100 && pro.extra[0].weekly?.usedPct === 23, 'codex additional windows classified');
check(pro.notes.includes('3 limit reset credits available'), 'codex reset credits note');

const proSession = pickPanelWindow(pro, 'session');
check(proSession.kind === 'weekly' && proSession.fallback === true, 'session mode falls back to weekly when missing');
check(pickPanelWindow(pro, 'weekly').fallback === false, 'weekly mode direct');
check(pickPanelWindow(pro, 'lowest').kind === 'weekly', 'lowest mode with single window');

// Codex Plus: both windows present.
const plus = normalizeCodex(loadFixture('codex-usage-plus.json'));
check(plus.session?.usedPct === 35 && plus.weekly?.usedPct === 90, 'codex plus both windows');
check(pickPanelWindow(plus, 'session').window.remainingPct === 65, 'session pick');
check(pickPanelWindow(plus, 'lowest').kind === 'weekly', 'lowest picks the tighter window');
check(plus.notes.includes('Credits balance: 12.50'), 'codex credits note');

// Claude
const claude = normalizeClaude(loadFixture('claude-usage.json'), {plan: 'max'});
check(claude.plan === 'max', 'claude plan from credentials');
check(claude.session?.usedPct === 41 && claude.session.remainingPct === 59, 'claude five_hour');
check(claude.session.resetsAt === Date.parse('2026-09-05T18:00:00+00:00'), 'claude resets_at parsed');
check(claude.weekly?.usedPct === 18, 'claude seven_day');
check(claude.extra.length === 2, 'claude extra: opus + scoped limit');
check(claude.extra[0].label === 'Opus' && claude.extra[0].weekly.usedPct === 5, 'claude opus weekly');
check(claude.extra[1].label === 'Opus 5' && claude.extra[1].weekly.usedPct === 12, 'claude scoped limit');

// Empty / broken payloads do not throw.
check(normalizeCodex(null).session === null && normalizeClaude({}).weekly === null, 'empty payloads');
check(pickPanelWindow(normalizeCodex({}), 'session') === null, 'no windows -> null');

// Helpers
check(colorFor(50) === 'green' && colorFor(49.9) === 'yellow' && colorFor(19) === 'red', 'color thresholds');
check(formatDuration(45_000) === '45s', 'duration seconds');
check(formatDuration(8 * 60_000) === '8m', 'duration minutes');
check(formatDuration((2 * 3600 + 15 * 60) * 1000) === '2h 15m', 'duration hours');
check(formatDuration((26 * 3600) * 1000) === '1d 2h', 'duration days');
const now = Date.now();
check(formatReset({resetsAt: now - 1000}, now) === 'reset pending', 'past reset');
check(formatReset({resetsAt: now + 3_600_000}, now).startsWith('resets in 1h 0m ('), 'future reset');
check(formatReset({resetsAt: null}, now) === '', 'no reset');

if (failures > 0) {
    printerr(`${failures} check(s) failed`);
    imports.system.exit(1);
}
print('model.test.js: all checks passed');
