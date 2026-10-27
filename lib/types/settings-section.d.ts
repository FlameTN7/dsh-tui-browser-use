/**
 * dsh-tui-browser-use — TUI settings-section registration.
 *
 * Registers a settings section over the plugin's settings namespace
 * (`browser-use`) so the dsh-tui settings screen can render editable fields.
 * Storage and validation remain with the dsh settings service; this registry
 * is display metadata only (mirrors seam #6 `ctx.tuiSettingsSections`).
 *
 * The section is soft-probed (`ctx.get('tuiSettingsSections', false)`): a
 * composition without the seam silently degrades instead of failing the
 * plugin.
 *
 * Field semantics (match the seam's `TuiSettingsField`):
 *  - `label` + `descriptions`: the row label (descriptions are the localized
 *    label; `pick(label, descriptions)` returns `descriptions[lang] ?? label`).
 *  - `hint` + `hintDescriptions`: the one-line help rendered under the focused
 *    field (`pick(hint, hintDescriptions)`). Wiring a long explanation into
 *    `descriptions` is the exact mistake that puts the whole sentence on the
 *    label line — it belongs in `hint`.
 */
/**
 * Register the plugin's settings section on the dsh-tui section registry.
 *
 * The registration is DEFERRED to a microtask so it runs after dsh-tui's own
 * `ns:'dsh-tui'` section is inserted. The screen renders sections in registry
 * insertion order (a Map, one entry per namespace), so registering early — as
 * happened when this plugin's `apply` ran before dsh-tui's — put the
 * `browser-use` section at the TOP of `/settings`. Deferring until the current
 * synchronous boot phase settles appends it LAST, moving it below the host's
 * own (and any other plugin's) section. The namespace registration on the
 * settings *service* (the `[命名空间未注册]` fix) stays synchronous and is
 * untouched.
 *
 * The section registry records the owner from the SERVICE context, not the
 * calling stack, so a deferred `register()` still resolves a valid owner; the
 * channel reads the host list (`host.list()`), which returns every section in
 * insertion order regardless of owner. A missing seam just logs (if debug) and
 * leaves settings to patch config.
 */
export declare function registerSettingsSection(ctx: {
    get(name: string, optional?: boolean): unknown;
}, debug?: (msg: string) => void): (() => void) | undefined;
//# sourceMappingURL=settings-section.d.ts.map