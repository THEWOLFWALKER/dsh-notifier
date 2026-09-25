// v0.12.1（P1-04 / P1-05 / D-08）：热/重启口径的单一权威（v0.12 内部）。
//
// Native Control Surface 的出站 canonical 域保存后同步替换运行时，入站配置只写
// state、不会重建 transport。因此 Native 只从这里回答「保存后是否生效」。Admin 的
// legacy <type>:account 写入域另有自己的重启提示，语义不同。

export const APPLY_MODE = Object.freeze({ hot: 'hot', restart: 'restart' })

/** 出站 canonical 配置保存后同步替换运行时。 */
export function outboundApplyMode() {
  return APPLY_MODE.hot
}

/** 入站配置保存后等待进程重启并入 transport。 */
export function inboundApplyMode() {
  return APPLY_MODE.restart
}

/** 该方向保存后是否已经即时生效。 */
export function isHotApplied(direction) {
  return (direction === 'outbound' ? outboundApplyMode() : inboundApplyMode()) === APPLY_MODE.hot
}
