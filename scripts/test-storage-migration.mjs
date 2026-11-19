import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const bootScript = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
  .match(/<script>([\s\S]*?)<\/script>/)[1];
const fixtureHtml = (await readFile(new URL("../tests/storage-migration.html", import.meta.url), "utf8"))
  .replace('<script type="module"', `<script>${bootScript}\nwindow.initialTheme = document.documentElement.classList.contains("theme-light");</script><script type="module"`);
const state = {
  likes: [11], favs: [22], follows: [33],
  history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 123456 }],
  searchHist: ["保留搜索记录"], volume: 0.42, muted: false,
  muteOnStartup: false, swipeEp: false, preferHevc: true,
};
// 迁移会为新字段补默认值（#146-3 全屏闲置隐藏秒数）：旧种子不带该字段，落盘应补齐。
const migrated = { ...state, fsIdleSecs: 3 };
const oldData = {
  hghub_app_v1: JSON.stringify(state), hghub_swipe_ep_v2: "1", hghub_theme: "light",
};
let vite, browser;
const errors = [];
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  const html = await vite.transformIndexHtml("/tests/storage-migration.html", fixtureHtml);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  async function open(seed, failure = "") {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      assert.equal(new URL(route.request().url()).origin, new URL(origin).origin);
      if (new URL(route.request().url()).pathname === "/tests/storage-migration.html") {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.continue();
    });
    await page.addInitScript(({ seed, failure }) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.clear();
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("seeded", "1");
      }
      window.accountMigrationFixture = { offline: false, hold: false, pending: [], calls: [] };
      Object.assign(window, { __TAURI_INTERNALS__: { async invoke(command, args = {}) {
        if (command === "app_boot") return { strict_security: true, ...window.accountMigrationFixture.boot };
        if (command === "debug_log" || command === "playback_log_write") return;
        const account = window.accountMigrationFixture;
        if (command === "api_logout") return { ok: true };
        if (["api_me", "api_account_history"].includes(command)) {
          const id = args.expectedUserId;
          const origin = args.expectedOrigin;
          account.calls.push({ command, id, origin });
          if (account.hold) await new Promise(resolve => account.pending.push(resolve));
          if (account.offline) throw new Error("fixture: account offline");
          const videoId = id * 100;
          if (command === "api_me") return {
            user: { id, username: `fixture-${id}` }, origin,
            interactions: { favorite_video_ids: [videoId], like_video_ids: [], follow_user_ids: [] },
          };
          return { items: [{ id: videoId + 1, target_type: "video", video_id: videoId,
            last_ep: 2, updated_at: "2026-11-01T00:00:00Z" }],
            pagination: { page: args.page, pages: 1, size: 100, total: 1 } };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      } } });
      if (["write", "backup", "commit"].includes(failure)) {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage && (failure === "write"
            || (failure === "backup" && key === "hghubx_library_backup_v2")
            || (failure === "commit" && key === "hghubx_app_v1"))) throw new DOMException("fixture: quota", "QuotaExceededError");
          return Reflect.apply(originalSet, this, [key, value]);
        };
      }
      if (failure === "read") {
        Storage.prototype.getItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
      if (failure === "remove") {
        Storage.prototype.removeItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
    }, { seed, failure });
    await page.goto(`${origin}tests/storage-migration.html`);
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady, null, { timeout: 10000 });
    return { context, page };
  }
  const snapshot = page => page.locator("pre").textContent().then(JSON.parse);
  const storage = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

  {
    const { context, page } = await open(oldData);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    assert.equal(await page.evaluate(() => window.storageMigrationFixture.getThemePreference()), "light");
    assert.equal(await page.evaluate(() => window.initialTheme), true);
    const saved = await storage(page);
    assert.equal(saved.hghub_app_v1, oldData.hghub_app_v1);
    assert.deepEqual(JSON.parse(saved.hghubx_library_backup_v2).originals, { hghub_app_v1: oldData.hghub_app_v1 });
    assert.deepEqual(JSON.parse(saved.hghubx_app_v1), { ...migrated, _libraryMigration: 2 });
    await page.evaluate(() => window.storageMigrationFixture.setTheme("system"));
    await page.waitForFunction(() => localStorage.getItem("hghubx_theme") === "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_theme")), "system");
    await page.evaluate(() => {
      window.storageMigrationFixture.setTheme("dark");
      window.storageMigrationFixture.clearHistory();
    });
    await page.waitForFunction(() => localStorage.getItem("hghubx_theme") === "dark" && JSON.parse(localStorage.getItem("hghubx_app_v1")).history.length === 0);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...migrated, history: [], theme: "dark" });
    await context.close();
    console.log("PASS: legacy data, swipe opt-out, adaptive and explicit appearance survive migration and restart");
  }
  {
    const newer = { ...migrated, favs: [99], history: [] };
    const { context, page } = await open({ ...oldData, hghubx_app_v1: JSON.stringify(newer), hghubx_theme: "dark", hghubx_swipe_ep_v2: "1" });
    assert.deepEqual(await snapshot(page), { ...newer, theme: "dark" });
    assert.equal(await page.evaluate(() => window.initialTheme), false);
    assert.equal((await storage(page)).hghub_app_v1, oldData.hghub_app_v1);
    await context.close();
    console.log("PASS: existing upstream values win over stale pre-fork data; library backup is retained");
  }
  {
    const { context, page } = await open({ hghub_app_v1: JSON.stringify({ ...state, history: [44] }) });
    const value = await snapshot(page);
    assert.equal(value.swipeEp, true);
    assert.equal(value.history[0].id, 44);
    assert.equal(value.history[0].ep, 1);
    assert.equal(value.history[0].t, 0);
    await context.close();
    console.log("PASS: historical history format and the original one-time swipe upgrade still work");
  }
  for (const failure of ["write", "remove"]) {
    const { context, page } = await open(oldData, failure);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    const saved = await storage(page);
    for (const [key, value] of Object.entries(oldData)) assert.equal(saved[key], value);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    await context.close();
    console.log(`PASS: ${failure} failure retains legacy data and preferences across restarts`);
  }
  {
    const fork = { ...state, favs: [22, 55], likes: [66], follows: [77], searchHist: ["fork query"], volume: 0.65,
      history: [{ id: 44, ep: 4, t: 32, dur: 95, at: 223456 }, { id: 88, ep: 2, t: 20, dur: 120, at: 3 }, 99] };
    const upstream = { ...state, favs: [22, 101], history: [...state.history, { id: 88, ep: 3, t: 35, dur: 120, at: 10 }] };
    const forkRaw = JSON.stringify(fork);
    const { context, page } = await open({ hghubx_app_v1: JSON.stringify(upstream), "app_data_v1:default:library": forkRaw, hghubx_swipe_ep_v2: "1" });
    const value = await snapshot(page);
    assert.deepEqual(value.favs, [22, 55, 101]);
    assert.deepEqual(value.likes, [66, 11]);
    assert.deepEqual(value.follows, [77, 33]);
    assert.deepEqual(value.searchHist, ["fork query", ...state.searchHist]);
    assert.equal(value.volume, 0.65);
    assert.deepEqual(value.history, [fork.history[0], upstream.history[1], { id: 99, ep: 1, t: 0, dur: 0, at: 0 }]);
    const saved = await storage(page);
    assert.equal(saved["app_data_v1:default:library"], forkRaw);
    assert.equal(JSON.parse(saved.hghubx_library_backup_v2).originals.hghubx_app_v1, JSON.stringify(upstream));
    await page.evaluate(() => {
      window.storageMigrationFixture.clearHistory();
      window.storageMigrationFixture.toggleFavLocal(22);
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("hghubx_app_v1")).history.length === 0);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual((await snapshot(page)).history, []);
    assert.deepEqual((await snapshot(page)).favs, [55, 101]);
    assert.equal((await storage(page)).hghubx_library_backup_v2, saved.hghubx_library_backup_v2);
    await context.close();
    console.log("PASS: fork and upstream libraries merge, newest episode/progress wins, deletions survive restart");
  }
  for (const failure of ["backup", "commit"]) {
    const fork = { ...state, favs: [55] };
    const original = JSON.stringify(state);
    const { context, page } = await open({ hghubx_app_v1: original, "app_data_v1:default:library": JSON.stringify(fork), hghubx_swipe_ep_v2: "1" }, failure);
    assert.deepEqual((await snapshot(page)).favs, [55, 22]);
    assert.equal((await storage(page)).hghubx_app_v1, original);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual((await snapshot(page)).favs, [55, 22]);
    assert.equal((await storage(page)).hghubx_app_v1, original);
    await context.close();
    console.log(`PASS: ${failure} failure preserves originals and retries safely`);
  }
  {
    const seed = { "app_data_v1:default:library": JSON.stringify(state), hghubx_swipe_ep_v2: "1" };
    const { context, page } = await open(seed);
    const backup = (await storage(page)).hghubx_library_backup_v2;
    // Account-library writes must retain the migration marker and the latest preferences.
    await page.evaluate(() => {
      const s = window.storageMigrationFixture;
      s.setMuted(false); s.setVolume(0.81); s.setPreferHevc(false); s.addSearch("new preference");
    });
    await page.waitForFunction(() => window.storageMigrationFixture.volume === 0.81);
    await page.evaluate(() => {
      const s = window.storageMigrationFixture;
      s.addHistory(44, 4, 37.5, 100);
      s.toggleFavLocal(55);
    });
    await page.waitForFunction(() => window.storageMigrationFixture.favs.includes(55));
    const guest = await snapshot(page);
    assert.deepEqual(guest.favs, [55, 22]);
    assert.equal(guest.history[0].t, 37.5);
    assert.equal(guest.volume, 0.81);
    assert.equal(guest.muted, false);
    assert.equal(guest.preferHevc, false);
    assert.equal(guest.searchHist[0], "new preference");
    assert.equal(JSON.parse((await storage(page)).hghubx_app_v1)._libraryMigration, 2);

    await page.evaluate(() => window.storageMigrationFixture.setUser({ id: 7 }, "https://account-a.invalid"));
    await page.waitForFunction(() => window.storageMigrationFixture.accountSync.favoritesKnown
      && !window.storageMigrationFixture.accountSync.busy);
    assert.deepEqual((await snapshot(page)).favs, [700]);
    assert.equal((await snapshot(page)).history[0].id, 700);
    assert.deepEqual(JSON.parse((await storage(page)).hghubx_app_v1).history, guest.history);

    // A slow response from A must not overwrite B after an account/origin switch.
    await page.evaluate(() => {
      window.accountMigrationFixture.hold = true;
      window.storageMigrationFixture.syncAccount().catch(() => {});
    });
    await page.waitForFunction(() => window.accountMigrationFixture.pending.length === 2);
    await page.evaluate(() => {
      window.accountMigrationFixture.hold = false;
      window.storageMigrationFixture.setUser({ id: 8 }, "https://account-b.invalid");
    });
    await page.waitForFunction(() => window.storageMigrationFixture.accountSync.favoritesKnown
      && !window.storageMigrationFixture.accountSync.busy);
    await page.evaluate(async () => {
      window.accountMigrationFixture.pending.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.deepEqual((await snapshot(page)).favs, [800]);
    assert.equal((await snapshot(page)).history[0].id, 800);
    const cached = JSON.parse((await storage(page)).hghubx_accounts_v1).accounts;
    assert.deepEqual(cached[JSON.stringify(["https://account-a.invalid", 7])].favs, [700]);
    assert.deepEqual(cached[JSON.stringify(["https://account-b.invalid", 8])].favs, [800]);

    await page.evaluate(() => window.storageMigrationFixture.logout());
    assert.deepEqual(await snapshot(page), guest);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), guest);
    assert.equal((await storage(page)).hghubx_library_backup_v2, backup);

    // An offline login keeps the existing account cache; logging out restores the migrated library.
    await page.evaluate(() => {
      window.accountMigrationFixture.offline = true;
      window.storageMigrationFixture.setUser({ id: 7 }, "https://account-a.invalid");
    });
    await page.waitForFunction(() => !!window.storageMigrationFixture.accountSync.error);
    assert.deepEqual((await snapshot(page)).favs, [700]);
    assert.equal((await snapshot(page)).history[0].id, 700);
    // The upstream line contract now retains trusted sessions. A plain same-ID
    // login remains isolated; native boot alone can rebase both cached libraries.
    await page.evaluate(() => window.storageMigrationFixture.setUser({ id: 7 }, "https://account-b.invalid"));
    await page.waitForFunction(() => !!window.storageMigrationFixture.accountSync.error);
    assert.deepEqual((await snapshot(page)).favs, [], "Same ID on another origin does not merge an ordinary login");
    await page.evaluate(() => {
      window.storageMigrationFixture.toggleFavLocal(777);
      window.storageMigrationFixture.toggleFavLocal(700);
      window.storageMigrationFixture.ackFavoriteEpisodes(777, 8);
      window.storageMigrationFixture.ackFavoriteEpisodes(700, 9);
      window.storageMigrationFixture.addHistory(777, 3, 18, 100);
    });
    await page.evaluate(() => window.storageMigrationFixture.setUser({ id: 7 }, "https://account-a.invalid"));
    await page.waitForFunction(() => !!window.storageMigrationFixture.accountSync.error);
    await page.evaluate(() => {
      window.storageMigrationFixture.ackFavoriteEpisodes(700, 6);
      window.storageMigrationFixture.addHistory(700, 4, 42, 100);
    });
    const beforeRebase = (await storage(page)).hghubx_accounts_v1;
    await page.evaluate(() => {
      window.originalAccountSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "hghubx_accounts_v1") throw new DOMException("fixture: quota", "QuotaExceededError");
        return window.originalAccountSetItem.call(this, key, value);
      };
      window.accountMigrationFixture.boot = { user: { id: 7 }, base: "https://account-b.invalid" };
      window.dispatchEvent(new Event("hg:line-changed"));
    });
    await page.waitForFunction(() => window.storageMigrationFixture.accountScope.includes("account-b.invalid") && !window.storageMigrationFixture.accountSync.busy);
    assert.deepEqual((await snapshot(page)).favs, [700, 777]);
    assert.deepEqual(await page.evaluate(() => window.storageMigrationFixture.favEpCounts), {700: 9, 777: 8},
      "Trusted line merge preserves target-only baselines and the highest known count for shared favorites");
    assert.equal((await snapshot(page)).history.find(row => row.id === 700).t, 42);
    assert.equal((await snapshot(page)).history.find(row => row.id === 777).t, 18);
    assert.equal((await storage(page)).hghubx_accounts_v1, beforeRebase, "Failed rebase write keeps the complete original value");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.originalAccountSetItem;
      window.storageMigrationFixture.toggleFavLocal(777);
    });
    const rebased = JSON.parse((await storage(page)).hghubx_accounts_v1);
    const a = JSON.stringify(["https://account-a.invalid", 7]);
    const b = JSON.stringify(["https://account-b.invalid", 7]);
    assert.equal(rebased.aliases[a], b);
    assert.equal(rebased.accounts[a].history.find(row => row.id === 700).t, 42);
    assert.equal(rebased.accounts[b].dirtyHistory[700].ep, 4);
    assert.equal(rebased.accounts[b].dirtyHistory[777].ep, 3);
    assert.deepEqual(rebased.accounts[b].favEpCounts, {700: 9}, "Removing a favorite also removes its episode baseline");
    await page.evaluate(() => {
      window.accountMigrationFixture.boot = { user: { id: 7 }, base: "https://account-a.invalid" };
      window.dispatchEvent(new Event("hg:line-changed"));
    });
    await page.waitForFunction(() => window.storageMigrationFixture.accountScope.includes("account-a.invalid") && !window.storageMigrationFixture.accountSync.busy);
    assert.deepEqual((await snapshot(page)).favs, [700], "Return switch must not resurrect a cancelled favorite");
    await page.evaluate(() => window.storageMigrationFixture.logout());
    assert.deepEqual(await snapshot(page), guest);
    await context.close();
    console.log("PASS: migrated records and preferences survive account sync, late responses, offline cache, logout and restart");
  }
  {
    const { context, page } = await open({ hghubx_app_v1: "broken", "app_data_v1:default:library": JSON.stringify(state), hghubx_swipe_ep_v2: "1" });
    const value = await snapshot(page);
    assert.deepEqual(value.favs, state.favs);
    assert.deepEqual(value.history, state.history);
    assert.equal(JSON.parse((await storage(page)).hghubx_library_backup_v2).originals.hghubx_app_v1, "broken");
    await context.close();
    console.log("PASS: malformed canonical data does not hide a valid fork library");
  }
  for (const seed of [{}, { hghub_app_v1: "invalid json" }]) {
    const { context, page } = await open(seed);
    assert.deepEqual((await snapshot(page)).history, []);
    assert.equal(await page.evaluate(() => window.storageMigrationFixture.getThemePreference()), "system");
    await context.close();
  }
  {
    const { context, page } = await open({}, "read");
    assert.deepEqual((await snapshot(page)).favs, []);
    await context.close();
  }
  {
    const { context, page } = await open({ hghub_swipe_ep_v2: "1" });
    const saved = await storage(page);
    assert.equal(saved.hghubx_swipe_ep_v2, "1");
    assert.equal(saved.hghub_swipe_ep_v2, undefined);
    await context.close();
  }
  assert.deepEqual(errors, []);
  // Optional local, library-only export. Never put real user records in fixtures.
  if (process.env.HGHUBX_MIGRATION_SEED) {
    const seed = JSON.parse(await readFile(process.env.HGHUBX_MIGRATION_SEED, "utf8"));
    const original = JSON.parse(seed.hghubx_app_v1 ?? seed["app_data_v1:default:library"] ?? seed.hghub_app_v1);
    const { context, page } = await open(seed);
    for (let pass = 0; pass < 2; pass++) {
      if (pass) {
        await page.reload();
        await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
      }
      const value = await snapshot(page);
      assert.deepEqual(value.favs, original.favs);
      assert.deepEqual(value.history, original.history);
    }
    await context.close();
    console.log(`PASS: local library snapshot preserves ${original.favs.length} favourites and ${original.history.length} progress records across restart`);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: fresh installs, malformed data and unavailable storage do not crash");
} finally {
  await browser?.close();
  await vite?.close();
}
