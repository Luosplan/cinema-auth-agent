# HK票务助手（cinema-auth-agent）

> **当前分支：`hkticketing` —— HK 票务定制版**
> 登录与影城列表对接出票系统（ticket-server）。抓包规则已整体移除，
> 解密域名待后续单独接入，在此之前只记录流量、不提取凭证。

影城票务系统的登录态采集端。装在客户出票电脑上，旁路截获微信小程序登录时产生的
凭证，加密保存在本地，并可上报到你自己的云端。

## 为什么需要它

影城系统几乎全部依赖微信小程序登录态：

- `wx.login()` 产生的 code 只能在小程序运行时内生成，一次性、5 分钟有效；
- 出票服务端要调接口就必须持有有效的 `thirdSession`；
- 部分系统的会话会绝对过期，过期后出票直接失败。

因此需要一台常驻机器，在客户正常使用小程序时顺手把新凭证捞出来。

## 工作方式

```
微信小程序（操作员日常使用）
        │  登录时自动 wx.login
        ▼
本地 MITM 代理（仅解密白名单域名，其余直通）
        │  命中规则 → 提取 thirdSession
        ▼
凭证仓库（safeStorage 加密落盘）
        │  可选
        ▼
云端上报
```

关键设计：**被动采集**。不需要模拟点击、不需要定时任务，
操作员每天正常打开一次小程序，凭证就一直是新鲜的。

## 安全边界

- 只有「系统配置」里填写的域名会被解密，其他流量走原始 TCP 隧道直通，不受影响；
- 上游证书始终严格校验，不存在降级放行；
- 凭证用 Electron `safeStorage` 加密（Windows 下走 DPAPI，绑定当前用户）；
- 界面只显示脱敏凭证，明文仅在复制和上报时短暂存在于内存；
- 上报默认关闭，未配置地址时软件不向外发送任何数据；
- 退出/崩溃都会还原系统代理设置（含 lock 文件兜底）。

## 对接出票系统

登录与影城列表走 ticket-server 的接口，地址固定在 `src/main/config/endpoints.js`，
可用环境变量 `CINEMA_API_BASE` 覆盖，界面上不让用户填：

| 用途 | 接口 |
| --- | --- |
| 登录 | `POST /api/login`，body `{ username, password }`，返回扁平 `{ token, id, username, role }` |
| 探活 | `GET /api/users/me`（JWT 7 天，服务端没有 refresh 接口） |
| 影城列表 | `GET /api/cinemas`，按 `system` 字段聚合成「出票系统 → 影城」 |

抓包规则（原来的 `src/main/collectors/rules/`）已整体移除，`Extractor` 以空规则集启动。
解密域名待后续单独接入；在此之前代理只记录流量，不提取凭证，「获取参数」会提示未配置。

## 开发

```bash
npm install
npm run dev        # 开发模式
npm run build:win  # 打包 Windows 安装包
npm run build:mac  # 打包 macOS
```

要求 Node 18+。Electron 二进制走 `.npmrc` 里的淘宝镜像。

## 目录

```
src/main/
  mitm/          代理引擎、证书签发、系统代理接管
  collectors/    凭证提取与参数采集（规则目录已移除）
  store/         配置与凭证持久化
  reporter/      云端上报
  router/        IPC 路由
src/renderer/    Vue3 + Element Plus 界面
```

## 分支

- `main` — 通用框架与全部规则
- `yipiaotong` — 一票通定制（品牌与规则差异）
- `hkticketing` — HK 票务定制（品牌与规则差异）

分支之间只应有配置与品牌差异，核心采集逻辑保持同源，方便统一修 bug。
