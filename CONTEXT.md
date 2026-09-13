# 术语表（Glossary）

本文件只收录领域术语，不收录实现细节。

## 反代（Reverse Proxy）

入站 HTTP 服务（`/v1/messages`、`/v1/chat/completions` 等 OpenAI/Anthropic/Gemini 兼容端点），把客户端请求翻译成 Kiro/CodeWhisperer 上游格式并回传。与 K-Proxy（出站设备号改写 MITM 代理）是两个不同概念，勿混用。

## 上游（Upstream）

AWS CodeWhisperer / Amazon Q Developer 的流式聊天端点。一次客户端请求可能依次尝试多个上游端点（端点故障转移），端点集合按账号区域与偏好端点排序。

## 账号池（Account Pool）

反代可用的 Kiro 账号集合，带断路器（指数退避冷却）、配额耗尽标记（1 小时）与长期封禁标记（需人工解封）三种不可用状态。

## 请求级尝试（Request-level Attempt）

一次客户端请求对上游的整体尝试次数预算（`maxRetries`，默认 3）。每次请求级尝试内部可再按上游端点列表做多端点故障转移。

## 首块（First Chunk）

上游产出的第一个内容事件。**首块前**客户端尚未收到任何字节，此时失败可以透明重试或以真实 HTTP 状态码报错；**首块后**字节已送达客户端，失败只能以 SSE error 事件收场、无法重试。

## 透明重试（Transparent Retry）

首块前失败时换账号/换端点/退避后重试，客户端完全无感知。仅对可重试错误类别生效。

## 错误分类（Error Classes，按重试语义）

- **网络瞬时错误（Transient Network Error）**: `fetch failed`、连接重置、DNS 失败等。与账号、请求内容无关 → 同号退避重试，持续失败切号。
- **上游过载（Upstream Overload）**: 5xx / `MODEL_TEMPORARILY_UNAVAILABLE` / high load。上游侧瞬时故障 → 同号退避重试，持续失败切号。
- **配额/限流（Quota/Throttle）**: 402/429/ThrottlingException 等。账号侧问题 → 记录配额耗尽并切号。
- **认证错误（Auth Error）**: 401/403。Token 问题 → 刷新 Token 同号重试，刷新失败切号。
- **封禁（Suspension）**: `TEMPORARILY_SUSPENDED` 等。长期状态 → 标记封禁并切号，刷新无效。
- **致命错误（Fatal Error）**: 400/422 等请求本身的问题 → 所有账号都会失败，不重试直接返回客户端。

## 端点故障转移（Endpoint Failover）

单次请求级尝试内部，按排序后的上游端点列表逐个尝试（如 CodeWhisperer → AmazonQ）。与账号切换（换账号池里的另一个账号）是两个层级的故障转移。
