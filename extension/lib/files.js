import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

/** Expand a leading "~" and $VAR / ${VAR} references. */
export function expandPath(value) {
    let path = (value ?? '').trim();
    if (!path)
        return '';

    if (path === '~' || path.startsWith('~/'))
        path = GLib.get_home_dir() + path.slice(1);

    return path.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
        (_match, name) => GLib.getenv(name) ?? '');
}

export function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
}

/** Read a JSON file. Resolves to {data, pretty}; `pretty` tells how to write it back. */
export async function readJson(path) {
    let contents;
    try {
        [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
    } catch (error) {
        throw new Error(`Cannot read ${path}: ${error.message}`);
    }

    const text = new TextDecoder().decode(contents);
    try {
        return {data: JSON.parse(text), pretty: text.includes('\n')};
    } catch (error) {
        throw new Error(`${path} is not valid JSON`);
    }
}

/** Write JSON atomically and make sure only the owner can read it. */
export async function writeJsonPrivate(path, data, pretty) {
    const file = Gio.File.new_for_path(path);
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));

    await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);

    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o600);
    file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
}
