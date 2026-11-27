import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Only the argument choice is under test; the provider runtime is not installed here.
const stubs = {
  '@deepseek-ai/dsh-browser-use/brand': 'export const BrowserUseProviderName = name => name',
  '@deepseek-ai/dsh-experimental-browser-use-runtime': 'export class SessionResources {}',
  '@deepseek-ai/dsh-mcp-client': 'export const Config = value => value',
  '@deepseek-ai/dsh-scope': 'export const createScope = () => {}',
}
registerHooks({ resolve(specifier, context, next) {
  return stubs[specifier] ? { url: `data:text/javascript,${stubs[specifier]}`, shortCircuit: true } : next(specifier, context)
} })
const { SIDEBAR_BROWSER_ENV, serverLaunch, takeSidebarEndpoint } = await import('../lib/sidebar.js')
const { connectSidebarBrowser, workspaceStorage } = await import('../lib/sidebar-client.js')

const endpoint = 'ws://127.0.0.1:4100/0123456789abcdef0123456789abcdef0123456789abcdef'
const agent = (origin) => ({ session: { id: 'session-0001', header: origin === undefined ? {} : { origin } } })
const browser = { mode: 'launch', headless: true, executablePath: '/synthetic/Electron', toolCallTimeoutMs: 120000 }

test('the desktop endpoint is taken once and leaves the environment', () => {
  const environment = { [SIDEBAR_BROWSER_ENV]: endpoint, PATH: '/bin' }
  assert.equal(takeSidebarEndpoint(environment), endpoint)
  assert.deepEqual(environment, { PATH: '/bin' })
  assert.equal(takeSidebarEndpoint(environment), undefined)
})

test('a conversation\'s own Agent attaches to its Sidebar without exposing the endpoint in arguments', () => {
  const { args, env } = serverLaunch(browser, agent(), endpoint, 'cli.js', { PLAYWRIGHT_MCP_HEADLESS: '1', PATH: '/bin' })
  assert.deepEqual(args, ['cli.js', '--browser', 'chromium', '--snapshot-mode', 'none', '--timeout-settle', '0'])
  assert.deepEqual(env, { PLAYWRIGHT_MCP_HEADLESS: '', PLAYWRIGHT_MCP_CDP_ENDPOINT: `${endpoint}/session-0001` })
})

test('subagents, and every Agent without the desktop app, keep the isolated launched browser', () => {
  const { args, env } = serverLaunch(browser, agent('subagent'), endpoint, 'cli.js', { playwright_mcp_cdp_endpoint: 'ws://elsewhere' })
  const isolated = ['cli.js', '--browser', 'chromium', '--snapshot-mode', 'none', '--timeout-settle', '0', '--isolated', '--headless', '--executable-path', '/synthetic/Electron']
  assert.deepEqual(args, isolated)
  assert.deepEqual(env, { playwright_mcp_cdp_endpoint: '' })
  assert.deepEqual(serverLaunch({ ...browser, headless: false, executablePath: undefined }, agent('subagent'), endpoint, 'cli.js', {}).args,
    ['cli.js', '--browser', 'chromium', '--snapshot-mode', 'none', '--timeout-settle', '0', '--isolated'])
  // Web and CLI have no Sidebar endpoint.
  assert.deepEqual(serverLaunch(browser, agent(), undefined, 'cli.js', {}), { args: isolated, env: {} })
})

test('a visible page is acknowledged after the Sidebar has laid it out', () => {
  const previousObserver = globalThis.MutationObserver, previousResizeObserver = globalThis.ResizeObserver
  const previousFrame = globalThis.requestAnimationFrame, previousCSS = globalThis.CSS
  const frames = [], acknowledgements = []
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  globalThis.CSS = { escape: value => value }
  let onRequest
  const element = () => ({ append() {}, addEventListener() {}, remove() {}, setAttribute() {} })
  const activeElement = { isConnected: true }
  const region = { contains: value => value === activeElement }
  const frame = { parentElement: { append() {} }, blur() {} }
  const document = {
    activeElement,
    body: {},
    head: { append() {} },
    createElement: element,
    querySelector: selector => selector.includes('webview') ? frame : region,
    querySelectorAll: () => [],
  }
  const sidebar = {
    mounted: { getSnapshot: () => 'session-0001', subscribe: () => () => {} },
    isExpanded: () => true,
    active: () => ({ id: 'tab-0001' }),
    focus() {},
  }
  const desktopWidth = { getSnapshot: () => false, subscribe: () => () => {} }
  const conversation = () => ({
    session: { getSnapshot: () => ({ running: true }), subscribe: () => () => {} },
    eventSource: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
  })
  const dispose = connectSidebarBrowser({
    bridge: { onRequest(listener) { onRequest = listener; return () => {} }, shown(request) { acknowledgements.push(request) } },
    desktop: {}, sidebar, document, storage: async () => '', conversation, text: key => key, desktopWidth,
  })
  try {
    onRequest({ type: 'show', sessionId: 'session-0001', tabId: 'tab-0001', requestId: 'request-0001' })
    assert.deepEqual(acknowledgements, [])
    frames.shift()()
    assert.deepEqual(acknowledgements, [])
    frames.shift()()
    assert.deepEqual(acknowledgements, ['request-0001'])
  } finally {
    dispose()
    globalThis.MutationObserver = previousObserver
    globalThis.ResizeObserver = previousResizeObserver
    globalThis.requestAnimationFrame = previousFrame
    globalThis.CSS = previousCSS
  }
})

test('a background page uses its conversation\'s Sidebar storage once the workspace list arrives', { timeout: 5000 }, async () => {
  const listeners = new Set()
  let snapshot = { phase: 'pending', items: [] }
  const list = { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  const arrive = () => { snapshot = { phase: 'ready', items: [{ path: '/synthetic/project', sessionIds: ['session-0001'] }] }; for (const listener of [...listeners]) listener() }
  const pending = workspaceStorage(list, 'session-0001', new AbortController().signal)
  arrive()
  assert.equal(await pending, 'cwd:/synthetic/project')
  assert.equal(await workspaceStorage(list, 'session-0002', new AbortController().signal), 'session:session-0002')
  assert.equal(listeners.size, 0)
  // An Agent that leaves stops the wait.
  snapshot = { phase: 'pending', items: [] }
  const lifetime = new AbortController()
  const abandoned = workspaceStorage(list, 'session-0001', lifetime.signal)
  lifetime.abort()
  await assert.rejects(abandoned)
  assert.equal(listeners.size, 0)
})
