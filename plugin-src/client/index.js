import * as React from 'react'

// Commit 1 只交付浏览器模块的构建 / 校验链路：这个入口刻意不注册任何插槽、不携带任何数据，
// 也不放进任何 mock 数据或占位界面。真实原生面板外壳在 Commit 2 由交付 starter 替换本文件。
//
// 这里显式引用 Host 提供的 `react` external，使 scripts/verify-client.mjs 能证明产物是
// 「require 宿主模块表里的 react」，而不是把第二份 React 打进浏览器产物。
const createElement = React.createElement

export const name = 'dsh-notifier-native'

// package.json 的 dsh.client.inject 是「包名」；浏览器模块的 inject 是 Cordis「服务名」。
export const inject = ['slots', 'connection', 'locale']

export function apply() {
  void createElement
}