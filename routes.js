// workspace-integrity 面板背后的同源 JSON 路由。
//
// Client 半侧无法 import Host 代码，而 `ctx.remote` 的命名空间在应用组装时固定，
// 所以插件自己的浏览器半侧经应用自带的 HTTP 载体访问 Host 半侧。
// 每条路由都声明 `auth: 'required'`：准入（Host/Origin 检查 + 登录 Cookie）由
// `webServer` 在 HTTP 层执行，插件不再复制一份，因此只有已登录页面能驱动标签修复。

const PREFIX = '/workspace-integrity/api'
const MAX_BODY_BYTES = 64 * 1024

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    try { response.end() } catch { /* 已经结束 */ }
    return
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'The request body exceeds 64 KiB.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw httpError(400, `The request body is not valid JSON: ${String(error && error.message || error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'The request body must be a JSON object.')
  }
  return parsed
}

/**
 * 在 Host 的 HTTP 载体上注册面板 JSON 路由。
 * @param webServer - `webServer` 服务；准入由它的 `auth` 策略负责。
 * @param service - agent 工具同样调用的那套 operations。
 * @returns 撤销全部路由的 disposer。
 */
export function registerRoutes(webServer, service) {
  if (!webServer || typeof webServer.register !== 'function') throw new Error('The webServer service is unavailable.')
  const disposers = []

  function route(path, methods, handle) {
    const handler = async function (request, response) {
      const method = String(request.method || 'GET').toUpperCase()
      if (methods.indexOf(method) < 0) {
        sendJson(response, 405, { ok: false, error: `Unsupported request method: ${method}` })
        return
      }
      try {
        const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(request)
        const url = new URL('http://local' + (request.url || '/'))
        const data = await handle({ method, body, url })
        sendJson(response, 200, { ok: true, data })
      } catch (error) {
        // 400/413 是调用方的输入问题；其余都算本 Host 自身失败。
        const status = typeof error?.status === 'number' ? error.status : 500
        sendJson(response, status, { ok: false, error: String((error && error.message) || error) })
      }
    }
    disposers.push(webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler,
      // 面板能改 ACL，绝不允许匿名访问：认证与 Host/Origin 检查交由载体执行。
      auth: 'required',
    }))
  }

  try {
    route('/state', ['GET'], (context) => service.state(context))
    route('/scan', ['POST'], ({ body }) => service.scan(body))
    route('/fix', ['POST'], ({ body }) => service.fix(body))
    route('/verify', ['POST'], ({ body }) => service.verify(body))
    route('/records', ['GET'], () => service.records())
    route('/rollback', ['POST'], ({ body }) => service.rollback(body))
  } catch (error) {
    // 部分注册失败不能泄漏已经注册上的路由。
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* 撤销不能抛错 */ }
    }
    throw error
  }

  return function disposeRoutes() {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* 撤销不能抛错 */ }
    }
  }
}
