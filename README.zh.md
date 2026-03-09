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

## 自定义查询词库

编辑 `data/queries.ts`，替换为与你的机器人相关的问题。词库大小不限，运行时随机抽取。

```typescript
export const QUERIES: string[] = [
  "退款政策是什么？",
  "如何联系客服？",
  // ...
];
```
