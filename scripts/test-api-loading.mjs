// Fault injection is local only; real React pages + api.call, mocked Tauri IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "api-loading", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { transport: "local browser fixture; Tauri IPC mocked", passed: [], external: [] };
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  // Use the app's HTTP-based Windows media scheme so Chromium can intercept local image IPC on every host.
  page = await browser.newPage({ viewport: { width: 1100, height: 1200 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" });
  const errors = [];
  const cover = "https://covers.example/art.jpg?auth_key=fixture";
  const coverRequests = [];
  let coverOnline = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    const media = new URL(url);
    if (media.origin === "http://hg.localhost" && media.pathname === "/img" && media.searchParams.get("u") === cover) {
      coverRequests.push(media.searchParams.get("original"));
      const body = coverOnline ? Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64") : Buffer.from("invalid image");
      return route.fulfill({ contentType: "image/webp", body, headers: { "Cache-Control": "no-store" } });
    }
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url); return route.abort();
  });
  const complete = (...args) => page.evaluate(args => window.apiLoadingFixture.complete(...args), args);
  const calls = () => page.evaluate(() => window.apiLoadingFixture.history);
  const visible = async locator => { await locator.waitFor({ state: "visible" }); };

  await page.goto(`${origin}tests/api-loading.html?page=home`);
  await page.waitForFunction(() => window.apiLoadingFixture?.history.length === 1);
  await complete("api_feed", "", "404");
  await visible(page.getByText("首页加载失败", { exact: true }));
  await visible(page.getByText(/服务器请求失败（HTTP 404）/));
  assert.equal(await page.locator(".spinner").count(), 0, "Failed home must stop spinning");
  assert(!await page.locator("body").innerText().then(s => s.includes("<html>")), "Hide gateway HTML from UI");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 2);
  await complete("api_feed", "", "empty");
  await visible(page.getByText("暂无视频", { exact: true }));
  assert.equal(await page.locator(".spinner").count(), 0);
  report.passed.push("Home: 404 ends loading, readable error, explicit retry, empty result");

  await page.goto(`${origin}tests/api-loading.html`);
  await page.waitForFunction(() => window.apiLoadingFixture?.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await calls()).length, 0, "Hidden categories must not prefetch");
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 4);
  await complete("api_category", "ai-duanju", "item", cover);
  await visible(page.getByText("已加载ai-duanju", { exact: true }));
  const image = page.locator('img[src*="covers.example"]');
  await visible(page.locator('[data-ui="image-frame"]').filter({ has: image }).getByRole("img", { name: "封面暂不可用" }));
  assert.deepEqual(coverRequests, [null, "1", "1"]);
  coverOnline = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => document.querySelector('img[src*="covers.example"]')?.naturalWidth === 1);
  assert.equal(await image.evaluate(img => img.naturalHeight), 1);
  assert.deepEqual(coverRequests, [null, "1", "1", null]);
  report.passed.push("Category: a failed cover retries the original, stops loading and displays a decoded WebP after reconnect");
  await visible(page.getByRole("region", { name: "AI成人漫剧", exact: true }).getByText("加载中…", { exact: true }));
  await complete("api_original_videos", "all", "empty");
  await visible(page.getByRole("region", { name: "原创", exact: true }).getByText("暂无内容", { exact: true }));
  await complete("api_post_category", "", "item");
  await visible(page.getByText("已加载api_post_category", { exact: true }));
  await complete("api_category", "ai-manju", "503");
  await page.getByRole("button", { name: "重试AI成人漫剧", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 5);
  await complete("api_category", "ai-manju", "item");
  await visible(page.getByText("已加载ai-manju", { exact: true }));
  assert.equal((await calls()).filter(r => r.args.cate === "ai-duanju").length, 1, "Retry must only reload the failed channel");
  await page.evaluate(() => window.apiLoadingFixture.setActive(false));
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal((await calls()).length, 5, "Revisiting must preserve previews without reloading all channels");
  report.passed.push("Category: defer hidden loading, show successful rows/posts before slow row, independent error/retry, preserve data on revisit");
  assert.deepEqual(errors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  await page.screenshot({ path: join(output, "final.png"), fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
