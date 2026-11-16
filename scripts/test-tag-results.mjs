import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = new URL("../test-results/tag-results/", import.meta.url);
const report = { checks: [], errors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(installFixture, { theme: "light", titles: ["本地示例"] });
  await context.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const pending = [];
    const fixture = window.tagResultsFixture = { calls: [], pending,
      complete(command, tag, ids, { page = 1, pages = 1, error = "" } = {}) {
        const matches = pending.filter(p => p.command === command && p.args.tag === tag && p.args.page === page);
        if (!matches.length) throw new Error("Expected a pending tag request");
        for (const request of matches) {
          pending.splice(pending.indexOf(request), 1);
          if (error) request.reject(error);
          else request.resolve({ items: ids.map(id => ({ id, title: `${tag}内容${id}`, cover: "", tags: [tag], score: 0, hot: 0 })),
            pagination: { page, pages, size: 20, total: ids.length } });
        }
      },
    };
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (!["api_tag_videos", "api_post_tag"].includes(command)) return original(command, args);
      fixture.calls.push({ command, args });
      return new Promise((resolve, reject) => pending.push({ command, args, resolve, reject }));
    };
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  const origin = server.resolvedUrls.local[0];
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  const complete = (...args) => page.evaluate(args => window.tagResultsFixture.complete(...args), args);
  await page.goto(new URL("tests/tag-results.html", origin).href);
  await page.waitForFunction(() => window.tagResultsFixture.calls.length === 2);
  const calls = await page.evaluate(() => window.tagResultsFixture.calls);
  assert.deepEqual(calls.map(c => [c.command, c.args.tag]), [["api_tag_videos", "first-tag"], ["api_post_tag", "标签甲"]]);
  await complete("api_tag_videos", "first-tag", []);
  await complete("api_post_tag", "标签甲", [101]);
  await page.getByRole("button", { name: "标签甲内容101", exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "短剧 0 · 吃瓜 1" }).waitFor();
  assert.equal(await page.getByText("暂无内容", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "标签甲内容101", exact: true }).click();
  await page.waitForFunction(() => window.tagResultsStore.stack.at(-1)?.kind === "post" && window.tagResultsStore.stack.at(-1)?.id === 101);
  report.checks.push("post-only tag renders a post card, uses the tag name and opens its post detail");

  await page.evaluate(() => window.selectTag({ slug: "slow-tag", name: "旧标签" }));
  await page.waitForFunction(() => window.tagResultsFixture.calls.length === 4);
  await page.evaluate(() => window.selectTag({ slug: "new-tag", name: "新标签" }));
  await page.waitForFunction(() => window.tagResultsFixture.calls.length === 6);
  await complete("api_tag_videos", "slow-tag", [201]);
  await complete("api_post_tag", "旧标签", [202]);
  await complete("api_tag_videos", "new-tag", [301]);
  await complete("api_post_tag", "新标签", [], { error: "HTTP 404 Not Found" });
  await page.getByText("吃瓜帖子加载失败", { exact: true }).waitFor();
  await page.getByRole("button", { name: "new-tag内容301", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /旧标签内容|slow-tag内容/ }).count(), 0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.tagResultsFixture.calls.length === 7);
  await complete("api_post_tag", "新标签", [302]);
  await page.getByRole("button", { name: "新标签内容302", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.tagResultsFixture.calls.filter(c => c.command === "api_tag_videos" && c.args.tag === "new-tag").length), 1);
  report.checks.push("switching tags ignores stale video/post responses; failed posts retry without reloading successful videos");
  await page.getByRole("button", { name: "屏蔽此标签", exact: true }).click();
  await page.getByRole("button", { name: "新标签内容302", exact: true }).waitFor({ state: "hidden" });
  report.checks.push("post results honor the existing tag filter");
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; process.exitCode = 1; }
finally {
  await mkdir(out, { recursive: true }); await writeFile(new URL("report.json", out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
}
