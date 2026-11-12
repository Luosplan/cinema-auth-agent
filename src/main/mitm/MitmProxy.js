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
    /** 上游代理（通常是用户正在用的 Clash / V2Ray），null 表示直连 */
    this.upstream = null
    this._httpAgent = null
    this._httpsAgent = null
  }

  /**
   * 设置上游代理。
   *
   * 为什么需要：用户开着 Clash 才能出网，而 Clash 开着「系统代理」时系统代理指向它自己。
   * 我们要抓包就把系统代理改成 9090，那用户瞬间断网（外网全没了）。
   * 反过来让 Clash 占着系统代理，我们一条流量也收不到。
   * 唯一能两者共存的做法是链式：系统代理指向本程序 → 本程序解密需要的 → 其余（含全部隧道）
   * 原样转发给 Clash → Clash 出网。用户既有网，我们也能抓。
   */
  setUpstream(upstream) {
    const ok = upstream && upstream.host && Number(upstream.port) > 0
    this.upstream = ok ? { host: upstream.host, port: Number(upstream.port) } : null
    this._httpAgent = this.upstream ? new UpstreamHttpAgent(this.upstream) : null
    this._httpsAgent = this.upstream ? new UpstreamHttpsAgent(this.upstream) : null
    if (this.upstream) {
      this.log('info', `上游代理 ${this.upstream.host}:${this.upstream.port}（出网经它转发）`)
    }
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
    // 隧道也要经上游：用户的外网能力全在 Clash 上，直连只会一条都建不起来
    if (this.upstream) {
      connectViaProxy(this.upstream, host, port).then(
        (upstreamSocket) => {
          if (clientSocket.destroyed) {
            upstreamSocket.destroy()
            return
          }
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head && head.length) upstreamSocket.write(head)
          upstreamSocket.pipe(clientSocket)
          clientSocket.pipe(upstreamSocket)

          const destroy = () => {
            upstreamSocket.destroy()
            clientSocket.destroy()
          }
          upstreamSocket.on('error', destroy)
          clientSocket.on('error', destroy)
        },
        (e) => {
          this.stats.failed++
          this.log('warn', `经上游隧道失败 ${host}:${port}: ${e.message}`)
          if (!clientSocket.destroyed) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          }
        }
      )
      return
    }

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
   *
   * 接管系统代理期间这里是**全量入口**，不能再对没命中的域名回 502 ——
   * 那等于用户一开采集，所有 http 页面全打不开。照常转发，只是不记录。
   */
  handlePlain(req, res) {
    const host = (req.headers.host || '').split(':')[0]
    this.forward(req, res, {
      host,
      port: 80,
      secure: false,
      capture: this.shouldIntercept(host)
    })
  }

  /**
   * 解密后的 HTTPS 请求
   */
  handleDecrypted(req, res) {
    const hostHeader = req.headers.host || ''
    const { host, port } = splitHostPort(hostHeader)
    this.forward(req, res, { host, port: port || 443, secure: true })
  }

  forward(clientReq, clientRes, { host, port, secure, capture = true }) {
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
    // 有上游就走上游（CONNECT 隧道 + 可选 TLS），没有就走系统默认直连
    const agent = secure ? this._httpsAgent : this._httpAgent
    if (agent) options.agent = agent

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
        // 未命中的域名只是借道出网，不进抓包缓冲
        if (!capture) return
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

/**
 * 通过上游代理建立到 host:port 的 TCP 隧道（HTTP CONNECT）。
 *
 * 必须看 CONNECT 的响应码：Clash 拒连时回的是 403/502，
 * 这里把真实原因抛出去，比让上层等到 30 秒超时好排查得多。
 *
 * 单独导出是为了能脱离 Electron 直接验证（.tmp 里的验收脚本用它连真实 Clash）。
 */
export function connectViaProxy(upstream, host, port, timeout = UPSTREAM_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(upstream.port, upstream.host)
    let buf = ''

    const cleanup = () => {
      socket.setTimeout(0)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
    }
    const fail = (e) => {
      cleanup()
      socket.destroy()
      reject(e)
    }
    const onError = (e) => fail(e)
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) {
        if (buf.length > 16384) fail(new Error('上游代理响应头异常'))
        return
      }
      const status = Number(buf.slice(0, idx).split(' ')[1] || 0)
      const rest = Buffer.from(buf.slice(idx + 4), 'latin1')
      if (status !== 200) {
        fail(new Error(`上游代理拒绝 CONNECT（${status || '无响应'}）`))
        return
      }
      cleanup()
      // CONNECT 之后代理理论上不该抢发数据，但真发了就得还回读缓冲，不然会丢字节
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }

    socket.setTimeout(timeout, () => fail(new Error('上游代理连接超时')))
    socket.on('error', onError)
    socket.on('data', onData)
    socket.on('connect', () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          'Proxy-Connection: keep-alive\r\n\r\n'
      )
    })
  })
}

/** Agent 的 createConnection 是「成功/失败二选一」的回调，重复调用会让 Node 抛 already called */
function onceify(fn) {
  let called = false
  return (...args) => {
    if (called) return
    called = true
    fn(...args)
  }
}

/** 明文 HTTP 经上游：CONNECT 隧道里发 origin-form 请求，直接复用原始 socket */
export class UpstreamHttpAgent extends http.Agent {
  constructor(upstream) {
    super({ keepAlive: false })
    this.upstream = upstream
  }

  createConnection(options, cb) {
    const done = onceify(cb)
    connectViaProxy(this.upstream, options.host, options.port).then(
      (socket) => done(null, socket),
      (e) => done(e)
    )
    return undefined
  }
}

/**
 * HTTPS 经上游：先 CONNECT 拿到裸 socket，再在这条隧道上做 TLS。
 * 证书仍然严格校验（rejectUnauthorized 默认真），不因为有上游就降级。
 */
export class UpstreamHttpsAgent extends https.Agent {
  constructor(upstream) {
    super({ keepAlive: false })
    this.upstream = upstream
  }

  createConnection(options, cb) {
    const done = onceify(cb)
    connectViaProxy(this.upstream, options.host, options.port).then(
      (socket) => {
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || options.host,
          rejectUnauthorized: options.rejectUnauthorized !== false
        })
        tlsSocket.once('secureConnect', () => done(null, tlsSocket))
        tlsSocket.once('error', (e) => {
          socket.destroy()
          done(e)
        })
      },
      (e) => done(e)
    )
    return undefined
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
