import { pickValues, listFieldNames } from '../src/main/collectors/ParamCollector.js'
import { resolveForKeys } from '../src/main/collectors/ParamResolver.js'
import { parseFormSafe } from '../src/main/collectors/body.js'

const keys = ['mobile', 'token', 'openid', 'agent', 'member_cost', 'remark']
const HOST = 'xzs11.xcxyyww.cn'
const rule = { hosts: [HOST], params: keys }

let pass = 0
let fail = 0
function check(label, actual, expect) {
  const ok = expect.every(([k, v]) => String(actual[k] ?? '') === v)
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${label} ${ok ? '' : JSON.stringify(actual)}`)
  if (ok) pass += 1
  else fail += 1
}

console.log('\n[1] token 在查询串')
const a = pickValues(
  {
    host: HOST,
    method: 'GET',
    path: '/MiniTicket/index.php/getFilmList?cinemaid=e875cb7c7dd4&token=TK9f8a7b6c5d4e3f2a1b&agent=17762682464',
    reqHeaders: {},
    resHeaders: {},
    reqBody: '',
    resBody: JSON.stringify({ data: { openid: 'oXr7x5Q' } })
  },
  keys
)
check('抓到 token/agent', a, [
  ['token', 'TK9f8a7b6c5d4e3f2a1b'],
  ['agent', '17762682464'],
  ['openid', 'oXr7x5Q']
])

console.log('\n[2] token 在表单体（mini 登录）')
const b = pickValues(
  {
    host: HOST,
    method: 'POST',
    path: '/MiniTicket/index.php/login?cinemaid=e875cb7c7dd4',
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    resHeaders: {},
    reqBody:
      'CVersion=4.1.6.46&OS=Windows&agent=17762682464&mobile=17762682464&token=TK9f8a7b6c5d4e3f2a1b',
    resBody: JSON.stringify({ data: { openid: 'oXr7x5Q' } })
  },
  keys
)
check('表单 token 到手', b, [
  ['token', 'TK9f8a7b6c5d4e3f2a1b'],
  ['agent', '17762682464'],
  ['mobile', '17762682464']
])

console.log('\n[3] Authorization 头（带 Bearer）')
const c = pickValues(
  {
    host: HOST,
    method: 'GET',
    path: '/api/x',
    reqHeaders: { authorization: 'Bearer TK9f8a7b6c5d4e3f2a1b' },
    resHeaders: {},
    reqBody: '',
    resBody: '{}'
  },
  keys
)
check('Bearer 被剥掉', c, [['token', 'TK9f8a7b6c5d4e3f2a1b']])

console.log('\n[4] 响应 set-cookie 里的会话值')
const d = pickValues(
  {
    host: HOST,
    method: 'POST',
    path: '/login',
    reqHeaders: {},
    resHeaders: { 'set-cookie': ['sessionid=SESS9f8a7b6c5d; Path=/; HttpOnly'] },
    reqBody: '',
    resBody: '{}'
  },
  keys
)
check('set-cookie 的 sessionid 映射到 token', d, [['token', 'SESS9f8a7b6c5d']])

console.log('\n[5] 占位符不该被当成 token')
const e = pickValues(
  {
    host: HOST,
    method: 'GET',
    path: '/api/x?token=&agent=17762682464',
    reqHeaders: {},
    resHeaders: {},
    reqBody: 'token=-',
    resBody: JSON.stringify({ data: { token: 'null' } })
  },
  keys
)
check('空/占位被过滤', e, [['token', '']])

console.log('\n[6] JSON body 未被表单解析影响')
const f = pickValues(
  {
    host: HOST,
    method: 'POST',
    path: '/api/x',
    reqHeaders: { 'content-type': 'application/json' },
    resHeaders: {},
    reqBody: JSON.stringify({ mobile: '17762682464', token: 'TK9f8a7b6c5d4e3f2a1b' }),
    resBody: ''
  },
  keys
)
check('JSON 照旧', f, [
  ['mobile', '17762682464'],
  ['token', 'TK9f8a7b6c5d4e3f2a1b']
])

console.log('\n[7] 精确层也能吃表单')
const g = resolveForKeys(
  rule,
  {
    host: HOST,
    method: 'POST',
    path: '/login',
    reqHeaders: {},
    resHeaders: {},
    reqBody: 'token=TK9f8a7b6c5d4e3f2a1b&mobile=17762682464',
    resBody: ''
  },
  keys
)
check(
  '精确层命中',
  Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.value])),
  [
    ['token', 'TK9f8a7b6c5d4e3f2a1b'],
    ['mobile', '17762682464']
  ]
)
console.log(
  '    来源标注:',
  JSON.stringify(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.from])))
)

console.log('\n[8] 字段名反查（诊断用）')
const names = listFieldNames({
  host: HOST,
  method: 'POST',
  path: '/login?cinemaid=e875cb7c7dd4&appid=wx9e4f926f3f878fc9',
  reqHeaders: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'PHPSESSID=a; sid=b' },
  resHeaders: { 'set-cookie': ['sessionkey=xyz; Path=/'], 'x-auth-token': 'v' },
  reqBody: 'token=t&agent=17762682464',
  resBody: JSON.stringify({ data: { openid: 'o', appletToken: 'x' } })
})
const want = [
  'token',
  'agent',
  'cinemaid',
  'appid',
  'PHPSESSID',
  'sid',
  'sessionkey',
  'x-auth-token',
  'appletToken'
]
const missing = want.filter((n) => !names.has(n))
console.log(missing.length ? `  FAIL 少了: ${missing.join(', ')}` : `  OK   ${want.length} 个名字全部看到`)
if (missing.length) fail += 1
else pass += 1

console.log('\n[9] 表单解析边界')
const edge = [
  ['普通表单', 'a=1&b=2', true],
  ['JSON 不吞', '{"a":1}', false],
  ['HTML 不吞', '<html><body>x=1</body></html>', false],
  ['纯文本无 =', 'hello world', false],
  ['数组式 key', 'ids[]=1&ids[]=2', true]
]
for (const [label, text, shouldParse] of edge) {
  const got = parseFormSafe(text)
  const ok = Boolean(got) === shouldParse
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} -> ${got ? JSON.stringify(got) : 'null'}`)
  if (ok) pass += 1
  else fail += 1
}
const b64 = parseFormSafe('token=abc==')
const b64ok = b64?.token === 'abc=='
console.log(`  ${b64ok ? 'OK  ' : 'FAIL'} base64 值完整: ${JSON.stringify(b64?.token)}`)
if (b64ok) pass += 1
else fail += 1

console.log('\n[10] 正播真实形状：applet-token 请求头')
const real = pickValues(
  {
    host: 'xzs11.xcxyyww.cn',
    method: 'POST',
    path: '/ticket/trade/getOrderList',
    reqHeaders: {
      'x-wx-source': 'MINI_PROGRAM',
      'xweb_xhr': '1',
      'applet-token': '85ad5757760cbaef10aa11bb22cc33dd',
      nonce: '4e54cc7b-3f6e-477f-8a1e-0f2b3c4d5e6f',
      'x-wx-appid': 'wx9e4f926f3f878fc9',
      'api-key': '982f5b1bbb894a0d82f1e3c4b5a69788'
    },
    resHeaders: {},
    reqBody: '',
    resBody: '{}'
  },
  keys
)
check('applet-token 映射到 token', real, [['token', '85ad5757760cbaef10aa11bb22cc33dd']])

const realExact = resolveForKeys(
  { hosts: ['xzs11.xcxyyww.cn'], params: keys },
  {
    host: 'xzs11.xcxyyww.cn',
    method: 'POST',
    path: '/ticket/trade/getOrderList',
    reqHeaders: { 'applet-token': '85ad5757760cbaef10aa11bb22cc33dd' },
    resHeaders: {},
    reqBody: '',
    resBody: '{}'
  },
  keys
)
check(
  '精确层也从 applet-token 取到',
  Object.fromEntries(Object.entries(realExact).map(([k, v]) => [k, v.value])),
  [['token', '85ad5757760cbaef10aa11bb22cc33dd']]
)
console.log('    来源:', realExact.token?.from)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
