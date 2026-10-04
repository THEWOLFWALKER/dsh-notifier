// dsh-notifier v0.15 Stage 4 — 单一来源的 daily control-surface 方法白名单。
//
// 背景（Stage 3 独立 Review R3）：`rpc.mjs` 只做 connection admission，没有 method-level
// authority；任何已 admitted 客户端都能直呼旧 compatibility switch 里的 legacy endpoint
// （sessions.* / bindings.* / channels.* / members.* / pairing.* / tasks.list / surface.home …）。
// 本模块把「daily 浏览器客户端允许调用的方法」固化成显式 allowlist，由 service 层强制：
// 不在白名单 = `not-supported`，绝不落到巨型 switch 的默认分支。
//
// 分层：
//  - Native daily：窄动作表（native.*），唯一日常读写面。
//  - Secondary：当前真实 UI 仍在使用、且不属于 Native 的动作面（配置导出/导入、Cloudflare、
//    远程入口校验、只读诊断快照、revision wait、可选 dsh-im 投递桥）。
//  - Legacy：已无 UI 调用者、由 Native 等价能力取代的旧接口——本阶段删除，不再列出。
//  - Recovery is an offline operator workflow, not a separate HTTP service.

import { NATIVE_METHODS } from '../native/register.mjs'

/**
 * Secondary 用户功能白名单：仅保留「当前 daily UI 真的有调用者」的方法。
 * 采用精确方法名（cloudflare./portability. 展开），不使用通配前缀——通配会重新打开攻击面。
 */
export const SECONDARY_METHODS = Object.freeze([
  // 世代/wait 长轮询（只读，客户端刷新循环使用）。
  'surface.wait',
  // v0.14（S11）：canonical 只读诊断快照（帮助页 support report 使用；无副作用、不重放 interaction）。
  'diagnostics.snapshot',
  // v0.15（T21）：本地配置导出 / 导入（import 走 canonical 权威 dry-run + 提交）。
  'portability.export',
  'portability.preview',
  'portability.cancel',
  'portability.readBack',
  'portability.commit',
  // v0.15：Cloudflare 自动连接（仅当前 UI 实际使用的方法）。
  'cloudflare.status',
  'cloudflare.loginDevice',
  'cloudflare.refresh',
  'cloudflare.deploy',
  'cloudflare.link',
  'cloudflare.unbind',
  'cloudflare.cancel',
  'cloudflare.tunnelConfigure',
  'cloudflare.tunnelStart',
  'cloudflare.tunnelStop',
  // v0.15（T24）：远程入口 URL 校验（纯本地解析、零网络、零写）。
  'remote.validate',
  // v0.15（T22）：可选 dsh-im 投递桥（服务缺失是正常态；发送走 checked 契约）。
  'dshIm.status',
  'dshIm.listBots',
  'dshIm.listTargets',
  'dshIm.send',
])

/** Daily 浏览器客户端允许调用的全部方法：Native 窄动作表 ∪ Secondary。 */
export const DAILY_ALLOWED_METHODS = Object.freeze([...NATIVE_METHODS, ...SECONDARY_METHODS])

const DAILY_ALLOWED_SET = new Set(DAILY_ALLOWED_METHODS)

/**
 * 该方法是否允许由 daily control-surface 客户端调用。
 * @param {unknown} method
 * @returns {boolean}
 */
export function isDailyAllowedMethod(method) {
  return DAILY_ALLOWED_SET.has(String(method))
}

/** Stage 4 明确删除、不得再出现在 daily 通话面的 legacy 方法族前缀（用于 adversarial 测试）。 */
export const REMOVED_LEGACY_PREFIXES = Object.freeze([
  'surface.home',
  'channels.',
  'tasks.list',
  'questions.',
  'members.',
  'pairing.',
  'sessions.',
  'bindings.',
  'activity.list',
])
