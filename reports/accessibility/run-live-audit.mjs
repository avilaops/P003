import { chromium } from "../../apps/web/node_modules/@playwright/test/index.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const out = path.resolve("reports/accessibility");
await fs.mkdir(out, { recursive: true });
const axeSource = await fs.readFile(path.resolve("apps/web/node_modules/axe-core/axe.min.js"), "utf8");
const browser = await chromium.launch({ headless: true });
const results = [];

for (const profile of [
  { name: "desktop", viewport: { width: 1440, height: 1000 } },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true },
]) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, locale: "pt-BR" });
  const page = await context.newPage();
  const response = await page.goto("https://erp.avilaops.com", { waitUntil: "networkidle", timeout: 60000 });
  await page.screenshot({ path: path.join(out, `01-login-${profile.name}.png`), fullPage: true });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => await globalThis.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
  }));
  const structure = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    h1: [...document.querySelectorAll("h1")].map(e => e.textContent?.trim()),
    headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(e => ({ tag: e.tagName, text: e.textContent?.trim() })),
    images: [...document.images].map(e => ({ alt: e.getAttribute("alt"), src: e.currentSrc || e.src })),
    linksWithoutNames: [...document.querySelectorAll("a")].filter(e => !e.innerText.trim() && !e.getAttribute("aria-label")).length,
    controlsWithoutNames: [...document.querySelectorAll("button,input,select,textarea")].filter(e => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !(e.labels?.length)).map(e => e.outerHTML),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    dimensions: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
  }));
  const focusOrder = [];
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    focusOrder.push(await page.evaluate(() => {
      const e = document.activeElement;
      if (!e) return null;
      const s = getComputedStyle(e);
      return { tag: e.tagName, text: e.textContent?.trim().slice(0, 80), name: e.getAttribute("aria-label"), href: e.getAttribute("href"), outline: s.outline, boxShadow: s.boxShadow };
    }));
  }
  results.push({ profile: profile.name, status: response?.status(), url: page.url(), axe, structure, focusOrder });
  await context.close();
}

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto("https://erp.avilaops.com/entrar", { waitUntil: "networkidle", timeout: 60000 });
  const authLink = page.locator('a[href^="/api/auth/login"]').first();
  await authLink.click();
  await page.waitForLoadState("networkidle", { timeout: 60000 });
  await page.screenshot({ path: path.join(out, "02-auth-provider-desktop.png"), fullPage: true });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => await globalThis.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
  }));
  const structure = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    h1: [...document.querySelectorAll("h1")].map(e => e.textContent?.trim()),
    labels: [...document.querySelectorAll("label")].map(e => e.textContent?.trim()),
    controls: [...document.querySelectorAll("input,button")].map(e => ({ tag: e.tagName, type: e.getAttribute("type"), name: e.getAttribute("name"), ariaLabel: e.getAttribute("aria-label"), text: e.textContent?.trim() })),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  results.push({ profile: "auth-provider-desktop", status: null, url: page.url(), axe, structure, focusOrder: [] });
  await context.close();
}

await browser.close();
await fs.writeFile(path.join(out, "live-audit.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(r => ({ profile: r.profile, status: r.status, url: r.url, violations: r.axe.violations.length, incomplete: r.axe.incomplete.length, passes: r.axe.passes.length, structure: r.structure })), null, 2));
