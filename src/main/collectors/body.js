/**
 * 抓包 body 的解析层。
 *
 * 为什么单独抽出来：这些出票系统里表单提交占了一大半，而我们原来只认 JSON。
 * mini 系（xcxyyww.cn / MiniTicket/index.php）的登录 POST 就是
 * `CVersion=4.1.6.46&OS=Windows&agent=17762682464&token=xxx` 这种纯表单，
 * 只按 `{` 开头判 JSON 的话整条 body 会被当成「不是 JSON」丢掉 ——
 * 表现为响应体里的 openid 抓得到、表单里的 token 一个都抓不到。
 *
 * 两个解析器都放这里，ParamCollector（按名匹配）和 ParamResolver（显式路径）
 * 共用同一份语义，否则两层对同一条记录的理解会不一致。
 */

export const MAX_BODY_CHARS = 512 * 1024

/** JSON body：只在看起来像 JSON 时才 parse，避免把表单串喂给 JSON.parse */
export function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null
  if (text.length > MAX_BODY_CHARS) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * 表单 body：`a=1&b=2`，也可能是被当成字符串塞进 JSON 的同一串。
 *
 * 容错点：
 *   · 值里的 `=` 不能被截断（base64 token 结尾常带 `==`），所以用 indexOf 而不是 split('=')
 *   · key 可能带 `[]` 后缀（`ids[]=1`），把方括号去掉，按普通字段处理
 *   · 重复 key 保留最后一个 —— 与「后写覆盖先写」的整体语义一致
 */
export function parseFormSafe(text) {
  if (!text || typeof text !== 'string') return null
  if (text.length > MAX_BODY_CHARS) return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return null
  // 没有 `=` 的一律不是表单（HTML、纯文本、二进制都走这里被排除）
  if (!trimmed.includes('=')) return null
  // HTML 页面里也到处是 `=`，用「像不像一个页面」先挡掉
  if (/^</.test(trimmed)) return null

  const out = {}
  let hit = 0
  for (const pair of trimmed.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = cleanKey(decodeSafe(pair.slice(0, eq)))
    if (!key) continue
    out[key] = decodeSafe(pair.slice(eq + 1))
    hit += 1
  }
  // 只有一个 `=` 且键名很长，多半是 base64/签名串被误认，放过它
  return hit >= 1 ? out : null
}

/**
 * 统一入口：JSON 优先，退化成表单。
 *
 * @returns {object|null} 两种都不像就返回 null，调用方按「没有 body」处理
 */
export function parseBody(text) {
  return parseJsonSafe(text) || parseFormSafe(text)
}

function cleanKey(key) {
  return String(key || '')
    .trim()
    .replace(/\[\]$/, '')
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '))
  } catch {
    return String(value)
  }
}

export default { parseBody, parseJsonSafe, parseFormSafe, MAX_BODY_CHARS }
