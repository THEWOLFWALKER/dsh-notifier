// dsh-notifier extensions/cloudflare-tunnel/src/assets.mjs
// T25（可选 Cloudflare Tunnel）— 固定版本 cloudflared 下载资产清单与校验（R05）。
//
// 核心原则：**自下载必须固定官方版本、平台资产与可核对 checksum，验证通过后才可执行**；
// 绝不「下载即执行」未知 binary、绝不用远程 shell 安装串。当前只支持 **user-managed binary**
// ——用户按安装引导自行放置 cloudflared，本扩展只校验其版本/校验和，不代为下载。
//
// 纯数据 + 纯校验模块：不发起下载、不 spawn。`verifyAsset` 只做 sha256 比对，供未来
// 自下载路径复用；当前 user-managed 模式把「缺失 / 校验不符」如实报 not-configured，不回退到
// 下载执行。

import { createHash } from 'node:crypto'

// 固定版本清单（示例结构；部署前由发布流程锁定真实官方版本与各平台 sha256）。
// 字段：version / 说明 / 各平台 { asset, sha256 }。sha256 为空表示该平台未登记（fail-closed）。
export const PINNED_CLOUDFLARED = Object.freeze({
  version: '2024.10.0',
  platforms: Object.freeze({
    'linux-x64': Object.freeze({ asset: 'cloudflared-linux-amd64', sha256: '' }),
    'linux-arm64': Object.freeze({ asset: 'cloudflared-linux-arm64', sha256: '' }),
    'darwin-x64': Object.freeze({ asset: 'cloudflared-darwin-amd64.tgz', sha256: '' }),
    'darwin-arm64': Object.freeze({ asset: 'cloudflared-darwin-arm64.tgz', sha256: '' }),
    'win32-x64': Object.freeze({ asset: 'cloudflared-windows-amd64.exe', sha256: '' }),
  }),
})

const isRecord = (value) => typeof value === 'object' && value !== null

/**
 * 校验下载资产 sha256。空/缺失 checksum、长度非法、大小写差异一律不通过（fail-closed）。
 * @param {string} [expectedHex] - 期望的 sha256（hex，固定长度 64）
 * @param {Buffer|Uint8Array|string} data
 * @returns {boolean}
 */
export function verifyAsset(expectedHex, data) {
  if (typeof expectedHex !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false
  const actual = createHash('sha256').update(data).digest('hex')
  return actual.toLowerCase() === expectedHex.toLowerCase()
}

/**
 * 由平台键解析登记的资产；未登记平台 / 空 sha256 视为「尚未固定校验」，一律 not-configured。
 * @param {string} [platform] - process.platform + '-' + process.arch 形态，如 'linux-x64'
 * @returns {{ok:true, asset:string, sha256:string} | {ok:false, reason:string}}
 */
export function resolveAsset(platform) {
  const key = typeof platform === 'string' && platform !== '' ? platform : 'unknown'
  const entry = PINNED_CLOUDFLARED.platforms[key]
  if (!entry) return { ok: false, reason: 'unsupported-platform' }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
    return { ok: false, reason: 'checksum-unpinned' }
  }
  return { ok: true, asset: entry.asset, sha256: entry.sha256 }
}

export const ASSET_REASONS = Object.freeze({
  'unsupported-platform': '当前平台没有已登记的 cloudflared 资产',
  'checksum-unpinned': '当前平台资产尚未固定校验和，拒绝以未验证 binary 执行',
})