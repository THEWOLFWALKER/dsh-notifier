# Third-Party Notices

dsh-notifier 零运行时依赖（仅用全局 `fetch` + `node:crypto`）。以下项目的**渠道协议知识**
（端点、body 字段、成功判定语义）在本仓库实现中被参考或移植；移植原则是「移植协议知识、
不引依赖」——把参考实现中的 `axios.post` 机械改写为零依赖 `fetch`。

## CaoMeiYouRen/push-all-in-one（MIT License）

- 来源仓库：https://github.com/CaoMeiYouRen/push-all-in-one
- 参考文件：`src/push/discord.ts`、`src/push/wechat-robot.ts`、`src/push/wechat-app.ts`、
  `src/push/ntfy.ts`、`src/push/one-bot.ts`、`src/push/push-deer.ts`、`src/push/xi-zhi.ts`、
  `src/push/qmsg.ts`、`src/push/i-got.ts`
- 移植范围：上述渠道的请求格式与成功判定；其 vitest 断言被用作契约测试 golden 参照。
- 原许可证（MIT）版权声明：

```
MIT License

Copyright (c) 2019-present CaoMeiYouRen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

## hclonely/all-pusher-api（Apache-2.0）

- 来源仓库：https://github.com/hclonely/all-pusher-api
- 参考文件：`src/Slack.ts`、`src/Chanify.ts`、`src/Pushover.ts`、`src/QQBot.ts`、
  `src/GoogleChat.ts`、`src/WorkWeixinBot.ts`
- 移植范围：Slack/Chanify/Pushover/Google Chat 的请求格式；QQ 官方机器人的
  `getAppAccessToken` 换取与 `Authorization: QQBot <token>` 鉴权流程。
- Apache-2.0 要求的声明：本仓库对上述文件的改写包含来自该项目的受版权保护的内容，
  依据 Apache License 2.0 授权使用；原件未随附 NOTICE 文件。
- 完整许可证文本见 https://www.apache.org/licenses/LICENSE-2.0

## 未参考代码、仅对标叙事

- caronc/apprise（MIT）：作为「通知底座」行业先例做架构对标，未移植任何代码。

## 生成义务

从上述来源移植协议逻辑的文件，须在文件头以注释标注来源仓库与参考 commit：
`// 端点/body/成功判定语义移植自 <repo>（<path>），改写为零依赖 fetch。`
