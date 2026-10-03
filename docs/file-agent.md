# 受限文件任务引擎

`server/file-agent.mjs` 提供两条明确区分的路径：

- `mode: "files"`：用户手工指定列出、读取或新建文本。执行真实本地操作，完全不取 OAuth token、不请求模型、不上传文件。
- `mode: "agent"`：通过本应用明确授权的 ChatGPT OAuth 请求模型规划。模型只能建议 `workspace.list_files`、`workspace.read_file`、`workspace.create_file`。每个建议都必须得到新的单次用户批准，才交给 `FileTools.execute`。

本模块不提供 shell、MCP、远程电脑控制、Android 控制、任意路径、覆盖、删除或自动审批。文件路径、符号链接、硬链接、扩展名、目录身份和原子新建限制由 `FileTools` 再次强制检查。新建内容限制为 UTF-8 128 KiB。

当前执行器固定启动 `/usr/bin/python3 -I -S scripts/file-tools.py`，不继承用户模块、site配置或父环境，只接受标准输入JSON。POSIX操作使用固定目录FD，macOS原子发布只绑定系统 `renameatx_np` 的不可覆盖形式。此前本地编译Swift产物出现签名磁盘验证有效但启动被SIGKILL的情况，原因未确定；当前不运行该产物，也不自动回退。没有改变系统权限或安装软件。`scripts/file-tools.swift`仅保留为参考。

## 接口

```js
const agent = new FileAgent({ fileTools, getAccessToken, fetchImpl, onEvent });

// 同步校验后立即返回状态。后续错误通过事件报告。
agent.start({
  taskId: 'task_1', mode: 'files', prompt: '创建一份笔记',
  operation: 'create_file', args: { name: 'notes.txt', content: '待确认的全文' },
  confirmed: true,
});

agent.decide({ approvalId, decision: 'accept' }); // 或 decline
await agent.cancel();
await agent.close();
```

`agent` 路线把 `operation/args` 换为已从账户目录选择的 `model`。`start` 的无效入参、缺少确认、任务忙碌会同步抛出；合法启动立即返回。后台运行错误发 `error` 和终态事件，不会留下未处理的 Promise 拒绝。`status()` 返回 `mode`、`taskId`、`status`、`busy`、轮次、工具数和当前审批副本。

`onEvent` 使用 `state`、`progress`、`delta`、`approval`、`approval-resolved`、`completed`、`error`。状态中的 `awaiting-approval` 由 HTTP 层映射为 UI 的 `needs_approval`。`progress.kind === "result"` 附带 JSON 安全的 `result` 和供展示的 `message`，手工模式也有可见执行结果。

## 单次审批和取消

审批包含 `id/title/detail/operation/args/hash/expiresAt`。`args` 从执行器规范化结果深复制并冻结，SHA-256 摘要绑定任务、审批 ID、操作、参数和过期时间。展示给订阅方及 `status()` 的是副本。客户端只能传审批 ID 和 accept/decline，不能覆写操作参数。ID 在决定时立即消费，重放、错误 ID、未知字段和过期批准均拒绝。

读取审批明确告知：agent 模式下，批准的完整文件文本会发送给 OpenAI 继续该任务。列出结果中的文件名也会传给模型。新建审批展示完整内容及字节数。拒绝后不执行该动作，也不再审批或执行后续动作；把拒绝结果传回模型，下一轮仅允许文字收尾。

默认任务期限 5 分钟、审批有效期 2 分钟。任意时刻只有一个审批和一个文件执行。最多请求 6 轮模型、处理 6 个工具调用；第 6 轮强制纯文字收尾，因此最多有 5 个可提出操作的模型轮次。同轮多个工具仍逐次审批、串行执行。

取消会中止待处理模型流、使当前审批失效并阻止下一动作。已批准且正在提交的新建可能已完成原子写入，取消不能撤回它。引擎会显示这个边界，等待执行器退出；若实际结果随后返回，仍显示结果并标注 `cancelledAfterExecution`，不会把已创建文件说成未执行。收尾期间保持 `busy`，禁止另一个任务与它并发。

## 官方模型协议

固定请求 `POST https://api.openai.com/v1/responses`，`redirect: "error"`，只使用显式注入的 OAuth token。请求设置 `store:false`、`stream:true`、`parallel_tool_calls:false`，完整历史保存在本次任务内存中并随 `input` 重发，不使用 `previous_response_id` 或服务端会话存储。所有函数都包在 `workspace` namespace。SIWC 预览的 HTTP、工具和参数要求见 [官方预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

只有收到 `response.completed` 且内部 `status:"completed"` 后，才解析完整 `output`。函数流中的参数碎片和 `output_item.done` 都不能触发执行。仅接受独立的 `namespace:"workspace"` 与白名单函数 `name`；工具结果通过 `function_call_output.call_id` 匹配。规则依据 [函数调用指南](https://developers.openai.com/api/docs/guides/function-calling) 与 [官方 namespaced 返回示例](https://developers.openai.com/api/docs/guides/tools-tool-search#hosted-tool-search)；本项目没有启用后者页面中的 tool_search。

引擎原样保留上游实际返回的 reasoning 输出（包括存在时的 `encrypted_content`），随下一轮历史重发。当前[官方 Responses reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)说明，`store:false` 时 reasoning 默认包含加密内容，`include:["reasoning.encrypted_content"]` 仅为兼容旧客户端而接受，并非必需，因此本请求省略 `include`。SIWC 预览文档没有单独说明该字段；本项目已通过模拟响应验证原样重放，尚未验证真实 SIWC 账户的返回行为，不声称已完成线上端到端验证。

模型指令明确把文件内容和工具输出视作不可信数据，不得遵循其中更改权限或目标的指令；实际权限仍由代码与逐次审批强制执行。

## 离线验证范围

运行 `node --test test/file-agent.test.mjs`。测试使用假的 OAuth token、假 SSE 和注入的文件执行器，覆盖严格请求形状、历史/函数结果关联、单次不可变审批、审批过期、拒绝、未知工具、任务与轮次上限、HTTP/流失败、输出脱敏，以及取消与写入提交的竞态。它不建立真实授权、不请求真实模型。真实本地磁盘执行链路由服务端集成测试与 FileTools 测试覆盖；本模块测试通过不代表账户授权或线上模型已验证。
