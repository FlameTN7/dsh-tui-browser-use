/**
 * dsh-tui-browser-use — default Playwright browser driver.
 *
 * Implements {@link BrowserDriver} over Playwright. Owns the launch probe
 * (system Chrome → explicit binary → bundled Chromium), the per-engine launch
 * args, the navigation primitives (domcontentloaded + best-effort load wait),
 * the frame-aware locator helpers, and the context operations. It is the part
 * of the plugin that would change if the browser backend were swapped.
 *
 * All state that is NOT driver-specific (serial mutex, timeout envelope,
 * dialog/console/network ring buffers, snapshot/tiling/status/saveScreenshots)
 * stays in `BrowserSession`. The B8 "pre-dispatch abort" is honoured here: a
 * navigation/action whose `AbortSignal` is already aborted returns immediately
 * instead of issuing a doomed call.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { effectiveViewport } from '../capabilities.js';
import { raceAbort } from '../browser-utils.js';
/** Chromium-as-root container flags (sandbox/GPU path can stall first start). */
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
/** The default proxy bypass list (localhost/loopback never proxied). */
const DEFAULT_PROXY_BYPASS = 'localhost,127.0.0.1,::1';
/** Whether to inject the container/root chromium flags. */
function chromiumNeedsContainerArgs(noSandbox) {
    if (noSandbox)
        return true;
    try {
        return typeof process.getuid === 'function' && process.getuid() === 0;
    }
    catch {
        return false;
    }
}
/** Launch args appropriate to the engine. */
function engineLaunchArgs(engine, noSandbox) {
    if (engine !== 'chromium')
        return [];
    return chromiumNeedsContainerArgs(noSandbox) ? CONTAINER_LAUNCH_ARGS : [];
}
/** Resolve the HTTP proxy (config `proxy` wins, then env, then direct). */
function resolveProxy(cfgProxy, env) {
    const v = cfgProxy && cfgProxy.length > 0 ? cfgProxy : env.proxyServer;
    if (!v || v.length === 0)
        return undefined;
    return { server: v, bypass: env.proxyBypass ?? DEFAULT_PROXY_BYPASS };
}
/** A candidate browser binary must be a real native executable, not a stub. */
function isRealBrowserBinary(p) {
    try {
        const st = statSync(p);
        if (!st.isFile() || st.size < 1_000_000)
            return false;
        const fd = openSync(p, 'r');
        const buf = Buffer.alloc(8);
        const n = readSync(fd, buf, 0, 8, 0);
        closeSync(fd);
        const magic = buf.subarray(0, n).toString('hex');
        return magic.startsWith('7f454c46') || magic.startsWith('cffaedfe') || magic.startsWith('4d5a');
    }
    catch {
        return false;
    }
}
/**
 * Load a storage-state snapshot as a parsed object. An absent, unreadable or
 * malformed file returns `undefined` so the caller launches a FRESH session
 * instead of failing browser startup (AGENTS.md §5: read failure falls back to
 * a fresh session, never a startup error).
 */
function loadStorageState(path) {
    if (!path || !existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed === 'object' && parsed !== null
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Apply a parsed storage-state snapshot to an already-launched context. Used
 * for `launchPersistentContext`, which does NOT accept Playwright's
 * `storageState` option (it is silently ignored there); `BrowserContext.
 * setStorageState` is the supported way to seed cookies/localStorage in that
 * path. Failures degrade to the fresh session the profile itself provides.
 */
async function applyStorageState(ctx, state) {
    if (!state)
        return;
    try {
        await ctx.setStorageState(state);
    }
    catch { /* fresh session fallback */ }
}
// ── Locator resolution (Playwright-specific, kept private to this backend) ─
// These encapsulate the frame-aware, wait-for-actionable lookup so the driver
// exposes simple `click(selector, text)`/`fill(...)` methods and the raw
// Playwright locator/handle never leaks past the driver boundary.
/** Resolve a locator from a selector/text, honoring `text=`, `role=`, `label=` and CSS. */
function resolveLocator(target, selector, text) {
    if (text !== undefined && text.length > 0) {
        return target.getByText(text);
    }
    if (selector && /^role=/.test(selector)) {
        const m = /^role=([a-z]+)(?:\[name=(.+)\])?/i.exec(selector);
        if (m?.[1])
            return target.getByRole(m[1], m[2] !== undefined ? { name: m[2] } : undefined);
    }
    if (selector && /^label=/.test(selector)) {
        return target.getByLabel(selector.slice('label='.length));
    }
    return target.locator(selector ?? '');
}
/** Resolve an actionable locator across the main frame and child frames (iframe). */
async function resolveFrameAware(page, selector, text) {
    const main = resolveLocator(page, selector, text);
    if (selector === undefined && text === undefined)
        return main;
    try {
        const mainCount = await main.count();
        if (mainCount > 0)
            return main;
    }
    catch { /* fall through to frames */ }
    const frames = page.frames();
    for (const frame of frames) {
        const loc = resolveLocator(frame, selector, text);
        try {
            const n = await loc.count();
            if (n > 0)
                return loc;
        }
        catch { /* try next frame */ }
    }
    return main;
}
/** Wait for a dynamically-rendered target to be actionable (SPA / lazy content). */
async function waitForLocator(locator, timeoutMs = 6000) {
    const perTry = Math.max(800, Math.min(3000, Math.round(timeoutMs / 3)));
    for (let i = 0; i < 3; i += 1) {
        try {
            await locator.first().waitFor({ state: 'visible', timeout: perTry });
            return;
        }
        catch { /* re-query next attempt */ }
    }
    await locator.first().waitFor({ state: 'visible', timeout: perTry });
}
export class PlaywrightDriver {
    _pw = null;
    _engine = null;
    _page = null;
    _ctx = null;
    _startError = null;
    /** In-flight start promise so a concurrent `start()` call reuses the same launch. */
    _startPromise = null;
    get startError() { return this._startError; }
    get running() { return this._engine !== null && this._page !== null; }
    requirePage() {
        if (!this._page)
            throw new Error('browser not started');
        return this._page;
    }
    requireContext() {
        if (!this._ctx)
            throw new Error('browser context not started');
        return this._ctx;
    }
    /**
     * Create a fresh page in the existing context and wire its viewport + dialog/
     * console/network handlers. Used both after a full launch and when a
     * cooperative abort discarded the old page (P1-2). On failure the page is
     * reset to null and `_startError` set; the caller decides whether a failed
     * re-provision into an existing context should also tear the whole browser
     * down (it does, so a corrupt context does not wedge the session forever).
     */
    async provisionPage(opts) {
        const ctx = this._ctx;
        if (!ctx || !this._engine) {
            this._startError = 'browser-context-missing';
            return false;
        }
        try {
            const page = await ctx.newPage();
            this._page = page;
            const dim = effectiveViewport(opts.config);
            await page.setViewportSize({ width: dim.width, height: dim.height });
            if (opts.env.dialog !== 'ignore') {
                page.on('dialog', (d) => {
                    void (opts.env.dialog === 'accept' ? d.accept() : d.dismiss()).catch(() => undefined);
                });
            }
            const handlers = opts.handlers;
            if (handlers) {
                page.on('console', (m) => handlers.onConsole?.(m));
                page.on('request', (r) => handlers.onRequest?.(r));
                page.on('response', (r) => handlers.onResponse?.(r));
                page.on('requestfailed', (r) => handlers.onRequestFailed?.(r));
            }
            this._startError = null;
            return true;
        }
        catch (err) {
            // Do not leave a half-created page referenced. The context/engine stay
            // alive so a reuse attempt can re-provision; the caller may still choose
            // to `close()` after a false return.
            this._page = null;
            this._startError = `browser-launch-failed:${err instanceof Error ? err.message : String(err)}`;
            return false;
        }
    }
    /**
     * Discard the current page and, in the background, close it so any in-flight
     * Playwright op on it is cancelled. This is the P1-2 quarantine: after a
     * cooperative abort the stale op must not keep mutating a page the session
     * has released, so we mark the page null immediately (the next `start()`
     * provisions a fresh page in the same context) and close the old one to
     * cancel the op. `_page` is nulled synchronously so `running` is false before
     * the next tool is dequeued.
     */
    discardPage() {
        const page = this._page;
        if (!page)
            return;
        this._page = null;
        void page.close().catch(() => undefined);
    }
    async loadPlaywright() {
        if (this._pw !== null)
            return this._pw;
        try {
            this._pw = (await import('playwright'));
            return this._pw;
        }
        catch {
            this._pw = null;
            return null;
        }
    }
    /**
     * Windows App Paths registry probe (plan 2.1): `reg query` the per-user and
     * machine-wide App Paths keys for chrome/chromium and take the resolved
     * executable when it is a real PE binary. Only runs on win32; a missing
     * key or a non-native path is silently skipped.
     */
    windowsAppPaths() {
        if (process.platform !== 'win32')
            return undefined;
        const keys = [
            'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chromium.exe',
            'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chromium.exe',
        ];
        for (const key of keys) {
            try {
                const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 2000 });
                const m = /REG_SZ\s+(.+)$/m.exec(out);
                const p = m?.[1]?.trim();
                if (p && existsSync(p) && isRealBrowserBinary(p))
                    return p;
            }
            catch { /* key missing or query failed */ }
        }
        return undefined;
    }
    resolveExecutablePath(env) {
        if (env.executablePath)
            return env.executablePath;
        // Windows: App Paths registry first (most reliable install location).
        const fromAppPaths = this.windowsAppPaths();
        if (fromAppPaths)
            return fromAppPaths;
        const candidates = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
        try {
            for (const entry of readdirSync('/opt')) {
                const nested = join('/opt', entry, 'chrome-linux', 'chrome');
                if (existsSync(nested) && isRealBrowserBinary(nested))
                    return nested;
            }
        }
        catch { /* no /opt */ }
        for (const p of candidates) {
            if (existsSync(p) && isRealBrowserBinary(p))
                return p;
        }
        return undefined;
    }
    async start(opts) {
        if (this._engine !== null && this._page !== null)
            return true;
        if (this._startPromise)
            return this._startPromise;
        const run = (async () => {
            if (this._engine !== null && this._page !== null)
                return true;
            // P1-2 full fix: after a cooperative abort the driver discards the page
            // (to cancel the stale op) but keeps the context/engine so session state
            // (cookies/storage) survives. Re-provision a fresh page instead of
            // launching a SECOND browser process.
            if (this._engine !== null && this._ctx !== null) {
                const ok = await this.provisionPage(opts);
                if (!ok)
                    await this.close();
                return ok;
            }
            const pw = await this.loadPlaywright();
            if (!pw) {
                this._startError = 'browser-core-missing';
                return false;
            }
            try {
                const proxy = resolveProxy(opts.config.proxy, opts.env);
                const engine = opts.env.engine;
                const storageState = loadStorageState(opts.env.storageStatePath);
                const baseOpts = { headless: true, args: engineLaunchArgs(engine, opts.env.noSandbox), ...(proxy ? { proxy } : {}) };
                if (engine !== 'chromium') {
                    const inject = pw[engine];
                    if (!inject) {
                        this._startError = `browser-engine-missing:${engine}`;
                        return false;
                    }
                    // `browserType.launch` rejects `userDataDir`; use `launchPersistentContext`
                    // when the session resolves a managed user-data dir (persistent/isolated).
                    if (opts.env.userDataDir && inject.launchPersistentContext) {
                        this._ctx = await inject.launchPersistentContext(opts.env.userDataDir, baseOpts);
                        this._engine = this._ctx.browser();
                        await applyStorageState(this._ctx, storageState);
                    }
                    else {
                        this._engine = await inject.launch(baseOpts);
                        this._ctx = await this._engine.newContext(storageState ? { storageState } : {});
                    }
                }
                else {
                    // Chromium launch sources in order: channel:'chrome' → explicit binary → bundled.
                    const persistent = opts.env.userDataDir;
                    const sources = [{ channel: 'chrome' }];
                    const exe = this.resolveExecutablePath(opts.env);
                    if (exe)
                        sources.push({ executablePath: exe });
                    sources.push({});
                    let launched = null;
                    let lastErr = null;
                    for (const src of sources) {
                        try {
                            const pass = { ...baseOpts, ...src };
                            launched = persistent
                                ? await pw.chromium.launchPersistentContext(persistent, pass)
                                : await pw.chromium.launch(pass);
                            break;
                        }
                        catch (err) {
                            lastErr = err;
                        }
                    }
                    if (!launched)
                        throw lastErr;
                    if (persistent) {
                        this._ctx = launched;
                        this._engine = this._ctx.browser();
                        await applyStorageState(this._ctx, storageState);
                    }
                    else {
                        this._engine = launched;
                        this._ctx = await this._engine.newContext(storageState ? { storageState } : {});
                    }
                }
                const ok = await this.provisionPage(opts);
                if (!ok)
                    await this.close();
                return ok;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this._startError = `browser-launch-failed:${msg}`;
                // A failure after `launch`/`launchPersistentContext` (e.g. `newPage` or
                // `setViewportSize` threw) must not leak the already-started browser
                // process. `close()` is idempotent and swallows its own errors.
                await this.close();
                return false;
            }
        })();
        this._startPromise = run;
        try {
            return await run;
        }
        finally {
            this._startPromise = null;
        }
    }
    async close() {
        try {
            await this._ctx?.close();
        }
        catch { /* ignore */ }
        try {
            await this._engine?.close();
        }
        catch { /* ignore */ }
        this._engine = null;
        this._page = null;
        this._ctx = null;
    }
    version() {
        try {
            return this._engine?.version() ?? 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    // ── Page primitives ────────────────────────────────────────────────────
    /**
     * Mutation-aware settle (B8): a fast path (double-rAF) resolves immediately
     * on a quiet page; only a page that keeps mutating extends toward a quiet
     * window and then the hard `timeoutMs` cap. This replaces a bare double-rAF
     * for pages that render asynchronously after an action, so a snapshot is not
     * taken mid-update, while never blocking longer than `timeoutMs`.
     */
    async settleStable(timeoutMs) {
        const cap = Math.max(60, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000);
        await this.requirePage().evaluate(`new Promise((resolve) => {
        const deadline = Date.now() + ${cap};
        const quietMs = Math.min(Math.max(Math.floor(${cap} / 5), 50), 250);
        const done = () => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          if (mo) mo.disconnect();
          if (rs) document.removeEventListener('readystatechange', rs);
          resolve();
        };
        let finished = false;
        let timer = null;
        let mo = null;
        let rs = null;
        let mutationAt = Date.now();
        mo = new MutationObserver(() => { mutationAt = Date.now(); });
        mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const check = () => {
          if (finished) return;
          const now = Date.now();
          if (document.readyState === 'complete' && now - mutationAt >= quietMs) return done();
          if (now >= deadline) return done();
          timer = setTimeout(check, Math.min(50, Math.max(16, deadline - now)));
        };
        rs = () => check();
        document.addEventListener('readystatechange', rs);
        // Fast path: a double-rAF flush. A quiet page (no recent mutation) resolves
        // right away; a page still mutating defers to the quiet window / hard cap.
        requestAnimationFrame(() => requestAnimationFrame(() => check()));
        // Hard-cap safety even if rAF never fires (background tab / paused page).
        timer = setTimeout(check, Math.min(60, Math.max(16, deadline - Date.now())));
      })`).catch(() => undefined);
    }
    // ── Navigation ─────────────────────────────────────────────────────────
    async goto(url, opts) {
        const page = this.requirePage();
        const resp = await raceAbort(page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts?.timeout }), opts?.signal, undefined, () => this.discardPage());
        return { status: resp?.status() ?? null, url: resp?.url() ?? url };
    }
    async goBack(opts) {
        const page = this.requirePage();
        const resp = await raceAbort(page.goBack({ waitUntil: 'domcontentloaded', timeout: opts?.timeout }), opts?.signal, undefined, () => this.discardPage());
        return { status: resp?.status() ?? null, url: resp?.url() ?? page.url() };
    }
    async goForward(opts) {
        const page = this.requirePage();
        const resp = await raceAbort(page.goForward({ waitUntil: 'domcontentloaded', timeout: opts?.timeout }), opts?.signal, undefined, () => this.discardPage());
        return { status: resp?.status() ?? null, url: resp?.url() ?? page.url() };
    }
    async reload(opts) {
        const page = this.requirePage();
        const resp = await raceAbort(page.reload({ waitUntil: 'domcontentloaded', timeout: opts?.timeout }), opts?.signal, undefined, () => this.discardPage());
        return { status: resp?.status() ?? null, url: resp?.url() ?? page.url() };
    }
    async title() {
        return this.requirePage().title();
    }
    currentUrl() {
        return this.requirePage().url();
    }
    async waitForLoadState(state) {
        await this.requirePage().waitForLoadState(state).catch(() => undefined);
    }
    // ── Interaction (frame-aware lookup + waitForLocator + act) ────────────
    async click(selector, text, opts) {
        const locator = await resolveFrameAware(this.requirePage(), selector, text);
        await waitForLocator(locator, opts?.timeout);
        await locator.first().click({ timeout: opts?.timeout });
    }
    async fill(selector, text, opts) {
        const locator = await resolveFrameAware(this.requirePage(), selector, undefined);
        await waitForLocator(locator, opts?.timeout);
        const field = locator.first();
        if (opts?.clear)
            await field.clear({ timeout: opts.timeout }).catch(() => undefined);
        await field.fill(text, { timeout: opts?.timeout });
    }
    async hover(selector, text, opts) {
        const locator = await resolveFrameAware(this.requirePage(), selector, text);
        await waitForLocator(locator, opts?.timeout);
        await locator.first().hover({ timeout: opts?.timeout });
    }
    async press(key) {
        await this.requirePage().keyboard.press(key);
    }
    async waitForVisible(selector, text, opts) {
        const locator = await resolveFrameAware(this.requirePage(), selector, text);
        await waitForLocator(locator, opts?.timeout);
    }
    // ── Observation ────────────────────────────────────────────────────────
    async evaluate(expression, signal) {
        const page = this.requirePage();
        return raceAbort(page.evaluate(expression), signal, undefined, () => this.discardPage());
    }
    async screenshot(opts) {
        return this.requirePage().screenshot(opts);
    }
    async pdf(opts) {
        return this.requirePage().pdf(opts);
    }
    // ── Viewport / session state ───────────────────────────────────────────
    async setViewportSize(size) {
        await this.requirePage().setViewportSize(size);
    }
    async storageState() {
        return this.requireContext().storageState();
    }
    // ── Cookies / download ─────────────────────────────────────────────────
    async cookies(urls) {
        return this.requireContext().cookies(urls);
    }
    async addCookies(cookies) {
        await this.requireContext().addCookies(cookies);
    }
    async clearCookies() {
        await this.requireContext().clearCookies();
    }
    async requestGet(url, opts) {
        return raceAbort(this.requireContext().request.get(url, { timeout: opts?.timeout }), opts?.signal);
    }
}
/** Construct the default Playwright-backed browser driver. */
export function createPlaywrightDriver() {
    return new PlaywrightDriver();
}
//# sourceMappingURL=playwright-driver.js.map