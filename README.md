# 模型之间 · AI 模型指南与对话

中文模型介绍、搜索与用途筛选；注册登录；登录后的 AI 流式对话、历史记录和每日额度。
前端使用 HTML/CSS/JavaScript，后端运行在 Cloudflare Workers，数据存储在 D1。

## 部署到你现有的 Cloudflare Worker

仓库已有 `wrangler.jsonc`，与 `my-website` Worker 和现有 `user-db` 对接：

- Worker 名称：`my-website`。
- 构建命令：`npm run build`。
- 部署命令：`npx wrangler deploy`（或 `npm run deploy`，它会先构建）。
- Node.js：22.13+，推荐 24。
- 入口：`worker.js`；公开资源目录：`dist`。
- D1 变量：`DB`，数据库：`user-db`；ID 已按站点所有者提供的值填写。

与旧版 Pages 部署不同，Worker 通过 `worker.js` 显式分发 `/api/*`，不依赖 Pages 自动识别 `functions/`。其余地址交给 `ASSETS`，聊天页面可通过 `/chat` 或 `/chat.html` 访问。SQL、后端代码及测试不会复制到公开资源目录。

Cloudflare 的 Git 集成会在提交后触发构建，但仍需确认部署成功；出现失败应查看部署日志。不要仅以“GitHub 推送成功”判断线上已生效。也不要继续使用旧的仅部署静态文件的命令（如 `wrangler deploy --assets`）。

## 启用真实模型调用

尚无 API Key 时，网站及账号功能可用，聊天页显示“AI 服务尚未启用”，不会发出模型请求。

准备好有可用额度的 OpenAI API 账户后：

1. 在 Cloudflare → Workers & Pages → `my-website` → Settings → Variables and Secrets 中新增 **Secret**。
2. 名称为 **`OPENAI_API_KEY`**，值填写你自己的 API Key。
3. 保存并应用/部署，然后在网站登录，打开“AI 对话”进行测试。

不要把密钥写入 HTML、JavaScript、GitHub 或聊天记录。生产代码仅从后端 `env.OPENAI_API_KEY` 读取密钥，调用地址固定为 `https://api.openai.com/v1/responses`，不会接受用户指定的 API 地址或模型。

默认模型是 `gpt-4.1-mini`，管理员可在 `wrangler.jsonc` 的 `OPENAI_MODEL` 中更换为账户可用的 Responses 模型。不要用不支持 `max_output_tokens` 的端点替代。API 按实际使用计费，与 ChatGPT 订阅分开。

## 额度与上下文

- 每个账号每天最多 **20 次**，全站每天最多 **200 次**，按 UTC 日期计数，北京时间 08:00 重置。
- 在 `wrangler.jsonc` 修改 `CHAT_DAILY_LIMIT` / `CHAT_GLOBAL_DAILY_LIMIT`，代码上限分别为 100 / 2000。
- 未登录、输入不合法或未配置 Key 时，不预留调用额度。
- 请求一旦预留额度，失败、超时、停止或全站额度耗尽也可能消耗个人次数；不自动退回，避免绕过成本控制。
- 单次问题最多 2000 字符；最多携带最近 12 条可用历史消息，合计输入上下文最多 12000 字符；输出上限 512 tokens，超时 60 秒。
- 每人同时最多生成一条回答；单个对话最多 100 条消息。侧边栏显示最近 50 个对话。
- 这些是调用次数与单次规模限制，不是精确的美元预算。可在 OpenAI 控制台结合用量监控和账户额度管理费用。
- 停止生成会取消上游请求并保存已收到的部分文字，但不保证撤销模型已经产生的费用。

## 数据与隐私

沿用已有表：

```text
users: id, username, email, password_hash, nickname, created_at
sessions: token_hash, user_id, expires_at, created_at
```

新增 `chat_conversations`、`chat_messages`、`chat_usage`、`chat_locks` 表，在首次登录后的聊天 API 请求时自动创建。不会重建/删除已有账号表。`schema.sql` 提供完整幂等建表脚本供新数据库使用。

每次历史查询、发送和删除均校验登录及对话归属。对话记录保存在 D1，删除会移除该对话及消息，不可恢复。额度记录独立保留，删除对话不会返还额度。页面直接以文字显示回答，不执行模型返回的 HTML。

每次模型调用会向 OpenAI 发送当前问题和受限的历史上下文，不发送账号邮箱或密码；使用 `store:false` 不创建可检索的 Responses 对象，但不等同于 OpenAI 的零数据留存承诺。网页已说明消息处理方式。

密码使用随机盐与 PBKDF2-SHA-256 摘要；会话有效期 12 小时，通过 Secure/HttpOnly/SameSite=Lax Cookie 传递随机令牌，D1 保存令牌摘要。邮箱暂不验证、不提供密码找回。原本地演示账号需重新注册。上线公开运营时还应根据实际情况完善邮箱验证、反滥用和隐私政策。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册：account、email、name、password |
| POST | `/api/auth/login` | 登录：account、password |
| GET | `/api/auth/me` | 当前账号 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/chat/quota` | 本人剩余额度、模型与服务状态 |
| POST | `/api/chat` | SSE 对话：message、conversationId（新对话可为 null） |
| GET | `/api/conversations` | 最近 50 个对话 |
| GET | `/api/conversations/:id` | 本人对话及消息 |
| DELETE | `/api/conversations/:id` | 删除本人对话及消息 |

写入请求必须同源。POST 使用 JSON。SSE 事件为 `meta`、`delta`、`done`、`error`；只有收到模型终止事件且记录保存成功才发送 `done`。中断/截断不会伪装为成功。

## 本地开发与测试

使用 Node.js 22.13+：

```sh
npm test
npm run build
npx wrangler d1 execute user-db --local --file=schema.sql
npx wrangler dev
```

本地默认使用模拟 D1；不加 `--remote`，不修改远程数据库。需要真实 AI 本地测试时，在忽略的 `.dev.vars` 中配置 `OPENAI_API_KEY`。没有 Key 时可以验证注册、登录、历史和服务未启用状态。

自动化测试使用原生 SQLite 和模拟上游流，不调用真实付费 API。覆盖认证、CSRF、请求大小、会话、对话归属、上下文、流式中文、额度、并发锁、停止生成和上游失败。

`wrangler.local.jsonc` 是保留的 Pages 本地开发配置。如果继续使用 Pages，可构建后通过 `npx wrangler pages dev dist --config wrangler.local.jsonc` 预览；生产 Worker 应使用默认的 `wrangler.jsonc`。

## 上线验证

确认 Cloudflare 部署成功、Bindings 中 `DB` 指向 `user-db`。登录后打开“AI 对话”，未配置 Key 应提示未启用；配置后发送一条测试消息，应逐步显示回答。刷新后历史仍在，退出后不可访问，换账号不可读取其他用户对话。查看 D1 的 chat_messages 和 chat_usage 表确认写入。
