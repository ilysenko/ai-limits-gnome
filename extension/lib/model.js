import GLib from 'gi://GLib';

const SESSION_MAX_SECONDS = 24 * 3600;
const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 24 * 3600;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function clampPercent(value) {
    const n = asNumber(value) ?? 0;
    return Math.min(100, Math.max(0, n));
}

/** A usage window: how much is used, how much is left, when it resets. */
function makeWindow(usedPercent, resetsAtMs, windowSeconds) {
    const usedPct = clampPercent(usedPercent);
    return {
        usedPct,
        remainingPct: 100 - usedPct,
        resetsAt: asNumber(resetsAtMs),
        windowSeconds: asNumber(windowSeconds),
    };
}

/* ---------- Codex (chatgpt.com/backend-api/wham/usage) ---------- */

function codexWindow(raw) {
    if (!isObject(raw))
        return null;

    let resetsAt = null;
    if (asNumber(raw.reset_at) !== null)
        resetsAt = raw.reset_at * 1000;
    else if (asNumber(raw.reset_after_seconds) !== null)
        resetsAt = Date.now() + raw.reset_after_seconds * 1000;

    return makeWindow(raw.used_percent, resetsAt, raw.limit_window_seconds);
}

/**
 * Sort the primary/secondary windows into session (≤ 24 h) and weekly by their
 * length. On some plans the primary window is already the weekly one and there
 * is no session window at all, so slot position cannot be trusted.
 */
function classifyCodexWindows(rateLimit) {
    const out = {session: null, weekly: null};
    const slots = [['primary_window', 'session'], ['secondary_window', 'weekly']];

    for (const [slot, fallback] of slots) {
        const window = codexWindow(rateLimit?.[slot]);
        if (!window)
            continue;

        let kind = fallback;
        if (window.windowSeconds)
            kind = window.windowSeconds <= SESSION_MAX_SECONDS ? 'session' : 'weekly';

        if (!out[kind])
            out[kind] = window;
    }

    return out;
}

export function normalizeCodex(raw, {plan = null} = {}) {
    const rateLimit = isObject(raw?.rate_limit) ? raw.rate_limit : null;
    const {session, weekly} = classifyCodexWindows(rateLimit);

    const extra = [];
    const additional = Array.isArray(raw?.additional_rate_limits) ? raw.additional_rate_limits : [];
    for (const entry of additional) {
        if (!isObject(entry))
            continue;
        const windows = classifyCodexWindows(entry.rate_limit);
        if (windows.session || windows.weekly)
            extra.push({label: entry.limit_name || 'Additional limit', ...windows});
    }

    const notes = [];
    if (rateLimit?.limit_reached)
        notes.push('Limit reached');

    const credits = raw?.credits;
    if (credits?.unlimited)
        notes.push('Credits: unlimited');
    else if (credits?.has_credits && credits.balance !== undefined)
        notes.push(`Credits balance: ${credits.balance}`);

    const resets = asNumber(raw?.rate_limit_reset_credits?.available_count);
    if (resets)
        notes.push(`${resets} limit reset credit${resets === 1 ? '' : 's'} available`);

    return {
        service: 'codex',
        plan: typeof raw?.plan_type === 'string' ? raw.plan_type : plan,
        session,
        weekly,
        extra,
        notes,
    };
}

/* ---------- Claude (api.anthropic.com/api/oauth/usage) ---------- */

function claudeWindow(raw, windowSeconds) {
    if (!isObject(raw))
        return null;

    const resetsAt = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : null;
    return makeWindow(raw.utilization, Number.isNaN(resetsAt) ? null : resetsAt, windowSeconds);
}

export function normalizeClaude(raw, {plan = null} = {}) {
    const extra = [];

    const modelWeekly = [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']];
    for (const [key, label] of modelWeekly) {
        const weekly = claudeWindow(raw?.[key], ONE_WEEK);
        if (weekly)
            extra.push({label, session: null, weekly});
    }

    const limits = Array.isArray(raw?.limits) ? raw.limits : [];
    for (const entry of limits) {
        if (!isObject(entry))
            continue;
        const label = entry.scope?.model?.display_name;
        if (typeof label !== 'string')
            continue;
        const isSession = entry.group === 'session';
        const window = makeWindow(entry.percent,
            typeof entry.resets_at === 'string' ? Date.parse(entry.resets_at) : null,
            isSession ? FIVE_HOURS : ONE_WEEK);
        extra.push({
            label,
            session: isSession ? window : null,
            weekly: isSession ? null : window,
        });
    }

    return {
        service: 'claude',
        plan,
        session: claudeWindow(raw?.five_hour, FIVE_HOURS),
        weekly: claudeWindow(raw?.seven_day, ONE_WEEK),
        extra,
        notes: [],
    };
}

/* ---------- Presentation helpers ---------- */

/**
 * Pick the window the panel number is based on.
 * Returns {window, kind, fallback} or null when the service has no windows.
 */
export function pickPanelWindow(usage, mode) {
    if (!usage)
        return null;

    const {session, weekly} = usage;
    if (mode === 'lowest') {
        const candidates = [['session', session], ['weekly', weekly]].filter(([, w]) => w);
        if (candidates.length === 0)
            return null;
        candidates.sort((a, b) => a[1].remainingPct - b[1].remainingPct);
        return {window: candidates[0][1], kind: candidates[0][0], fallback: false};
    }

    const wanted = mode === 'weekly' ? 'weekly' : 'session';
    const other = wanted === 'weekly' ? 'session' : 'weekly';
    if (usage[wanted])
        return {window: usage[wanted], kind: wanted, fallback: false};
    if (usage[other])
        return {window: usage[other], kind: other, fallback: true};
    return null;
}

export function colorFor(remainingPct) {
    if (remainingPct < 20)
        return 'red';
    if (remainingPct < 50)
        return 'yellow';
    return 'green';
}

export function formatPlan(plan) {
    if (!plan)
        return '';
    return plan.charAt(0).toUpperCase() + plan.slice(1).replaceAll('_', ' ');
}

/** "2h 15m", "1d 3h", "45s" — always positive, for both future and past. */
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(Math.abs(ms) / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m`;
    return `${seconds}s`;
}

/** Local clock time; adds the weekday when the moment is more than a day away. */
export function formatClock(ms, now = Date.now()) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.round(ms / 1000));
    const pattern = Math.abs(ms - now) >= 86400 * 1000 ? '%a %H:%M' : '%H:%M';
    return dateTime.format(pattern);
}

export function formatReset(window, now = Date.now()) {
    if (!window || window.resetsAt === null)
        return '';
    const delta = window.resetsAt - now;
    if (delta <= 0)
        return 'reset pending';
    return `resets in ${formatDuration(delta)} (${formatClock(window.resetsAt, now)})`;
}

export function formatAgo(ms, now = Date.now()) {
    if (!ms)
        return 'never';
    const delta = now - ms;
    return delta < 10_000 ? 'just now' : `${formatDuration(delta)} ago`;
}
