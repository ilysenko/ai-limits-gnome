import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Http} from './lib/http.js';
import {CodexProvider} from './lib/codex.js';
import {ClaudeProvider} from './lib/claude.js';
import {ProviderError} from './lib/provider.js';
import {resolveClaudeCredentialsPath, resolveCodexAuthPath} from './lib/auth.js';
import {colorFor, formatAgo, formatClock, formatPlan, formatReset, pickPanelWindow} from './lib/model.js';

const SERVICES = ['codex', 'claude'];
const COLORS = ['green', 'yellow', 'red'];
const PANEL_PREFIX = 'ai-limits-';     // bright, for the dark top bar
const POPUP_PREFIX = 'ai-limits-pct-'; // darker, readable on a light popup
const BG_PREFIX = 'ai-limits-bg-';
const TRACK_WIDTH = 110; // keep in sync with .ai-limits-track in stylesheet.css
const MIN_MANUAL_GAP_MS = 5000;
const STALE_OPACITY = 150;
const MAX_BACKOFF_SECONDS = 1800;
const WINDOW_TITLES = {session: '5-hour', weekly: 'Weekly'};
const PANEL_MODE_SETTINGS = {codex: 'codex-panel-window', claude: 'claude-panel-window'};
const SHOW_SETTINGS = {codex: 'show-codex', claude: 'show-claude'};

function setColorClass(actor, prefix, color) {
    for (const name of COLORS)
        actor.remove_style_class_name(prefix + name);
    if (color)
        actor.add_style_class_name(prefix + color);
}

/** One "5-hour" / "Weekly" line: name, progress bar, percent, reset time. */
class WindowRow {
    constructor(title) {
        this.actor = new St.BoxLayout({style_class: 'ai-limits-row', x_expand: true});

        this._name = new St.Label({text: title, style_class: 'ai-limits-row-name', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'ai-limits-track', y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'ai-limits-fill'});
        this._track.add_child(this._fill);
        this._pct = new St.Label({style_class: 'ai-limits-row-pct', y_align: Clutter.ActorAlign.CENTER});
        this._reset = new St.Label({style_class: 'ai-limits-row-reset', y_align: Clutter.ActorAlign.CENTER});

        this.actor.add_child(this._name);
        this.actor.add_child(this._track);
        this.actor.add_child(this._pct);
        this.actor.add_child(this._reset);
    }

    /** The popup always reads like the official usage page: bar and number show what is used. */
    update(window, now) {
        if (!window) {
            this.actor.hide();
            return;
        }
        this.actor.show();

        const color = colorFor(window.remainingPct);
        this._fill.style = `width: ${Math.round(TRACK_WIDTH * window.usedPct / 100)}px;`;
        setColorClass(this._fill, BG_PREFIX, color);
        this._pct.text = `${Math.round(window.usedPct)}% used`;
        setColorClass(this._pct, POPUP_PREFIX, color);
        this._reset.text = formatReset(window, now);
    }

    destroy() {
        this.actor.destroy();
        this.actor = null;
        this._name = null;
        this._track = null;
        this._fill = null;
        this._pct = null;
        this._reset = null;
    }
}

/** Popup section for one service. */
class ServiceSection {
    constructor(title) {
        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'ai-limits-service', x_expand: true});

        const header = new St.BoxLayout({style_class: 'ai-limits-service-header', x_expand: true});
        this._plan = new St.Label({style_class: 'ai-limits-service-plan', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(new St.Label({text: title, style_class: 'ai-limits-service-name', y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(this._plan);
        this.actor.add_child(header);

        this._rows = {session: new WindowRow('5-hour'), weekly: new WindowRow('Weekly')};
        this.actor.add_child(this._rows.session.actor);
        this.actor.add_child(this._rows.weekly.actor);

        this._details = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._extraRows = [];
        this.actor.add_child(this._details);

        this._message = new St.Label({style_class: 'ai-limits-error'});
        this._message.clutter_text.line_wrap = true;
        this._message.hide();
        this.actor.add_child(this._message);
    }

    update(entry, now) {
        const {usage, error} = entry;
        this._plan.text = usage ? formatPlan(usage.plan) : '';
        this._rows.session.update(usage?.session ?? null, now);
        this._rows.weekly.update(usage?.weekly ?? null, now);

        this._clearDetails();
        if (usage) {
            for (const kind of ['session', 'weekly']) {
                if (!usage[kind])
                    this._addDetail(`${WINDOW_TITLES[kind]} window: not provided for this plan`, 'ai-limits-note');
            }
            if (usage.extra.length > 0)
                this._details.add_child(new St.Widget({style_class: 'ai-limits-divider', x_expand: true}));
            for (const item of usage.extra)
                this._addExtra(item, now);
            for (const note of usage.notes)
                this._addDetail(note, 'ai-limits-note');
        }

        // Transient errors (rate limit, network) are not worth a red line while
        // the last good numbers are still on screen; the footer says when we retry.
        const needsUser = error && (error.kind === 'auth' || error.kind === 'file');
        if (error && (needsUser || !usage)) {
            this._message.text = error.message;
            this._message.show();
        } else {
            this._message.hide();
        }
    }

    _clearDetails() {
        for (const row of this._extraRows)
            row.destroy();
        this._extraRows = [];
        this._details.destroy_all_children();
    }

    destroy() {
        this._clearDetails();
        this._rows.session.destroy();
        this._rows.weekly.destroy();
        this._rows = null;
        this.actor.destroy();
        this.actor = null;
        this._plan = null;
        this._details = null;
        this._message = null;
    }

    _addDetail(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass});
        label.clutter_text.line_wrap = true;
        this._details.add_child(label);
    }

    /** A model-specific limit: its name, then the same rows as the main windows. */
    _addExtra(item, now) {
        this._details.add_child(new St.Label({text: item.label, style_class: 'ai-limits-extra-name'}));
        for (const kind of ['session', 'weekly']) {
            if (!item[kind])
                continue;
            const row = new WindowRow(WINDOW_TITLES[kind]);
            row.actor.add_style_class_name('ai-limits-row-sub');
            row.update(item[kind], now);
            this._details.add_child(row.actor);
            this._extraRows.push(row);
        }
    }
}

/** Panel button plus popup. Wraps a PanelMenu.Button instead of subclassing it. */
class Indicator {
    constructor(extension, settings) {
        this.button = new PanelMenu.Button(0.0, 'AI Limits');

        this._extension = extension;
        this._settings = settings;
        this._state = null;
        this._tickId = 0;

        this._panelBox = new St.BoxLayout({style_class: 'ai-limits-panel'});
        this._panelValues = {};
        this._panelSlash = new St.Label({text: '/', y_align: Clutter.ActorAlign.CENTER});
        for (const service of SERVICES) {
            this._panelValues[service] = new St.Label({text: '--', style_class: 'ai-limits-panel-value', y_align: Clutter.ActorAlign.CENTER});
            this._panelBox.add_child(this._panelValues[service]);
            if (service === 'codex')
                this._panelBox.add_child(this._panelSlash);
        }
        this.button.add_child(this._panelBox);

        this._buildMenu();

        this._openStateId = this.button.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._extension.refresh({manual: true});
                this._startTick();
            } else {
                this._stopTick();
            }
        });
    }

    _buildMenu() {
        // Reactive so St does not mark it :insensitive (dimmed text), but with no
        // hover highlight and no activation: this is content, not a menu entry.
        const item = new PopupMenu.PopupBaseMenuItem({reactive: true, activate: false, hover: false, can_focus: false});
        item.remove_style_class_name('popup-inactive-menu-item');
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'ai-limits-popup', x_expand: true});

        this._sections = {codex: new ServiceSection('Codex'), claude: new ServiceSection('Claude')};
        for (const service of SERVICES)
            box.add_child(this._sections[service].actor);

        this._footer = new St.Label({style_class: 'ai-limits-footer', text: 'Not updated yet'});
        box.add_child(this._footer);

        const menu = this.button.menu;
        item.add_child(box);
        menu.addMenuItem(item);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._extension.refresh({manual: true, force: true}));
        menu.addMenuItem(refresh);

        const prefs = new PopupMenu.PopupMenuItem('Settings…');
        prefs.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(prefs);
    }

    update(state) {
        this._state = state;
        this._render();
    }

    _render() {
        if (!this._state)
            return;

        const now = Date.now();
        const valueMode = this._settings.get_string('panel-value');
        const colors = this._settings.get_boolean('color-thresholds');

        let visible = 0;
        for (const service of SERVICES) {
            const show = this._settings.get_boolean(SHOW_SETTINGS[service]);
            const label = this._panelValues[service];
            label.visible = show;
            this._sections[service].actor.visible = show;
            if (!show)
                continue;
            visible++;

            const entry = this._state[service];
            const pick = pickPanelWindow(entry.usage, this._settings.get_string(PANEL_MODE_SETTINGS[service]));
            if (pick) {
                // Keep the last known number through transient errors, just dimmed.
                const value = valueMode === 'used' ? pick.window.usedPct : pick.window.remainingPct;
                label.text = `${Math.round(value)}`;
                label.opacity = entry.error ? STALE_OPACITY : 255;
                setColorClass(label, PANEL_PREFIX, colors ? colorFor(pick.window.remainingPct) : null);
            } else {
                // '?' needs the user (sign in, fix the path); '…' will sort itself out (rate limit, network).
                const needsUser = entry.error && (entry.error.kind === 'auth' || entry.error.kind === 'file');
                label.text = entry.error ? (needsUser ? '?' : '…') : '--';
                label.opacity = 255;
                setColorClass(label, PANEL_PREFIX, needsUser && colors ? 'red' : null);
            }
            this._sections[service].update(entry, now);
        }
        this._panelSlash.visible = visible === 2;

        this._footer.text = this._footerText(now);
    }

    _footerText(now) {
        const {updating, backoffUntil, lastSuccess} = this._state;
        const parts = [];
        if (updating)
            parts.push('Updating…');
        else
            parts.push(`Updated ${formatAgo(lastSuccess, now)}`);
        if (backoffUntil > now)
            parts.push(`rate limited, retry at ${formatClock(backoffUntil, now)}`);
        return parts.join(' · ');
    }

    _startTick() {
        this._stopTick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._stopTick();
        if (this._openStateId) {
            this.button.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        for (const service of SERVICES)
            this._sections[service].destroy();
        this._sections = null;
        this._footer.destroy();
        this._footer = null;
        this._panelBox.destroy();
        this._panelBox = null;
        this._panelSlash = null;
        this._panelValues = null;
        this.button.destroy();
        this.button = null;
        this._extension = null;
        this._settings = null;
    }
}

export default class AiLimitsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._http = new Http();
        this._providers = {
            codex: new CodexProvider(this._http, {
                getPath: () => resolveCodexAuthPath(this._settings.get_string('codex-auth-path')),
                autoRefresh: () => this._settings.get_boolean('auto-refresh-tokens'),
            }),
            claude: new ClaudeProvider(this._http, {
                getPath: () => resolveClaudeCredentialsPath(this._settings.get_string('claude-credentials-path')),
                autoRefresh: () => this._settings.get_boolean('auto-refresh-tokens'),
            }),
        };

        this._state = {
            codex: {usage: null, error: null, fetchedAt: 0},
            claude: {usage: null, error: null, fetchedAt: 0},
            updating: false,
            backoffUntil: 0,
            lastSuccess: 0,
        };
        this._failures = 0;
        this._timerId = 0;
        this._inflight = null;

        this._indicator = new Indicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator.button, 0, 'right');
        this._indicator.update(this._state);

        const refetch = () => this.refresh({force: true});
        const rerender = () => this._indicator?.update(this._state);
        this._settingsIds = [
            this._settings.connect('changed::refresh-interval-seconds', () => this._schedule()),
            this._settings.connect('changed::claude-refresh-interval-seconds', refetch),
            this._settings.connect('changed::codex-auth-path', refetch),
            this._settings.connect('changed::claude-credentials-path', refetch),
            this._settings.connect('changed::show-codex', refetch),
            this._settings.connect('changed::show-claude', refetch),
            this._settings.connect('changed::codex-panel-window', rerender),
            this._settings.connect('changed::claude-panel-window', rerender),
            this._settings.connect('changed::panel-value', rerender),
            this._settings.connect('changed::color-thresholds', rerender),
        ];

        this.refresh({force: true});
        this._schedule();
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._http?.dispose();
        this._http = null;
        this._providers = null;
        this._state = null;
        this._settings = null;
    }

    _schedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSeconds(), () => {
            this._timerId = 0;
            this.refresh();
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Configured interval, doubled for every consecutive rate-limit failure. */
    _intervalSeconds() {
        const seconds = this._settings.get_int('refresh-interval-seconds');
        return Math.min(MAX_BACKOFF_SECONDS, seconds * 2 ** this._failures);
    }

    /**
     * Fetch usage for the visible services.
     * manual: triggered by the user (menu opened) — skipped when data is very fresh.
     * force: always fetch, even inside a rate-limit backoff.
     */
    refresh({manual = false, force = false} = {}) {
        if (!this._state || this._inflight)
            return;

        const now = Date.now();
        if (!force && manual && now - this._state.lastSuccess < MIN_MANUAL_GAP_MS)
            return;
        if (!force && this._state.backoffUntil > now)
            return;

        this._inflight = this._fetchAll(force).finally(() => {
            this._inflight = null;
        });
    }

    async _fetchAll(force) {
        this._state.updating = true;
        this._indicator?.update(this._state);

        const started = Date.now();
        const claudeGapMs = this._settings.get_int('claude-refresh-interval-seconds') * 1000;
        const results = await Promise.all(SERVICES.map(async service => {
            if (!this._settings?.get_boolean(SHOW_SETTINGS[service]))
                return null;
            // Claude's usage endpoint rate-limits eager polling: ask it less often than Codex.
            if (service === 'claude' && !force && started - this._state.claude.fetchedAt < claudeGapMs)
                return null;
            try {
                return {service, usage: await this._providers[service].fetch()};
            } catch (error) {
                return {service, error: ProviderError.from(error)};
            }
        }));

        if (!this._state)
            return; // disabled while the requests were in flight

        const now = Date.now();
        let rateLimited = false;
        let anySuccess = false;
        for (const result of results) {
            if (!result)
                continue;
            const entry = this._state[result.service];
            if (result.usage) {
                entry.usage = result.usage;
                entry.error = null;
                entry.fetchedAt = now;
                anySuccess = true;
            } else {
                entry.error = result.error;
                if (result.error.kind === 'ratelimit' || result.error.kind === 'http')
                    rateLimited = true;
                else
                    console.warn(`[AI Limits] ${result.service}: ${result.error.message}`);
            }
        }

        if (anySuccess)
            this._state.lastSuccess = now;

        const previousFailures = this._failures;
        if (rateLimited) {
            this._failures = Math.min(this._failures + 1, 6);
            this._state.backoffUntil = now + this._intervalSeconds() * 1000;
        } else {
            this._failures = 0;
            this._state.backoffUntil = 0;
        }
        if (this._failures !== previousFailures)
            this._schedule();

        this._state.updating = false;
        this._indicator?.update(this._state);
    }
}
