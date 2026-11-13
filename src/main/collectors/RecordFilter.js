/**
 * 哪些抓包记录值得留下。
 *
 * 参数只会出现在接口报文里：cookie、请求头、JSON 体。
 * 而浏览器刷新一次页面会同时拉几十个图片 / 字体 / 脚本 / 页面预览，
 * 这些记录对本工具没有任何价值，却有两个实打实的害处：
 *
 *   1. 抓包缓冲是环形的（只留最近 300 条），页面一刷新就能把真正的接口记录挤出窗口 ——
 *      「点了获取参数，等了半天一个值都没抓到」有一半是这么来的；
 *   2. 「获取参数」每 250ms 回扫一次缓冲，无用记录翻得越多，越晚命中。
 *
 * 所以只放行 GET / POST，且排除静态资源（按扩展名与响应 Content-Type 双重判定）。
 * 只认「确定不可能带凭证」的：宁可多留一条接口，也不能把真接口筛掉。
 */

/** 只留这两种：接口取值只可能来自它们，其余（OPTIONS / HEAD / PUT / DELETE）与参数无关 */
const ALLOWED_METHODS = new Set(['GET', 'POST'])

/** 静态资源扩展名。命中即丢，连 Content-Type 都不用看 */
const STATIC_EXT = new Set([
  // 图片
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'svg',
  // 样式 / 脚本 / 源映射
  'css',
  'js',
  'mjs',
  'cjs',
  'map',
  // 字体
  'woff',
  'woff2',
  'ttf',
  'eot',
  'otf',
  // 音视频（含 HLS 分片）
  'mp4',
  'm4v',
  'mov',
  'avi',
  'mkv',
  'webm',
  'flv',
  'm3u8',
  'ts',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'flac',
  // 下载物
  'pdf',
  'zip',
  'rar',
  '7z',
  'apk',
  'exe',
  'dmg'
])

/** 响应类型是这几类的一律不算接口 */
const STATIC_TYPE_RE =
  /^(?:image\/|font\/|video\/|audio\/|text\/css|text\/javascript|application\/(?:javascript|x-javascript|ecmascript|font|x-font|wasm|octet-stream))/i

/**
 * 页面 HTML 也丢。
 *
 * 参数（sid / tid / token / 手机号）全在接口报文里，页面只是外壳；
 * 而页面里常带一堆同名文本（影城名、账号、推荐位），
 * 一旦进缓冲就会和真接口的同名字段混在一起 —— 这正是「抓到的手机号不是这个账号」的来源之一。
 */
const HTML_TYPE_RE = /^text\/html/i

function headerOf(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  if (!key) return ''
  const raw = headers[key]
  return Array.isArray(raw) ? raw.join('; ') : String(raw || '')
}

/** 取路径的扩展名（只看最后一段，`/v1.0/list` 这种把点当版本号的不会被误判） */
function extOf(path) {
  const clean = String(path || '').split(/[?#]/)[0]
  const slash = clean.lastIndexOf('/')
  const dot = clean.lastIndexOf('.')
  if (dot <= slash) return ''
  return clean.slice(dot + 1).toLowerCase()
}

/**
 * 这条（即将记录下来的）请求有没有留下的必要，顺带给出「不留的理由」。
 *
 * 理由不是给人看的装饰：抓包页右侧那块实时面板要显示「已跳过 N 条」，
 * 否则用户只会看到「一个参数都没抓到」，完全不知道是请求没来、还是来了被筛掉了。
 *
 * @param {{ method?: string, path?: string, resHeaders?: object }} record
 * @param {string[]} [pathHints] 当前系统的路径特征（mini 的 `miniticket`）。
 *   只影响一件事：PHP 系统把 JSON 挂在 `text/html` 上发回来时不能按页面丢掉。
 * @returns {{ ok: boolean, reason: string }}
 */
export function captureVerdict(record, pathHints) {
  const method = String(record?.method || '').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, reason: `${method || '未知方法'}（只收 GET/POST）` }
  }

  const ext = extOf(record?.path)
  if (STATIC_EXT.has(ext)) return { ok: false, reason: `静态资源 .${ext}` }

  /**
   * 3xx 必须放行。
   *
   * 跳转响应一般没有响应体，`content-type` 常常是 text/html —— 按下面的规则会被当成
   * 「页面 HTML」丢掉。但微信授权登录恰恰是 302：凭证（code / openid）全在 `Location`
   * 的 query 里，丢了这条就等于丢了唯一带 openid 的请求。
   */
  const status = Number(record?.statusCode) || 0
  if (status >= 300 && status < 400) return { ok: true, reason: '' }

  const type = headerOf(record?.resHeaders, 'content-type').trim()
  if (type) {
    if (STATIC_TYPE_RE.test(type)) {
      return { ok: false, reason: `响应类型 ${type.split(';')[0]}` }
    }
    if (HTML_TYPE_RE.test(type)) {
      /**
       * PHP 那类系统（mini 的 `/MiniTicket/index.php`）经常不设 JSON content-type，
       * 接口报文挂着 `text/html` 回来。路径带系统特征时必须放行，
       * 否则「请求明明来了、面板上一条都没有」。
       */
      if (matchesHints(record?.path, pathHints)) return { ok: true, reason: '' }
      return { ok: false, reason: '页面 HTML' }
    }
  }

  return { ok: true, reason: '' }
}

/** 路径是否带特征关键字（大小写不敏感；没有特征时一律不算命中） */
function matchesHints(path, hints) {
  if (!Array.isArray(hints) || !hints.length) return false
  const text = String(path || '').toLowerCase()
  if (!text) return false
  return hints.some((hint) => text.includes(String(hint).toLowerCase()))
}

/**
 * 这条（即将记录下来的）请求有没有留下的必要。
 *
 * @param {{ method?: string, path?: string, resHeaders?: object }} record
 * @returns {boolean}
 */
export function isCaptureWorthy(record, pathHints) {
  return captureVerdict(record, pathHints).ok
}

export default { isCaptureWorthy, captureVerdict }
