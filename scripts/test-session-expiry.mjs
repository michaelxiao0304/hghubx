import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = new URL("../test-results/session-expiry/", import.meta.url);
const report = { checks: [], errors: [] };
let server, browser;
const expired = "登录已失效，请重新登录";
const library = { favs: [2], likes: [2], follows: [], history: [{ id: 2, ep: 4, t: 23.5, dur: 90, at: 200000 }], localHistory: [2], dirtyHistory: {}, postLikes: [], postFavs: [] };
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  await mkdir(out, { recursive: true });
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  async function open({ failure = {}, mobile = false, guest = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 320, height: 694 } : { width: 1100, height: 800 },
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(() => {
      window.savedLibraries = sessionStorage.getItem("auth-seeded") ? Object.fromEntries(["hghubx_app_v1", "hghubx_accounts_v1"].map(k => [k, localStorage.getItem(k)])) : null;
    });
    await context.addInitScript(installFixture, { theme: "light", titles: ["示例一", "示例二", "示例三"] });
    await context.addInitScript(({ failure, library, guest }) => {
      if (window.savedLibraries) {
        for (const [k, v] of Object.entries(window.savedLibraries)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
      } else {
        localStorage.setItem("hghubx_accounts_v1", JSON.stringify({ version: 1, accounts: { [JSON.stringify(["https://fixture.invalid", 7])]: library } }));
        sessionStorage.setItem("auth-seeded", "1");
      }
      const user = id => ({ id, username: `user${id}`, nickname: `账号${id}`, counts: {} });
      const fixture = window.authFixture = { failure, calls: [], holds: {}, waiting: [], user: guest ? null : user(7), origin: "https://fixture.invalid", loginFailure: false };
      fixture.switchTo = (id, origin = "https://fixture.invalid") => { fixture.user = id ? user(id) : null; fixture.origin = origin; window.sessionExpiryStore.setUser(fixture.user, origin); };
      fixture.release = (error = "401") => { for (const pending of fixture.waiting.splice(0)) error ? pending.reject(error) : pending.resolve(pending.result); };
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
        fixture.calls.push(cmd);
        if (cmd === "app_boot") return { user: fixture.user, logged_in: !!fixture.user, base: fixture.origin, strict_security: true };
        if (cmd === "api_login") {
          if (fixture.loginFailure) throw "401";
          fixture.failure = {}; fixture.user = user(7);
          return { user: fixture.user, origin: fixture.origin };
        }
        if (cmd === "api_logout") { fixture.logoutArgs = args; fixture.user = null; return { ok: true }; }
        let result;
        if (cmd === "api_me") result = { user: fixture.user, origin: fixture.origin, interactions: { favorite_video_ids: [fixture.user?.id === 8 ? 3 : 2], like_video_ids: [2] } };
        else if (cmd === "api_account_history") result = { items: [], pagination: { page: args.page, pages: 1, size: 100, total: 0 } };
        else if (["api_collect", "api_like", "api_post_like", "api_post_collect", "api_follow", "api_comment_send", "api_account_history_record", "api_account_history_delete"].includes(cmd)) result = {};
        else if (cmd === "api_following") result = { items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } };
        else return original(cmd, args);
        if (fixture.holds[cmd]) return new Promise((resolve, reject) => fixture.waiting.push({ resolve, reject, result }));
        if (fixture.failure[cmd]) throw fixture.failure[cmd];
        return result;
      };
    }, { failure, library, guest });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    await page.goto(new URL("tests/session-expiry.html", origin).href);
    await page.waitForFunction(() => window.sessionExpiryStore && !window.sessionExpiryStore.accountSync.busy && window.authFixture.calls.includes("app_boot"));
    if (!guest) await page.waitForFunction(() => window.sessionExpiryStore.user?.id === 7);
    return { context, page };
  }
  const state = page => page.evaluate(() => ({ expired: window.sessionExpiryStore.authExpired, user: window.sessionExpiryStore.user?.id,
    favs: window.sessionExpiryStore.favs, history: window.sessionExpiryStore.history, guest: localStorage.getItem("hghubx_app_v1"), accounts: localStorage.getItem("hghubx_accounts_v1") }));
  async function invoke(page, name, args = []) {
    return page.evaluate(async ({ name, args }) => { try { await window.sessionExpiryApi[name](...args); return "ok"; } catch (error) { return error.message; } }, { name, args });
  }

  for (const mobile of [false, true]) {
    const { page, context } = await open({ mobile, failure: { api_me: "401", api_account_history: "401" } });
    await page.getByRole("complementary", { name: "登录状态提示" }).waitFor();
    const before = await state(page);
    assert.equal(before.expired, true); assert.deepEqual(before.favs, library.favs); assert.deepEqual(before.history, library.history);
    assert.equal(await page.getByRole("alert").filter({ hasText: expired }).count(), 1, "Concurrent 401s share one announcement");
    const calls = await page.evaluate(() => window.authFixture.calls.length);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(() => window.authFixture.calls.length), calls, "Expired session stops automatic retries");
    const button = page.getByRole("complementary", { name: "登录状态提示" }).getByRole("button", { name: "重新登录", exact: true });
    await page.screenshot({ path: fileURLToPath(new URL(mobile ? "mobile-expired.png" : "desktop-expired.png", out)) });
    const box = await button.boundingBox(); assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= (mobile ? 320 : 1100), JSON.stringify({ mobile, box }));
    await button.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "重新登录 HGhubX", exact: true });
    await dialog.waitFor();
    assert.equal(await button.isVisible(), false, "Background notice stays hidden while the login dialog is open");
    await page.waitForFunction(() => !!document.activeElement?.closest('[role="dialog"],dialog'));
    await dialog.getByLabel("账号", { exact: true }).fill("fixture");
    await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
    await page.evaluate(() => { window.authFixture.loginFailure = true; });
    await dialog.locator("form").getByRole("button", { name: "登录", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "请检查账号和密码" }).waitFor();
    assert.deepEqual((await state(page)).history, before.history);
    await dialog.getByRole("button", { name: "关闭登录" }).click();
    await page.waitForFunction(() => !window.sessionExpiryStore.loginOpen);
    await page.waitForFunction(() => document.activeElement?.textContent === "重新登录");
    assert.deepEqual((await state(page)).favs, before.favs);
    await page.keyboard.press("Enter"); await dialog.waitFor();
    await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
    await page.evaluate(() => { window.authFixture.loginFailure = false; });
    await dialog.locator("form").getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForFunction(() => !window.sessionExpiryStore.authExpired && !window.sessionExpiryStore.loginOpen && !window.sessionExpiryStore.accountSync.busy);
    const after = await state(page);
    assert.deepEqual(after.favs, before.favs); assert.deepEqual(after.history, before.history); assert.equal(after.guest, before.guest);
    await page.screenshot({ path: fileURLToPath(new URL(mobile ? "mobile-restored.png" : "desktop-restored.png", out)) });
    report.checks.push(`${mobile ? "mobile" : "desktop"}: concurrent expiry, accessible re-login, wrong password and same-account recovery preserve libraries`);
    await context.close();
  }

  for (const mobile of [false, true]) {
    const { page, context } = await open({ mobile, failure: { api_me: "401", api_account_history: "401" } });
    const notice = page.getByRole("complementary", { name: "登录状态提示" });
    await notice.waitFor();
    const before = await state(page);
    const dismiss = notice.getByRole("button", { name: mobile ? "暂不登录" : "关闭登录失效提示", exact: true });
    const box = await dismiss.boundingBox();
    assert(box.height >= 44 && box.width >= 44, "Dismiss control has a touch-sized target");
    if (mobile) await dismiss.tap(); else { await dismiss.focus(); await page.keyboard.press("Enter"); }
    await notice.waitFor({ state: "hidden" });
    const dismissed = await state(page);
    assert.equal(dismissed.expired, true); assert.equal(dismissed.user, before.user);
    assert.deepEqual(dismissed.favs, before.favs); assert.deepEqual(dismissed.history, before.history);
    assert.equal(dismissed.guest, before.guest); assert.equal(dismissed.accounts, before.accounts);
    assert.equal(await page.getByRole("dialog").count(), 0, "Dismissal does not force a login dialog");
    const calls = await page.evaluate(() => window.authFixture.calls.length);
    await page.evaluate(() => {
      const s = window.sessionExpiryStore;
      s.setTab("home"); s.addHistory(2, 4, 41.75, 90);
      window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online"));
    });
    await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(() => window.authFixture.calls.length), calls, "Dismissal leaves automatic sync/upload paused");
    assert.equal((await state(page)).history[0].t, 41.75);
    assert.equal(await invoke(page, "accountHistory", [{ expectedUserId: 7, expectedOrigin: "https://fixture.invalid" }]), expired);
    assert.equal(await notice.isVisible(), false, "Further 401s from the same session do not reopen a dismissed notice");
    await page.evaluate(() => window.sessionExpiryStore.setTab("profile"));
    await page.getByRole("button", { name: "重新登录", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "重新登录 HGhubX", exact: true });
    await dialog.waitFor(); await dialog.getByRole("button", { name: "关闭登录" }).click();
    await page.waitForFunction(() => !window.sessionExpiryStore.loginOpen);
    assert.equal(await notice.isVisible(), false, "Cancelling login keeps the notice dismissed");
    assert.equal((await state(page)).expired, true);
    await page.getByRole("button", { name: "重新登录", exact: true }).click();
    await dialog.getByLabel("账号", { exact: true }).fill("fixture");
    await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
    await dialog.locator("form").getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForFunction(() => !window.sessionExpiryStore.authExpired && !window.sessionExpiryStore.accountSync.busy && !window.sessionExpiryStore.loginOpen);
    assert.deepEqual((await state(page)).favs, before.favs); assert.equal((await state(page)).history[0].t, 41.75);
    await page.evaluate(() => { window.authFixture.failure.api_collect = "401"; });
    assert.equal(await invoke(page, "collect", [2, false]), expired);
    await notice.waitFor();
    report.checks.push(`${mobile ? "mobile" : "desktop"}: dismiss expiry, continue without login, retain records and progress, suppress repeat notices, re-login and show a later expiry`);
    await context.close();
  }

  {
    const { page, context } = await open({ failure: { api_me: "401", api_account_history: "401" } });
    const before = await state(page);
    await page.evaluate(() => window.sessionExpiryStore.logout());
    await page.waitForFunction(() => !window.sessionExpiryStore.user);
    const after = await state(page); const guest = JSON.parse(before.guest);
    assert.equal(after.expired, false); assert.equal(after.accounts, before.accounts);
    assert.deepEqual(after.favs, guest.favs); assert.deepEqual(after.history, guest.history);
    assert.deepEqual(await page.evaluate(() => window.authFixture.logoutArgs), { expectedUserId: 7, expectedOrigin: "https://fixture.invalid" });
    await page.getByRole("button", { name: /未登录/ }).waitFor();
    await page.evaluate(() => window.authFixture.switchTo(7));
    await page.waitForFunction(() => window.sessionExpiryStore.authExpired);
    assert.deepEqual((await state(page)).favs, before.favs); assert.deepEqual((await state(page)).history, before.history);
    report.checks.push("explicit logout after expiry restores guest library and retains the separate account cache with identity guards");
    await context.close();
  }

  for (const [method, command, args] of [
    ["collect", "api_collect", [2, false]], ["like", "api_like", [2, 4, false]],
    ["postLike", "api_post_like", [2, true]], ["postCollect", "api_post_collect", [2, true]],
    ["commentSend", "api_comment_send", [2, 4, "fixture"]], ["following", "api_following", []],
    ["accountHistory", "api_account_history", [{ expectedUserId: 7, expectedOrigin: "https://fixture.invalid" }]],
  ]) {
    const { page, context } = await open(); const before = await state(page);
    await page.evaluate(command => { window.authFixture.failure[command] = "401"; }, command);
    assert.equal(await invoke(page, method, args), expired);
    await page.waitForFunction(() => window.sessionExpiryStore.authExpired);
    const after = await state(page); assert(after.expired); assert.deepEqual(after.favs, before.favs); assert.deepEqual(after.history, before.history); assert.equal(after.guest, before.guest);
    report.checks.push(`${command}: 401 explains re-login without deleting records`); await context.close();
  }

  for (const error of ["HTTP 403 Forbidden", "HTTP 500 Internal Server Error", "请求超时"]) {
    const { page, context } = await open();
    await page.evaluate(error => { window.authFixture.failure.api_collect = error; }, error);
    const result = await invoke(page, "collect", [2, false]); assert(!result.includes(expired)); assert.equal((await state(page)).expired, false);
    report.checks.push(`${error}: does not invalidate login`); await context.close();
  }

  {
    const { page, context } = await open(); const before = await state(page);
    await page.evaluate(() => {
      window.authFixture.holds.api_collect = true;
      window.lateMutation = window.sessionExpiryStore.setCollected("video", 2, false).catch(error => error.message);
    });
    await page.waitForFunction(() => window.authFixture.waiting.length === 1);
    await page.evaluate(() => { window.authFixture.failure.api_like = "401"; });
    assert.equal(await invoke(page, "like", [2, 4, false]), expired);
    await page.waitForFunction(() => window.sessionExpiryStore.authExpired);
    assert.equal(await page.evaluate(async () => { window.authFixture.release(""); return await window.lateMutation; }), expired);
    assert.deepEqual((await state(page)).favs, before.favs, "Late successful write cannot discard cached records after expiry");
    const count = await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_collect").length);
    await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_collect").length), count);
    const clearError = await page.evaluate(async () => { try { await window.sessionExpiryStore.clearHistory(); } catch (error) { return error.message; } });
    assert.equal(clearError, expired); assert.deepEqual((await state(page)).history, before.history);
    report.checks.push("expiry blocks late mutation commits, write replays and remote history clearing without deleting the cache");
    await context.close();
  }

  for (const change of ["account", "origin", "relogin", "logout"]) {
    const { page, context } = await open();
    await page.evaluate(() => {
      window.authFixture.holds.api_collect = true;
      window.lateResult = window.sessionExpiryApi.collect(2, false).catch(error => error.message);
    });
    await page.waitForFunction(() => window.authFixture.waiting.length === 1);
    await page.evaluate(change => {
      const f = window.authFixture;
      if (change === "logout") f.switchTo(null);
      else if (change === "origin") {
        f.origin = "https://second.fixture.invalid";
        window.dispatchEvent(new Event("hg:line-changed"));
      } else f.switchTo(change === "account" ? 8 : 7, f.origin);
    }, change);
    await page.waitForFunction(change => !window.sessionExpiryStore.accountSync.busy
      && (change !== "origin" || window.sessionExpiryStore.accountScope.includes("second.fixture.invalid")), change);
    const before = await state(page);
    if (change === "origin") assert.deepEqual(before.history, library.history, "Trusted native boot retains local seconds");
    assert.equal(await page.evaluate(async () => { window.authFixture.release(); return await window.lateResult; }), "账号或线路已变化，请重试");
    const after = await state(page); assert.equal(after.expired, false); assert.equal(after.user, before.user); assert.deepEqual(after.favs, before.favs); assert.deepEqual(after.history, before.history);
    report.checks.push(`late 401 after ${change} cannot expire the current session`); await context.close();
  }

  {
    const { page, context } = await open({ failure: { api_me: "401", api_account_history: "401", api_account_history_record: "401" } });
    const before = await state(page);
    await page.evaluate(() => window.sessionExpiryStore.addHistory(2, 4, 41.75, 90));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("hghubx_accounts_v1")).accounts[JSON.stringify(["https://fixture.invalid", 7])].history[0].t === 41.75);
    const calls = await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_account_history_record").length);
    await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_account_history_record").length), calls);
    await page.reload(); await page.waitForFunction(() => window.sessionExpiryStore?.authExpired);
    const after = await state(page); assert.equal(after.history[0].t, 41.75); assert.deepEqual(after.favs, before.favs); assert.equal(after.guest, before.guest);
    assert(Object.keys(JSON.parse(after.accounts).accounts[JSON.stringify(["https://fixture.invalid", 7])].dirtyHistory).length > 0);
    const uploadAttempts = await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_account_history_record").length);
    await page.evaluate(() => {
      window.authFixture.origin = "https://second.fixture.invalid";
      window.dispatchEvent(new Event("hg:line-changed"));
    });
    await page.waitForFunction(() => window.sessionExpiryStore.accountScope.includes("second.fixture.invalid"));
    assert.equal((await state(page)).expired, true, "Trusted line rebase is not a successful re-login");
    assert.equal((await state(page)).history[0].t, 41.75);
    assert.equal(await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_account_history_record").length), uploadAttempts);
    const rebased = JSON.parse((await state(page)).accounts);
    const sourceKey = JSON.stringify(["https://fixture.invalid", 7]);
    const targetKey = JSON.stringify(["https://second.fixture.invalid", 7]);
    assert.equal(rebased.aliases[sourceKey], targetKey);
    assert.equal(rebased.accounts[sourceKey].history[0].t, 41.75, "Original bucket remains a snapshot");
    await page.evaluate(async () => {
      const result = await window.sessionExpiryApi.login("fixture", "fixture-password");
      window.sessionExpiryStore.setUser(result.user, result.origin);
    });
    await page.waitForFunction(() => !window.sessionExpiryStore.authExpired && !window.sessionExpiryStore.accountSync.busy
      && Object.keys(JSON.parse(localStorage.getItem("hghubx_accounts_v1")).accounts[JSON.stringify(["https://second.fixture.invalid", 7])].dirtyHistory).length === 0);
    assert.equal((await state(page)).history[0].t, 41.75);
    assert.equal(await page.evaluate(() => window.authFixture.calls.filter(c => c === "api_account_history_record").length), uploadAttempts + 1);
    await page.evaluate(() => window.sessionExpiryStore.clearHistory());
    await page.evaluate(() => {
      window.authFixture.origin = "https://fixture.invalid";
      window.dispatchEvent(new Event("hg:line-changed"));
    });
    await page.waitForFunction(() => window.sessionExpiryStore.accountScope.includes("https://fixture.invalid") && !window.sessionExpiryStore.accountSync.busy);
    assert.deepEqual((await state(page)).history, [], "Switching back never imports a cleared snapshot");
    await page.reload();
    await page.waitForFunction(() => window.sessionExpiryStore?.authExpired);
    assert.deepEqual((await state(page)).history, [], "Aliases survive restart without resurrecting history");
    report.checks.push("expired progress survives restart and trusted rebase; only re-login resumes uploads, cleared history stays cleared on return/restart"); await context.close();
  }

  {
    const { page, context } = await open();
    await page.evaluate(() => { window.authFixture.loginFailure = true; });
    assert.match(await invoke(page, "login", ["fixture", "incorrect"]), /检查账号和密码/);
    assert.equal((await state(page)).expired, false);
    await page.evaluate(() => { window.authFixture.failure.api_collect = "401"; });
    assert.equal(await invoke(page, "collect", [2, true, { expectedUserId: 8, expectedOrigin: "https://second.fixture.invalid" }]), "账号或线路已变化，请重试");
    assert.equal((await state(page)).expired, false);
    await context.close();
    const guest = await open({ guest: true, failure: { api_collect: "401" } });
    const before = await state(guest.page); assert.equal(await invoke(guest.page, "collect", [2, true]), expired);
    assert.equal((await state(guest.page)).expired, false); assert.deepEqual((await state(guest.page)).history, before.history);
    report.checks.push("failed password and guest 401 do not expire an unrelated account"); await guest.context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; process.exitCode = 1; }
finally {
  await mkdir(out, { recursive: true }); await writeFile(new URL("report.json", out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
