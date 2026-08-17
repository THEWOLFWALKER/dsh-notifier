# Telegram 通道测试包（0.8.0-tg.0）

本包用于验证 **v0.8 远程提问（ask_user 工具）** 的 Telegram 真机链路：
agent 提问 → 手机收到选项卡片（一选项一行按钮）→ 点按钮作答 → 答案回传 agent。
选项卡为主，编号回复是无卡片渠道的兜底；发错编号不作废，重发选项可再答。

> 上一轮真机事故（callback_data 超 64 字节）与本轮修复（editResolved 签名错位）
> 都是 mock 测不出的平台行为——本清单第 4 项就是针对该修复的验证点。

## 一、离线自动化测试（先跑，不需要 Telegram）

```bash
node --test test/questions.test.mjs          # 提问桥 19 用例（卡片分流/发错重发/超时不代答）
node --test test/inbound.telegram.test.mjs   # TG 通道契约 18 用例（含 v0.8 签名修复）
npm test                                     # 全量 835 用例
```

全绿再上真机。

## 二、安装与配置

```bash
dsh plugin add ./dsh-notifier-0.8.0-tg.0.zip --profile <你的profile>
```

`cordis.patch.yml`（Telegram 已配好的只需加 `questions` 段）：

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: <你的 bot token>
      inbound:
        telegram:
          botToken: <同一个 bot token>
          allowUsers:
            - <你的 telegram user id>
      # questions 默认启用，这里只为把超时调短（测超时路径不用干等 5 分钟）
      questions:
        timeoutMs: 120000        # 2 分钟
        # rateLimitPerMinute: 6  # 默认限流，可选
```

绑定确认：给 bot 发 `/whoami`，回执应显示你的 telegram 身份。

## 三、真机测试清单

**触发方式**：在 agent 对话里说——
"用 ask_user 工具问我：今晚部署用哪个环境，选项：测试环境/预发环境/生产环境"。

| # | 场景 | 预期 |
|---|---|---|
| 1 | 单选卡片渲染 | 收到卡片，每选项一行按钮；**无**"回复编号"冗余文案 |
| 2 | 点按钮作答 | toast "✅ 已作答：xxx"，卡片变终态，agent 拿到答案继续执行 |
| 3 | 作答后再点同一按钮 | toast "该提问已回答或已过期"（token 单次核销） |
| 4 | 超时不作答（重点） | 卡片变 "⏱ 超时未作答：已交还桌面（按钮失效）"；agent 收 answered=false 不代答。**本项验证本轮修复——修复前卡片不会变终态** |
| 5 | 回文字 "9"（越界） | 回执 "编号需在 1-3 之间" + 选项重发；再回 "2" 能答上 |
| 6 | 回 "1,2"（单选回多项） | 提示"本题是单选，请只回复一个编号" + 选项重发；改回 "1" 成功 |
| 7 | 多选题（multiSelect: true） | TG 无卡片形态 → 降级编号文案；回 "1,3"（中英文逗号均可）成功 |
| 8 | 30s / 60s 不作答 | 收到催办提醒（轻提醒，不刷选项列表） |
| 9 | 多问一次调用 | agent 一次提 2-4 问 → 逐问推送逐问作答，全部答完 answered=true |

## 四、预期行为（不是 bug）

- **重启宿主后旧卡片按钮失效**：短引用注册表在进程内，重启即清；点击提示"已处理或已过期"。token TTL 本就 10 分钟，重启失效是既有语义。
- **多选在 TG 走编号不走卡片**：表单卡片回调未实测（规划书风险项），单选才是纯卡片交互。
- **超时永不代答**：任何情况下工具不会替用户选默认答案，answered=false 交还桌面。

## 五、问题反馈模板

```
场景 #：
预期：
实际：（截图 TG 侧消息卡片 / toast 文案）
宿主日志：dsh-notifier 相关 warn 行
```
