import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fileExists, readJson} from './lib/files.js';
import {
    isExpired,
    parseClaudeCredentials,
    parseCodexAuth,
    resolveClaudeCredentialsPath,
    resolveCodexAuthPath,
} from './lib/auth.js';
import {formatClock, formatPlan} from './lib/model.js';

const WINDOW_CHOICES = [
    ['session', '5-hour window'],
    ['weekly', 'Weekly window'],
    ['lowest', 'Whichever has less left'],
];
const VALUE_CHOICES = [
    ['remaining', 'Percent left'],
    ['used', 'Percent used'],
];

function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });

    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = index < 0 ? 0 : index;
    };
    sync();

    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Text entry for a login file with a file chooser and a live status line. */
function pathRow(settings, key, title, resolvePath, parse) {
    const entry = new Adw.EntryRow({title});
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);

    const browse = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Choose file',
    });
    browse.add_css_class('flat');
    browse.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title});
        dialog.open(entry.get_root(), null, (source, result) => {
            try {
                const file = source.open_finish(result);
                if (file)
                    entry.text = file.get_path();
            } catch (error) {
                // dismissed
            }
        });
    });
    entry.add_suffix(browse);

    const status = new Adw.ActionRow();
    status.add_css_class('property');

    let generation = 0;
    const update = async () => {
        const current = ++generation;
        const path = resolvePath(entry.text);
        status.title = path;
        if (!fileExists(path)) {
            status.subtitle = 'File not found';
            return;
        }
        try {
            const {data} = await readJson(path);
            const auth = parse(data);
            const plan = auth.plan ? `${formatPlan(auth.plan)} plan · ` : '';
            let expiry = 'no expiry information';
            if (auth.expiresAtMs !== null) {
                expiry = isExpired(auth, 0)
                    ? `token expired ${formatClock(auth.expiresAtMs)} (will be refreshed automatically)`
                    : `token valid until ${formatClock(auth.expiresAtMs)}`;
            }
            if (current === generation)
                status.subtitle = `${plan}${expiry}`;
        } catch (error) {
            if (current === generation)
                status.subtitle = error.message;
        }
    };
    entry.connect('changed', () => update());
    update();

    return [entry, status];
}

export default class AiLimitsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'AI Limits', icon_name: 'preferences-system-symbolic'});

        const panel = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'The panel shows "Codex / Claude" as percentages of the chosen window.',
        });
        panel.add(comboRow(settings, 'codex-panel-window', 'Codex number', 'Which Codex limit the panel number reflects', WINDOW_CHOICES));
        panel.add(comboRow(settings, 'claude-panel-window', 'Claude number', 'Which Claude limit the panel number reflects', WINDOW_CHOICES));
        panel.add(comboRow(settings, 'panel-value', 'Panel value', 'The popup always shows percent used', VALUE_CHOICES));
        panel.add(switchRow(settings, 'color-thresholds', 'Color the numbers', 'Green above 50% left, yellow from 20%, red below'));
        panel.add(switchRow(settings, 'show-codex', 'Show Codex', null));
        panel.add(switchRow(settings, 'show-claude', 'Show Claude', null));
        page.add(panel);

        const refresh = new Adw.PreferencesGroup({title: 'Refresh'});
        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between automatic updates. Opening the popup always fetches fresh data.',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        settings.bind('refresh-interval-seconds', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        refresh.add(interval);
        const claudeInterval = new Adw.SpinRow({
            title: 'Claude refresh interval',
            subtitle: 'Claude rate-limits frequent polling, so it is asked at most this often. "Refresh now" always asks immediately.',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        settings.bind('claude-refresh-interval-seconds', claudeInterval, 'value', Gio.SettingsBindFlags.DEFAULT);
        refresh.add(claudeInterval);
        refresh.add(switchRow(settings, 'auto-refresh-tokens', 'Refresh expired tokens',
            'Exchange the stored refresh token for a new access token and write it back to the login file, like the CLIs do'));
        page.add(refresh);

        const files = new Adw.PreferencesGroup({
            title: 'Login files',
            description: 'Leave a field empty to use the default location.',
        });
        for (const row of pathRow(settings, 'codex-auth-path', 'Codex auth.json', resolveCodexAuthPath, parseCodexAuth))
            files.add(row);
        for (const row of pathRow(settings, 'claude-credentials-path', 'Claude .credentials.json', resolveClaudeCredentialsPath, parseClaudeCredentials))
            files.add(row);
        page.add(files);

        window.add(page);
    }
}
