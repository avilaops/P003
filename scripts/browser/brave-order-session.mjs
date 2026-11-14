// Control a dedicated visible Brave profile over loopback CDP.
// Never copies cookies or reads password values from another browser profile.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const command = JSON.parse(process.argv[2] || '{"action":"read"}')
const endpoint = 'http://127.0.0.1:9336'
const executable = path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe')
if (command.action === 'start') {
  if (!fs.existsSync(executable)) throw new Error('Brave executable not found')
  const profile = path.join(process.env.LOCALAPPDATA, 'AvilaOps', 'BraveOrderAutomation')
  const child = spawn(executable, [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9336',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    'https://erp.avilaops.com/vendas/pedidos/novo',
  ], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}
let browser
for (let attempt = 0; attempt < 30; attempt++) {
  try { browser = await chromium.connectOverCDP(endpoint); break }
  catch (error) {
    if (command.action !== 'start' || attempt === 29) throw error
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
const context = browser.contexts()[0]
const page = context.pages().find(page => /^https:\/\/(?:erp|auth)\.avilaops\.com\//.test(page.url()))
if (!page) throw new Error('ERP/authentication page not found in dedicated Brave')
page.setDefaultTimeout(15000)
const safeUrl = () => { const url = new URL(page.url()); return url.origin + url.pathname }
let target = command.role
  ? page.getByRole(command.role, { name: command.name, exact: command.exact ?? true })
  : page.getByLabel(command.name || '', { exact: command.exact ?? true })
if (command.index !== undefined) target = target.nth(command.index)
try {
  if (command.action === 'minimize') {
    const session = await context.newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget')
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    console.log(JSON.stringify({ done: 'minimize' }))
  } else if (command.action === 'inspect') {
    console.log(JSON.stringify({ url: safeUrl(), links: await page.getByRole('link').evaluateAll(items => items.map(item => ({ text: item.innerText, href: item.getAttribute('href')?.split('?')[0] }))) }))
  } else if (command.action === 'read' || command.action === 'start') {
    const session = await context.newCDPSession(page)
    const { bounds } = await session.send('Browser.getWindowForTarget')
    console.log(JSON.stringify({ browser: 'Brave', url: safeUrl(), windowState: bounds.windowState, title: await page.title(), text: (await page.locator('body').innerText()).slice(0, command.limit || 16000) }))
  } else if (command.action === 'screenshot') {
    if (new URL(page.url()).hostname !== 'erp.avilaops.com' || !new URL(page.url()).pathname.startsWith('/vendas/pedidos')) throw new Error('Screenshots are restricted to the order page')
    const file = path.join(process.env.TEMP, 'avila-brave-order.png')
    await page.screenshot({ path: file, fullPage: true })
    console.log(JSON.stringify({ screenshot: file }))
  } else {
    if (new URL(page.url()).hostname !== 'erp.avilaops.com') throw new Error('Sign in manually before editing the order')
    if (command.action === 'fill') await target.fill(command.value)
    else if (command.action === 'click') await target.click()
    else if (command.action === 'select') await target.selectOption(command.label ? { label: command.label } : command.value)
    else if (command.action === 'press') await target.press(command.key)
    else throw new Error('Unsupported command')
    console.log(JSON.stringify({ done: command.action, target: command.name, url: safeUrl() }))
  }
  // Disconnect this short-lived controller without closing the user's window.
  process.exit(0)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
