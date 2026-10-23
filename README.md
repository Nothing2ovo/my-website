# 模型之间 · AI 大模型探索指南

中文 AI 模型介绍网站，提供搜索、用途筛选、官方入口和注册登录。
前端为 HTML/CSS/JS；账号由 Cloudflare Pages Functions + D1 提供。

## Cloudflare Pages 部署

关联本 GitHub 仓库后，设置：

- 框架：None。
- 根目录：仓库根目录（留空）。
- 构建命令：`npm run build`。
- 构建输出目录：`dist`。
- Node.js：22.13 以上，推荐 24（可设置环境变量 `NODE_VERSION=24`）。
- D1 绑定：数据库选择 **user-db**，变量名使用 **DB**。代码也兼容已有的 `USER_DB` 或 `user-db` 变量名。如果绑定名为其他值，修改后端的 `database()` 函数或改为 `DB`。

`functions/` 保留在仓库根目录，由 Pages 单独编译；不要复制到 dist 作为静态文件。`dist/_routes.json` 让 `/api/*` 经过 Functions，其他资源走静态服务。不要仅使用 GitHub Pages（它无法执行此后端）。
生产/预览环境的数据库绑定分别配置；预览建议使用单独测试库。绑定变更后需要重新部署。
无需在仓库填写数据库 ID、密码或 Cloudflare API Token。

## 数据库

对接现有结构：

```text
users: id, username, email, password_hash, nickname, created_at
sessions: token_hash, user_id, expires_at, created_at
```

已有这两张表时无需重建。首次 API 请求自动添加用户名/邮箱唯一索引、会话过期索引和 `auth_rate_limits` 表，不删除原有数据。若已有重复用户名/邮箱，需要先处理重复记录，否则唯一索引创建会失败。`schema.sql` 是完整的可重复执行建表脚本，供新库和本地测试使用。

注册要求用户名（3–32 位字母/数字/下划线）、邮箱、昵称（2–20 字符）和密码（8–128 位）。用户名及邮箱规范为小写；邮箱暂不验证，也不提供密码找回。

密码格式为 `pbkdf2_sha256$100000$<随机盐>$<摘要>`，不保存明文。旧本地演示账号不会上传；前端会清除旧演示记录，需重新注册。已有其他密码格式的数据库账号不会自动转换。

会话有效期 12 小时。生产环境通过 Secure、HttpOnly、SameSite=Lax 的 `__Host-atlas_session` Cookie 传递随机令牌，D1 只保存令牌 SHA-256 摘要。退出删除对应数据库会话。接口包含预处理 SQL、同源检查和禁止缓存。注册每 IP 每 10 分钟最多 5 次，登录最多 30 次，计数保存在 D1；注册或登录成功时清理过期记录。高流量生产站点可进一步配置 Cloudflare WAF/Turnstile。

## API

| 方法 | 地址 | 请求 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ "account": "your_name", "email": "you@example.com", "name": "昵称", "password": "..." }` |
| POST | `/api/auth/login` | `{ "account": "your_name", "password": "..." }` |
| GET | `/api/auth/me` | 返回 `{ "user": null }` 或当前用户 |
| POST | `/api/auth/logout` | `{}` |

POST 使用 `Content-Type: application/json`，Origin 必须与网站相同。前端已处理 Cookie、错误、超时和登录状态恢复；不再在 localStorage 保存账号或登录令牌。

## 本地验证

使用 Node.js 22.13+。测试使用原生 SQLite，无需安装测试依赖：

```sh
npm test
npm run build
```

完整本地预览使用官方 Wrangler：

```sh
npx wrangler d1 execute user-db --local --config wrangler.local.jsonc --file=schema.sql
npx wrangler pages dev dist --config wrangler.local.jsonc
```

`wrangler.local.jsonc` 中的数据库 ID 是本地占位符，上述命令只使用本地模拟数据库，不修改生产 D1。请勿用此本地配置执行远程部署。普通 `python -m http.server` 只能预览布局，不能执行账号 API。

## 上线检查

等待 Pages 部署后，注册新账号并确认 D1 的 users 表新增一行；刷新应保持登录，退出后 `/api/auth/me` 应返回 `user: null`。若 API 返回 HTML，检查构建设置与 functions 目录；若返回 503，检查 D1 绑定、表结构及 Functions 日志。

参考：[Cloudflare Pages D1 绑定](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases)、[Functions 路由](https://developers.cloudflare.com/pages/functions/routing/)。
