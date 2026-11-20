// Same-origin JSON routes behind the workspace-integrity panel.
//
// The Client half cannot import Host code, and `ctx.remote` namespaces are
// fixed at build time by the application assembly, so a plugin's own browser
// half reaches its Host half over the app's HTTP carrier. Every route is gated
// by the Connection service (Host/Origin fence + login cookie), so no other
// local process can drive a label repair.

const PREFIX = '/workspace-integrity/api'
const MAX_BODY_BYTES = 64 * 1024

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    try { response.end() } catch { /* already finished */ }
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

function gate(connection, request, response) {
  if (!connection || typeof connection.requestRejection !== 'function') return false
  let rejection
  try {
    rejection = connection.requestRejection(request)
  } catch {
    rejection = 403
  }
  if (rejection === undefined) return false
  sendJson(response, rejection, {
    ok: false,
    error: rejection === 401 ? 'Sign in again before using this panel.' : 'The request origin is not trusted.',
  })
  return true
}

/**
 * Register the panel's JSON routes on the Host HTTP carrier.
 * @param webServer - the `webServer` service.
 * @param connection - the `connection` service used as the request fence.
 * @param service - the operations the agent tool also calls.
 * @returns a disposer that withdraws every route.
 */
export function registerRoutes(webServer, connection, service) {
  if (!webServer || typeof webServer.register !== 'function') throw new Error('The webServer service is unavailable.')
  const disposers = []

  function route(path, methods, handle) {
    const handler = async function (request, response) {
      if (gate(connection, request, response)) return
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
        // 400/413 are the caller's input; anything else is this Host failing.
        const status = typeof error?.status === 'number' ? error.status : 500
        sendJson(response, status, { ok: false, error: String((error && error.message) || error) })
      }
    }
    disposers.push(webServer.register({ kind: 'exact', path: PREFIX + path, handler }))
  }

  try {
    route('/state', ['GET'], (context) => service.state(context))
    route('/scan', ['POST'], ({ body }) => service.scan(body))
    route('/fix', ['POST'], ({ body }) => service.fix(body))
    route('/verify', ['POST'], ({ body }) => service.verify(body))
    route('/records', ['GET'], () => service.records())
    route('/rollback', ['POST'], ({ body }) => service.rollback(body))
  } catch (error) {
    // A partial registration must not leak the routes that did register.
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* withdrawal must not throw */ }
    }
    throw error
  }

  return function disposeRoutes() {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* withdrawal must not throw */ }
    }
  }
}
