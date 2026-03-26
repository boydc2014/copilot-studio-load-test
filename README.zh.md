# Copilot Studio Agent 压力测试工具

基于 [DirectLine v3](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-concepts) 通道的 [Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/) 智能体压力测试框架。

每个虚拟用户独立发起一个对话，发送一条查询，轮询机器人响应并记录延迟。测试分两个阶段进行：先进行渐进式预热，再进行满并发的正式测试。

## 前置条件

- Node.js 18+
- 已启用 DirectLine 通道的 Copilot Studio 智能体
- 从 Copilot Studio 获取的 DirectLine 密钥（见下方说明）

## 获取 DirectLine 密钥

1. 打开 [Copilot Studio](https://copilotstudio.microsoft.com)，选择你的智能体
2. 进入 **设置** → **频道** → **DirectLine**
3. 在 **Web 通道安全性** 下，点击 **配置 Web 安全性**（或直接进入 **设置** → **配置 Web 安全性**）
4. 复制页面上显示的任意一个密钥

> 密钥是一串较长的字母数字组合，请像密码一样保管，不要提交到代码仓库。本项目的 `.gitignore` 已将 `.env` 排除在外，可防止意外泄露。

参考文档：[配置 Web 通道安全性](https://learn.microsoft.com/zh-cn/microsoft-copilot-studio/configure-web-security)

## 安装

```bash
git clone https://github.com/boydc2014/copilot-studio-load-test.git
cd copilot-studio-load-test
npm install
cp .env.example .env
```

编辑 `.env`，填入你的 DirectLine 密钥：

```
DIRECTLINE_SECRET=你的密钥
```

## 运行

```bash
# 使用 ts-node 直接运行（无需编译）
npm run dev

# 或先编译再运行
npm run build
npm start
```

## 配置项

所有配置通过 `.env` 文件中的环境变量设置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DIRECTLINE_SECRET` | *(必填)* | 从 Copilot Studio **配置 Web 安全性** 页面获取的 DirectLine 密钥 |
| `DIRECTLINE_BASE_URL` | `https://directline.botframework.com/v3/directline` | DirectLine 端点，国家云环境可覆盖此值 |
| `TARGET_CONCURRENCY` | `20` | 并发虚拟用户数 |
| `SKIP_WARMUP` | `false` | 设为 `true` 可跳过预热阶段，直接进入正式测试 |
| `WARMUP_COOLDOWN_SECONDS` | `120` | 预热与正式测试之间的等待时长（2 分钟）。设为 `0` 可禁用。`SKIP_WARMUP=true` 时自动跳过 |
| `WARMUP_DURATION_SECONDS` | `300` | 预热阶段时长（5 分钟）。虚拟用户在此期间逐步增加 |
| `TEST_DURATION_SECONDS` | `600` | 正式测试阶段时长（10 分钟） |
| `MAX_REQUESTS_PER_MINUTE` | `100` | 全局请求速率限制（所有虚拟用户共享），防止触发服务限流 |
| `POLL_INTERVAL_MS` | `1000` | 轮询机器人响应的间隔（毫秒） |
| `RESPONSE_TIMEOUT_MS` | `30000` | 等待机器人响应的超时时间，超时后标记为超时失败 |
| `OUTPUT_FILE` | `./results/load-test` | 输出路径前缀，每次运行会在该目录下创建一个带时间戳的子文件夹 |

## 工作原理

### 测试阶段

**预热阶段**（默认 5 分钟）
从 1 个虚拟用户开始，按固定间隔逐步增加，直到达到 `TARGET_CONCURRENCY`。用于在正式测试前预热机器人底层基础设施。

**冷却阶段**（默认 2 分钟）
预热与正式测试之间的可配置暂停时间，让机器人在正式计量前充分稳定。`SKIP_WARMUP=true` 或 `WARMUP_COOLDOWN_SECONDS=0` 时自动跳过。

**正式测试阶段**（默认 10 分钟）
所有 `TARGET_CONCURRENCY` 个虚拟用户同时启动（各错开约 100ms，避免瞬时洪峰）。每个用户持续循环发起对话，直到计时结束。

### 单次对话流程

```
1. POST /conversations                  → 创建对话，获取 token
2. POST /conversations/{id}/activities  → 发送用户消息  ← 延迟计时开始
3. GET  /conversations/{id}/activities  → 每隔 POLL_INTERVAL_MS 轮询一次
   └─ 直到收到机器人消息               ← 延迟计时结束（使用机器人回复的服务端时间戳）
```

延迟从发送用户消息起，到机器人回复的服务端时间戳止——不含轮询间隔带来的误差。

### 虚拟用户与查询词

`data/queries.ts` 文件包含 100 条多样化的查询词库。每个虚拟用户在每次对话时独立从词库中随机抽取一条——词库不会被拆分或分配给各虚拟用户。

### 速率限制

所有虚拟用户共享一个滑动窗口限速器。每次发起对话前，虚拟用户需先获取令牌。若过去 60 秒内的请求数已达 `MAX_REQUESTS_PER_MINUTE`，则等待直到有容量释放。当前速率会显示在每条进度日志中。

## 输出结果

每次运行在 `results/` 目录下创建一个带时间戳的文件夹：

```
results/
└── run-2024-03-08T10-00-00-000Z/
    ├── summary.json        — 预热和正式测试的汇总指标
    ├── results.csv         — 每条对话一行的明细数据
    └── conversations.jsonl — 每条对话的完整 DirectLine 消息记录
```

### `summary.json`

```json
{
  "warmup": {
    "totalConversations": 1774,
    "successCount": 1774,
    "timeoutCount": 0,
    "errorCount": 0,
    "successRate": 1.0,
    "throughputRps": 5.88,
    "latency": {
      "p50": 1396,
      "p95": 1541,
      "p99": 2502,
      "min": 1353,
      "max": 5942,
      "mean": 1451
    },
    "durationMs": 301000
  },
  "test": { ... }
}
```

### `results.csv`

| phase | startedAt | status | latencyMs | query | conversationId | errorMessage |
|---|---|---|---|---|---|---|
| test | 1709888400000 | success | 1392 | How do I reset my password? | abc123 | |

### `conversations.jsonl`

每行一个 JSON 对象，包含该对话的完整 `activities` 数组（DirectLine 原始消息序列），可用于验证机器人的实际回复内容。

```jsonl
{"phase":"test","status":"success","latencyMs":1392,"query":"How do I reset my password?","conversationId":"abc123","activities":[{"id":"...","type":"message","from":{"id":"vuser-...","role":"user"},"text":"How do I reset my password?","timestamp":"..."},{"id":"...","type":"message","from":{"id":"bot","role":"bot"},"text":"To reset your password...","timestamp":"..."}]}
```

## 控制台输出

每 15 秒打印一次进度：

```
[TEST    2:30] Workers: 20/20 | Conversations: 1693 | Success: 100.0% | p95: 1522ms | rate: 87/min
```

每个阶段结束后打印汇总表格：

```
╔══════════════════════════════════════════════════╗
║          LOAD TEST RESULTS — TEST PHASE          ║
╠══════════════════════════════════════════════════╣
║  Duration              10m 01s                   ║
║  Total Conversations   6840                      ║
║  Successful            6840  (100.0%)            ║
║  Timed Out             0  (0.0%)                 ║
║  Errors                0  (0.0%)                 ║
║  Throughput            11.37 req/s               ║
╠══════════════════════════════════════════════════╣
║  LATENCY (ms)                                    ║
║    Min                 1349                      ║
║    Mean                1422                      ║
║    p50                 1392                      ║
║    p95                 1510                      ║
║    p99                 2440                      ║
║    Max                 4275                      ║
╚══════════════════════════════════════════════════╝
```

## SSO 支持

如果你的 Copilot Studio 智能体需要用户身份验证（SSO），可启用 SSO 模式来模拟已认证用户通过 DirectLine 通道进行交互。

### 何时使用 SSO 模式

当你的机器人在对话开始时触发登录主题（sign-in topic）时，请使用 SSO 模式。此时机器人会在响应正式查询前发送 OAuthCard。若不启用 SSO，每次对话都会因等待机器人完成认证步骤而超时。

### 工作原理

当 `SSO_ENABLED=true` 时，每次对话在发送正式查询前会执行 SSO 预处理流程：

```
1. POST /conversations?sendWelcomeMessage=true  → 机器人收到 conversationUpdate，触发登录主题
2. 从 Azure AD 获取 OAuth2 令牌              → 在多次对话间缓存复用
3. 轮询直到机器人发送 OAuthCard
4. POST signin/tokenExchange invoke            → 向机器人交换令牌
5. 轮询直到 invoke 响应状态为 200
6. → 发送正式查询（延迟计时从此处开始）
```

延迟仍仅从用户查询开始计算，SSO 预处理时间不计入延迟。

### 获取 Azure AD 凭据

1. **SSO_TENANT_ID** — Azure AD 租户 GUID。在 **Azure 门户** → **Azure Active Directory** → **概述** → *租户 ID* 中查找。
2. **SSO_CLIENT_ID** — 应用注册的客户端 ID。在 **Azure 门户** → **应用注册** 中找到你的机器人对应的应用注册，复制*应用程序（客户端）ID*。
3. **SSO_CLIENT_SECRET** — 在 **应用注册** → 你的应用 → **证书和机密** → **新建客户端机密** 中创建。
4. **SSO_SCOPE** — 请求的 OAuth 作用域。对于 Copilot Studio SSO，通常为 `api://<机器人应用ID>/.default`。

### 授权类型说明

| `SSO_GRANT_TYPE` | 适用场景 | 行为 |
|---|---|---|
| `auth_code` *(默认)* | 交互式用户登录（支持 MFA）；即使公司禁用设备码也可使用 | CLI 打开浏览器标签页；你完成登录后 Azure AD 自动重定向回 `localhost` |
| `device_code` | 通过 URL 和验证码完成的交互式用户登录（支持 MFA） | CLI 打印 URL 和验证码；你在浏览器中完成一次登录；令牌在本次运行中缓存复用 |
| `client_credentials` | 机器人接受应用级令牌（服务账号/非用户场景） | 使用客户端机密静默从 Azure AD 获取令牌 |
| `password`（ROPC） | 有专用测试账号的自动化流水线（必须关闭 MFA） | 使用存储的用户名和密码静默获取令牌 |

**授权码（PKCE）** 是默认模式——无需存储凭据，支持 MFA，且兼容禁用设备码的公司策略。

> **`auth_code` 配置** — 使用此流程前，需在 **Azure 门户 → 应用注册 → 你的应用 → 身份验证 → 添加平台 → 移动和桌面应用程序** 中注册 `http://localhost:3000/callback`（或 `http://localhost:{SSO_REDIRECT_PORT}/callback`）为重定向 URI。无需 `SSO_CLIENT_SECRET`（使用 PKCE）。

> 使用 `device_code` 和 `auth_code` 时，`SSO_CLIENT_SECRET` 均非必填（公共客户端）。某些机密应用注册可能仍需要此字段——若 Azure AD 返回相关错误，请设置该变量。

### SSO 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SSO_ENABLED` | `false` | 设为 `true` 以启用 SSO 模式 |
| `SSO_TENANT_ID` | *(SSO 启用时必填)* | Azure AD 租户 GUID |
| `SSO_CLIENT_ID` | *(SSO 启用时必填)* | 应用注册客户端 ID |
| `SSO_SCOPE` | *(SSO 启用时必填)* | OAuth 作用域，例如 `api://你的机器人应用ID/.default` |
| `SSO_GRANT_TYPE` | 自动检测 | `auth_code`（默认）、`device_code`、`client_credentials` 或 `password` |
| `SSO_CLIENT_SECRET` | *(空)* | `client_credentials` 和 `password` 时必填；`device_code` 和 `auth_code` 时可选 |
| `SSO_TIMEOUT_MS` | `10000` | 每个 SSO 轮询步骤的超时时间（毫秒） |
| `SSO_REDIRECT_PORT` | `3000` | `auth_code` 回调服务器的本地端口 |
| `SSO_USERNAME` | *(空)* | 测试用户 UPN——与 `SSO_PASSWORD` 同时设置时触发 `password` 授权 |
| `SSO_PASSWORD` | *(空)* | `password` 授权模式的测试用户密码 |

## 自定义查询词库

编辑 `data/queries.ts`，替换为与你的机器人相关的问题。词库大小不限，运行时随机抽取。

```typescript
export const QUERIES: string[] = [
  "退款政策是什么？",
  "如何联系客服？",
  // ...
];
```
