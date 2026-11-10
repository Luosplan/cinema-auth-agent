import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

const MAX_CAPTURE_BYTES = 512 * 1024
const UPSTREAM_TIMEOUT = 30000

/**
 * 本地 TLS 中间人代理。
 *
 * 行为约定（非常重要）：
 *   - 只有命中白名单的域名才解密，其余全部走原始 TCP 隧道直通。
 *     客户机上的流量不可能被我们破坏，也不可能因为证书问题断网。
 *   - 上游证书始终严格校验。若上游证书异常，请求直接失败而不是降级放行 —
 *     宁可少抓一条，也不在客户机器上制造可被利用的降级通道。
 */
export default class MitmProxy {
  constructor({ ca, matchHost }) {
    this.ca = ca
    this.matchHost = matchHost || (() => false)
    this.server = null
    this.mitmServer = null
    this.port = 0
    this.onCapture = null
    this.onLog = null
    this.stats = { total: 0, intercepted: 0, tunneled: 0, failed: 0 }
  }

  start(preferredPort = 9090) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handlePlain(req, res))

      server.on('connect', (req, socket, head) => {
        this.handleConnect(req, socket, head)
      })

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // 端口被占用时自动换一个，客户机上 9090 常被别的调试工具占着
          server.listen(0, '127.0.0.1')
          return
        }
        reject(err)
      })

      server.on('listening', () => {
        this.port = server.address().port
        this.server = server
        this.initMitmServer()
        this.log('info', `代理已启动 127.0.0.1:${this.port}`)
        resolve(this.port)
      })

      server.listen(preferredPort, '127.0.0.1')
    })
  }

  /**
   * 复用同一个 https server 处理解密后的请求，
   * 每个 CONNECT 只把已握手的 socket 喂给它，不再重复创建实例。
   */
  initMitmServer() {
    const fallback = this.ca.issue('localhost')
    this.mitmServer = https.createServer(
      {
        key: fallback.key,
        cert: fallback.cert,
        SNICallback: (servername, cb) => {
          try {
            const { key, cert } = this.ca.issue(servername)
            cb(null, tls.createSecureContext({ key, cert }))
          } catch (e) {
            cb(e)
          }
        }
      },
      (req, res) => this.handleDecrypted(req, res)
    )
    this.mitmServer.on('tlsClientError', () => {})
    this.mitmServer.on('error', () => {})
  }

  handleConnect(req, clientSocket, head) {
    const { host, port } = splitHostPort(req.url)
    this.stats.total++

    if (!this.shouldIntercept(host)) {
      this.stats.tunneled++
      return this.tunnel(host, port, clientSocket, head)
    }

    this.stats.intercepted++
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    if (head && head.length) clientSocket.unshift(head)

    // 把原始 socket 交给 https server 完成 TLS 握手
    try {
      this.mitmServer.emit('connection', clientSocket)
    } catch (e) {
      this.stats.failed++
      clientSocket.destroy()
      this.log('error', `TLS 接管失败 ${host}: ${e.message}`)
    }
  }

  tunnel(host, port, clientSocket, head) {
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    const destroy = () => {
      upstream.destroy()
      clientSocket.destroy()
    }
    upstream.on('error', destroy)
    clientSocket.on('error', destroy)
  }

  shouldIntercept(host) {
    try {
      return Boolean(this.matchHost(host))
    } catch {
      return false
    }
  }

  /**
   * 明文 HTTP（极少见，但暖通类系统和部分降级接口仍会走）
   */
  handlePlain(req, res) {
    const host = (req.headers.host || '').split(':')[0]
    if (!this.shouldIntercept(host)) {
      res.writeHead(502)
      res.end('cinema-auth-agent: host not allowed')
      return
    }
    this.forward(req, res, { host, port: 80, secure: false })
  }

  /**
   * 解密后的 HTTPS 请求
   */
  handleDecrypted(req, res) {
    const hostHeader = req.headers.host || ''
    const { host, port } = splitHostPort(hostHeader)
    this.forward(req, res, { host, port: port || 443, secure: true })
  }

  forward(clientReq, clientRes, { host, port, secure }) {
    const startedAt = Date.now()
    const reqChunks = []
    let reqSize = 0

    clientReq.on('data', (chunk) => {
      if (reqSize < MAX_CAPTURE_BYTES) {
        reqChunks.push(chunk)
        reqSize += chunk.length
      }
    })

    const headers = { ...clientReq.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']

    const options = {
      host,
      port,
      method: clientReq.method,
      path: clientReq.url,
      headers,
      rejectUnauthorized: true,
      servername: secure ? host : undefined
    }

    const upstreamReq = (secure ? https : http).request(options, (upstreamRes) => {
      const resChunks = []
      let resSize = 0

      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)

      upstreamRes.on('data', (chunk) => {
        clientRes.write(chunk)
        if (resSize < MAX_CAPTURE_BYTES) {
          resChunks.push(chunk)
          resSize += chunk.length
        }
      })

      upstreamRes.on('end', () => {
        clientRes.end()
        this.emitCapture({
          id: randomUUID(),
          at: new Date().toISOString(),
          duration: Date.now() - startedAt,
          host,
          method: clientReq.method,
          path: clientReq.url,
          statusCode: upstreamRes.statusCode,
          reqHeaders: headers,
          resHeaders: upstreamRes.headers,
          reqBody: decodeBody(Buffer.concat(reqChunks), headers['content-encoding']),
          resBody: decodeBody(
            Buffer.concat(resChunks),
            upstreamRes.headers['content-encoding']
          ),
          truncated: resSize >= MAX_CAPTURE_BYTES
        })
      })

      upstreamRes.on('error', () => clientRes.destroy())
    })

    upstreamReq.setTimeout(UPSTREAM_TIMEOUT, () => {
      upstreamReq.destroy(new Error('上游超时'))
    })

    upstreamReq.on('error', (e) => {
      this.stats.failed++
      this.log('warn', `转发失败 ${host}${clientReq.url}: ${e.message}`)
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      clientRes.end('upstream error')
    })

    if (reqChunks.length) upstreamReq.write(Buffer.concat(reqChunks))
    upstreamReq.end()
  }

  emitCapture(record) {
    if (typeof this.onCapture === 'function') {
      try {
        this.onCapture(record)
      } catch (e) {
        this.log('error', `采集回调异常: ${e.message}`)
      }
    }
  }

  log(level, message) {
    if (typeof this.onLog === 'function') this.onLog(level, message)
  }

  async stop() {
    await new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      // 已建立的隧道不能等，直接断开引用让 OS 回收
      this.server = null
    })
    this.mitmServer = null
  }
}

function splitHostPort(value) {
  if (!value) return { host: '', port: 443 }
  const idx = value.lastIndexOf(':')
  if (idx === -1) return { host: value, port: 443 }
  const host = value.slice(0, idx)
  const port = Number(value.slice(idx + 1))
  return { host, port: Number.isFinite(port) ? port : 443 }
}

/**
 * 按 content-encoding 解压。微信侧大量接口用 gzip，不解压拿到的是乱码。
 */
function decodeBody(buffer, encoding) {
  if (!buffer || !buffer.length) return ''
  const enc = String(encoding || '').toLowerCase()
  try {
    let out = buffer
    if (enc.includes('br')) out = zlib.brotliDecompressSync(buffer)
    else if (enc.includes('gzip')) out = zlib.gunzipSync(buffer)
    else if (enc.includes('deflate')) out = zlib.inflateSync(buffer)
    return out.toString('utf8')
  } catch {
    return buffer.toString('utf8')
  }
}
