# 模型之间

打开首页即可聊天。支持登录、模型选择、流式回答、停止生成、历史记录和每日额度；原来的模型介绍保留在 `/models`。

## Cloudflare Workers 部署

GitHub 仓库已关联 `my-website` Worker。部署命令保持 `npx wrangler deploy` 即可；`wrangler.jsonc` 的 `build.command` 自动执行 `npm run build` 生成公开资源到 dist。

- Worker 入口：`worker.js`。
- D1：变量名 `DB`，现有数据库 `user-db`，ID 已按站点所有者提供的值配置。
- Workers AI：变量名 `AI`，由 `wrangler.jsonc` 的 `ai.binding` 自动配置。
- 不再调用 OpenAI API，不需要 `OPENAI_API_KEY`。
- Node.js 22.13+，推荐 24。

Workers AI 首次使用若要求接受平台条款或启用服务，请由账户所有者在 Cloudflare 控制台完成。仓库提交只确认代码已上传，线上是否生效须检查部署结果。

## 模型

| 页面名称 | Workers AI 模型 |
| --- | --- |
| Qwen3（默认） | `@cf/qwen/qwen3-30b-a3b-fp8` |
| GLM 4.7 Flash | `@cf/zai-org/glm-4.7-flash` |
| Llama 3.3 | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

后端按白名单解析模型，不能传任意付费模型或地址。每段对话固定一个模型；切换模型请新建对话。模型记录在 D1 的 conversation.model 和 assistant message.model 中。旧版 OpenAI 历史可查看/删除，需要继续聊天时新建对话。

Cloudflare 当前提供每日 10,000 Neurons 免费额度，由账户内调用共同消耗，不等于 10,000 次对话。模型价格、可用性和免费套餐支持可能变化，以官方目录和控制台为准。免费计划额度耗尽时会失败；付费计划超出免费额度可能计费。本程序不自动升级套餐，也不会在模型失败时回退至 OpenAI 或其他付费服务。

官方：[模型目录](https://developers.cloudflare.com/workers-ai/models/)、[定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[AI 绑定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)。

## 额度与数据

- 所有模型共用本站额度：每人每天 20 次、全站每天 200 次；UTC 日期计数，北京时间 08:00 重置。
- 可通过 `CHAT_DAILY_LIMIT` / `CHAT_GLOBAL_DAILY_LIMIT` 调整；代码上限为 100 / 2000。
- 未登录、模型无效、输入无效或无 AI 绑定时，不预留调用额度。预留后发生错误或停止也可能消耗次数。
- 单次问题最多 2000 字符；最多携带最近 12 条可用历史，合计上下文最多 12000 字符；输出最多 512 tokens；超时 60 秒。
- 每个用户最多同时生成一条回答；每段对话最多 100 条消息，侧边栏显示最近 50 个对话。
- 账号/会话沿用 users、sessions；聊天表及 conversation.model 列在首次聊天 API 调用时自动创建/迁移，不重建原有数据。
- 对话归属由后端校验，模型输出以纯文本显示。删除操作移除对话和消息，不能恢复，且不返还额度。
- 消息与受限上下文发送给 Cloudflare Workers AI；历史保存在 D1。页面“使用说明”可查看相关信息。
- 密码使用随机盐与 PBKDF2-SHA-256 摘要；登录会话 12 小时，使用 HttpOnly/Secure/SameSite=Lax Cookie。邮箱暂不验证、不提供找回密码。

## 本地开发

```sh
npm test
npx wrangler d1 execute user-db --local --file=schema.sql
npx wrangler dev
```

`wrangler dev` 自动构建。本地 D1 不影响线上，但 AI 绑定可能调用真实 Cloudflare 推理并消耗账户额度；运行前确认账户权限与额度。自动化测试的 AI 绑定完全模拟，不访问真实模型。

如继续使用旧 Pages 项目，需要在 Pages 控制台另行添加 `AI` 绑定；主站使用 Worker。`wrangler.local.jsonc` 仅用于保留的 Pages 本地开发流程。

## API

认证：`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`。

聊天：

- `GET /api/chat/quota`：返回模型目录、本人额度、服务状态。
- `POST /api/chat`：JSON 包含 message、model（如 qwen3）、conversationId（新对话为 null）。
- `GET /api/conversations`：最近 50 个本人对话。
- `GET /api/conversations/:id`：本人对话和消息。
- `DELETE /api/conversations/:id`：删除本人对话。

写入请求要求同源。前端 SSE 为 meta/delta/done/error；服务端兼容 Workers AI 的 choices.delta.content 与 response 两种流格式，只有终止事件到达且数据库保存成功才返回 done。中断、超时、长度截断和额度不足均不会冒充成功。

## 上线检查

确认 Worker 部署成功，Bindings 中存在 DB 与 AI。打开主域名即显示聊天框，登录后选择一个模型发送简单问题；检查流式回答、刷新历史与模型固定，再验证退出后的权限清除。
