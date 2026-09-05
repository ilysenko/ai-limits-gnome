UUID    := ai-limits@igor.lysenko
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC     := $(CURDIR)/extension

.PHONY: schemas install uninstall enable disable pack test logs nested prefs

schemas:
	glib-compile-schemas $(SRC)/schemas

# Symlink the source tree into the user extension directory (for development).
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	rm -rf $(EXT_DIR)
	ln -s $(SRC) $(EXT_DIR)
	@echo "Installed as symlink: $(EXT_DIR)"
	@echo "Log out and back in (Wayland), then: make enable"

uninstall:
	rm -rf $(EXT_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Build the zip that extensions.gnome.org expects.
pack:
	mkdir -p dist
	gnome-extensions pack $(SRC) --force \
		--extra-source=lib \
		--extra-source=LICENSE \
		--out-dir=dist
	@ls -l dist/$(UUID).shell-extension.zip

test:
	gjs -m tests/model.test.js
	gjs -m tests/auth.test.js

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

# Run a nested GNOME Shell for quick manual testing without logging out.
nested:
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --nested --wayland

# Copy the current source into a fresh directory and print a Looking Glass
# command that swaps the running extension for it without logging out.
# (GNOME caches ES modules per path, so a reload needs a new path.)
snapshot: schemas
	@n=$$(date +%s); d=$(CURDIR)/.reload/$$n/$(UUID); mkdir -p $$d; cp -r $(SRC)/. $$d/; \
	echo "Alt+F2 → lg → Evaluator, paste:"; echo; \
	echo "const u='$(UUID)', M=Main.extensionManager; if (M.lookup(u)) await M.unloadExtension(M.lookup(u)); await M.loadExtension(M.createExtensionObject(u, Gio.File.new_for_path('$$d'), 2)); M.lookup(u).state"

# Swap the running extension for the current source without logging out.
# Needs Looking Glass "Unsafe Mode" (Alt+F2 → lg → Flags) for org.gnome.Shell.Eval.
reload: snapshot
	@d=$$(ls -dt $(CURDIR)/.reload/*/$(UUID) | head -1); \
	gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
	  "const u='$(UUID)', M=Main.extensionManager; const old=M.lookup(u); (old ? M.unloadExtension(old) : Promise.resolve()).then(() => { M._unloadedExtensions.delete(u); return M.loadExtension(M.createExtensionObject(u, Gio.File.new_for_path('$$d'), 2)); }).then(() => log('$(UUID) reloaded, state ' + M.lookup(u).state)).catch(e => logError(e, '$(UUID) reload failed')); 'reloading'"; \
	sleep 5; gnome-extensions info $(UUID) | grep -E "State|Error"
