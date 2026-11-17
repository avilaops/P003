import { chromium } from "../../apps/web/node_modules/@playwright/test/index.mjs";
import path from "node:path";

const profile = path.resolve("reports/accessibility/browser-profile");
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
const pages = context.pages();
const page = pages[0] || await context.newPage();
await page.goto("https://erp.avilaops.com", { waitUntil: "commit", timeout: 60000 }).catch(() => {});
console.log("AUDIT_BROWSER_READY");
await new Promise(resolve => context.on("close", resolve));
