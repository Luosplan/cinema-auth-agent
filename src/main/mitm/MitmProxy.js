import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { captureVerdict } from '../collectors/RecordFilter.js'

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
  constructor({ ca, matchHost, pathHints }) {
    this.ca = ca
    this.matchHost = matchHost || (() => false)
    /**
     * 当前系统的路径特征（mini 的 /MiniTicket/）。
     *
     * 只为一件事：PHP 那类系统的接口常把 JSON 挂在 `text/html` 上发回来，
     * 按「页面 HTML」丢掉就永远抓不到；路径带特征时不能当页面处理。
     * 传函数而不是数组：抓包过程中系统代号可能被换成另一家。
     */
    this.pathHints = typeof pathHints === 'function' ? pathHints : () => []
    this.server = null
    this.mitmServer = null
    this.port = 0
    this.onCapture = null
    this.onSkip = null
    this.onLog = null
    this.stats = { total: 0, intercepted: 0, tunneled: 0, failed: 0, skipped: 0 }
    /**
     * 被隧道直通的域名与次数。
     *
     * 「一条请求都没有」最难判断的就是：到底是浏览器没走代理，还是走了但域名不在解密范围。
     * 把直通的域名记下来，面板上一列就能看出真相 ——
     * 如果目标系统的域名赫然出现在这里，说明解密范围配错了，不用再猜。
     *
     * 上限按「不同域名数」算：一次刷新几十上百条连接很常见，200 足够覆盖，
     * 超出后按最冷门淘汰（见 noteTunneled），保证热点域名不被丢掉。
     */
    this.tunneledHosts = new Map()
    this.tunneledLimit = 200
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
      this.noteTunneled(host)
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
   * 记一笔直通的域名。
   *
   * 表满时挤掉**最少见**的那个，而不是拒绝新域名：
   * 一刷新就是上百条连接（CDN、埋点、图片各自不同域），先到先得会把真正的接口域名挤在外面，
   * 面板上表现为「190 条连接，榜首才 4 次」——数字全错，等于没记。
   * 挤掉冷门域名后，热点域名（往往就是目标接口）始终留在表里。
   */
  noteTunneled(host) {
    const h = String(host || '')
      .toLowerCase()
      .trim()
    if (!h) return
    const cur = this.tunneledHosts.get(h)
    if (cur !== undefined) {
      this.tunneledHosts.set(h, cur + 1)
      return
    }
    if (this.tunneledHosts.size >= this.tunneledLimit) {
      let coldKey = null
      let coldVal = Infinity
      for (const [key, val] of this.tunneledHosts) {
        if (val < coldVal) {
          coldVal = val
          coldKey = key
          // val 最小就是 1，不可能更小，直接停
          if (coldVal === 1) break
        }
      }
      if (coldKey !== null) this.tunneledHosts.delete(coldKey)
    }
    this.tunneledHosts.set(h, 1)
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

    const headers = { ...clientReq.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    /**
     * 压缩算法必须收窄。
     *
     * Chrome 现在会发 `accept-encoding: gzip, deflate, br, zstd`，阿里 mtop 这类服务端
     * 看到 zstd 就真按 zstd 回 —— 而 Electron 31 内置的是 Node 20，**没有 zstd 解码器**。
     * 结果就是我们拿到一段二进制，解不开、JSON 也 parse 不了，
     * 于是「cookie 里的 tid / _m_h5_tk 都抓到了，唯独只在响应体里的手机号永远抓不到」。
     *
     * 只留我们解得开的三种：改请求头比事后猜编码靠谱得多，也不用碰签名（sign 只算 query）。
     */
    if (headers['accept-encoding']) {
      headers['accept-encoding'] = narrowEncoding(headers['accept-encoding'])
    }

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
        /**
         * 命中的域名也要再看一眼这条请求值不值得留：
         * 页面刷新会连着拉一堆图片 / 字体 / 脚本 / 页面 HTML，
         * 它们会把环形缓冲里真正有用的接口记录挤掉，抓包等待就一直命中不了。
         * 只放行 GET / POST 且非静态资源（判定见 RecordFilter）。
         */
        const verdict = captureVerdict(
          {
            method: clientReq.method,
            path: clientReq.url,
            statusCode: upstreamRes.statusCode,
            resHeaders: upstreamRes.headers
          },
          this.pathHints()
        )
        if (!verdict.ok) {
          this.stats.skipped++
          // 把「为什么丢」回传给界面：不然面板上只会显示「一条都没抓到」
          this.emitSkip({
            host,
            method: clientReq.method,
            path: clientReq.url,
            statusCode: upstreamRes.statusCode,
            reason: verdict.reason
          })
          return
        }
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

    /**
     * 请求体必须跟着客户端流的节奏转发。
     *
     * 原来的写法是「先把压下来的 chunk 写一次，然后立刻 end()」——
     * 只要 body 没在 header 同一个包里到达（chunked、大表单、浏览器分片发送），
     * 上游收到的就是「声明了 content-length 却一个字节都没有」的请求：
     * 轻则 socket hang up，重则源站死等 30 秒超时。登录接口全是 POST，正好踩满。
     * 所以改成：data 就转发（顺手留一份给抓包），end 才收尾。
     */
    clientReq.on('data', (chunk) => {
      upstreamReq.write(chunk)
      if (reqSize < MAX_CAPTURE_BYTES) {
        reqChunks.push(chunk)
        reqSize += chunk.length
      }
    })
    clientReq.on('end', () => upstreamReq.end())
    // 客户端中途断开（用户关页面/取消请求）就别让上游请求悬着
    clientReq.on('error', () => upstreamReq.destroy())
    clientReq.on('aborted', () => upstreamReq.destroy())

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

  /**
   * 上报「这条被筛掉了」。
   *
   * 抓包页右侧那块面板靠它显示「已跳过 N 条」和具体原因 ——
   * 没有这个，用户面对空表格只能猜是代理没生效还是页面没刷新。
   */
  emitSkip(info) {
    if (typeof this.onSkip === 'function') {
      try {
        this.onSkip(info)
      } catch {
        /* 诊断信息丢了不影响主流程 */
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
 * 把 Accept-Encoding 收窄到「本进程能解开的」算法。
 *
 * Node 20（Electron 31 内置）没有 zstd 解码器，22.15+ 才有。
 * 这里不赌运行环境，直接把它从请求头里摘掉：服务端就不会回 zstd，
 * 解密出的响应体才可能是能 parse 的 JSON。
 */
export function narrowEncoding(value) {
  const supported = []
  for (const raw of String(value || '').split(',')) {
    const name = raw.split(';')[0].trim().toLowerCase()
    if (!name) continue
    if (name === 'gzip' || name === 'deflate' || name === 'br' || name === 'identity') {
      if (!supported.includes(name)) supported.push(name)
    }
    // zstd / 其它新算法一律丢弃：解不开的编码等于没抓到
  }
  return supported.length ? supported.join(', ') : 'gzip, deflate, br'
}

/** zstd 只在 Node 22.15+ 有；没有就明确抛错，交给上层返回空串而不是乱码 */
function zstdDecompress(buffer) {
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buffer)
  throw new Error('当前 Node 不支持 zstd')
}

/**
 * 按 content-encoding 解压。微信 / 阿里系大量接口用 gzip / br，不解压拿到的是乱码。
 *
 * 三层保护，都是踩过的坑：
 *   1. 多段编码（`gzip, br`）要按逆序逐层解；
 *   2. deflate 有两种流派（带 zlib 头 / 裸 deflate），前者失败退后者；
 *   3. **解不开就返回空串**，绝不回退成 utf8 乱码 —— 乱码会让上层 JSON 解析失败，
 *      和空串的结果一样，但空串不会在诊断文件里伪装成「有响应体但字段名不对」。
 */
export function decodeBody(buffer, encoding) {
  if (!buffer || !buffer.length) return ''
  const enc = String(encoding || '')
    .trim()
    .toLowerCase()
  if (!enc || enc === 'identity') return buffer.toString('utf8')

  const layers = enc
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse()

  try {
    let out = buffer
    for (const layer of layers) {
      if (layer.includes('br')) out = zlib.brotliDecompressSync(out)
      else if (layer.includes('gzip')) out = zlib.gunzipSync(out)
      else if (layer.includes('deflate')) {
        try {
          out = zlib.inflateSync(out)
        } catch {
          out = zlib.inflateRawSync(out)
        }
      } else if (layer.includes('zstd')) out = zstdDecompress(out)
      else return '' // 不认识的算法：宁可空着，也不要把乱码混进取值
    }
    return out.toString('utf8')
  } catch {
    return ''
  }
}
