// dsh-notifier test/helpers/urlguard-public.mjs
// 测试夹具：把 _urlguard 的 DNS 解析替换为恒公网结果。
// S-02 之后 webhook/自托管 spec 渠道发送前会做真实 dns.lookup——mock fetch 的契约
// 测试（假域名 / only-bound 这类主机名）会因此打到真网并 ENOTFOUND。本夹具让
// 「域名路径」稳定解析到公网 IP 8.8.8.8，SSRF 闸放行，fetch 仍是各测试自己的 stub。
// node --test 每文件独立进程，模块作用域安装即可；close/restore 供单测内切换语义用。

import { __setLookupForTests } from '../../src/adapters/_urlguard.mjs'

/** 安装恒公网解析；返回恢复原实现的函数。 */
export function stubPublicLookup() {
  __setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }])
  return () => __setLookupForTests(null)
}

stubPublicLookup()
