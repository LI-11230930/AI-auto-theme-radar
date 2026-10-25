# 结构与数据流

```text
Agent宿主 ── stdio MCP ──┐
本地网页 ── HTTP/CSRF ───┼─ 主题/预算/租约 ── 平台读取 ── SQLite材料档案
CLI ────────────────────┘                                  │
                        当前宿主阅读 或 配置的后台模型 ◀────┘
                                      │
                               判断/引用/字符范围
                                      │
                            去重/配额 → 冻结邮件草稿
                                      │
                    邮箱宿主领取/报告 或 显式SMTP发送
```

- `src/bilibili*.ts`、`interest*.ts`：登录、正文取得、有界兴趣轮次与邮件交接。
- `src/github.ts`、`engine.ts`、`mail.ts`：公开仓库读取、日周榜、主题筛选和邮件准备。
- `src/store.ts`：SQLite存储、版本、租约、去重与投递状态；归档分析校验材料和主题版本。
- `src/mcp.ts`：30项stdio工具；`operator.ts`：本机网页服务。
- `src/runner.ts`：已有Agent CLI调用，控制时限、输出和取消；`bridges/`：可选Python语音/SMTP桥。
- `browser-extension/`：用户主动触发的可见内容取得，投稿清单交接不依赖Chrome调试通道。

基础Node程序没有外部npm运行依赖；二维码组件以源码附带。前端是原生HTML/CSS/JS。服务仅监听回环地址；配置、凭据、资料与模型在安装者本地数据目录。
