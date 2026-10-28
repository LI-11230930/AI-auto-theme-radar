# 使用指南

beta.6建议使用[统一任务](AUTOMATION.md)配置宿主、频率和统一邮件；下列为继续兼容的单平台手动入口。

## B站：一次手动轮次

先完成扫码与后台模型配置。在验证台“兴趣自主阅读”选择主题并开始一轮，或在仓库根目录运行：

```sh
node theme-radar-app/src/cli.ts interest-round bilibili-interest-tools
```

程序取得最多20候选、预筛后最多读3条视频（默认P1，主题可选扩展读取实际前三P、每份正文最多15000字符并分段）。平台字幕优先；可选ASR只用于P1缺字幕的情况。正文不足跳过模型，材料仍保留。相同材料与主题可复用历史有效判断。结束返回草稿链接；不自动发信。

作者订阅在主题设置选择作者模式并填UID。公开投稿接口可能返回访问拒绝；可以在作者投稿页用扩展“交给本地验证台”，核对主题再导入。导入链接不等于读过视频，后续逐条核对UID与正文。

## GitHub：自选主题与两种榜单

首次配置不预置主题。在网页创建自己的GitHub主题，选择关键词、排除词和平台后，在本地config.local.json填自己的recipient邮箱，用已配置模型准备：

```sh
node theme-radar-app/src/cli.ts run
```

命令只准备内容与账本，不调用send。输出中的state=prepared才代表生成可投递内容；needs_validation表示有缺失，检查errors并保留失败。日榜与周榜独立取得、排序和生成中文简介，不拿累计Star替代周期新增Star；未知值不填零。

匿名额度不足时可以向启动进程提供自己的GITHUB_TOKEN环境变量。个人安装若不准备GitHub邮件，可不设置recipient，只使用读取、档案和B站草稿功能。

## B站邮件：使用Agent的邮箱连接

默认不启用。需要宿主已连接自己的邮箱，并明确允许发送。把theme-radar-app/interest-mail-policy.example.json复制到本地数据目录interest-mail-policy.json，填写本人相同的from与recipient、enabled=true、当前ISO时间approvedAt和approvalSource="explicit_user"。这只是本地授权声明，仍需核对邮箱身份。

交给Agent执行本轮读取后，按 [WORKFLOW](../theme-radar-app/integrations/WORKFLOW.md) 领取一次发送、调用自己的邮箱工具、记录提交结果。没有邮箱连接就停在草稿。每轮最多1次，每个北京时间自然日最多2次，每封最多3条，未知结果不自动重发。不要把此策略用于后台定时触发。

## GitHub邮件：可选SMTP

使用自己的SMTP账户，在config.local.json设置recipient、email.from、host、port、username和passwordEnv；发送密码仅放到passwordEnv指定的进程环境变量。默认端口465，桥接使用SMTP SSL。普通邮箱密码未必可用于SMTP，按发件服务支持的授权方式配置。

只有本人确认后才打开runtimeEnabled与email.enabled。先用自己的测试环境核对发件身份、接收地址及预览，再对prepared的deliveryId执行：

```sh
node theme-radar-app/src/cli.ts send <deliveryId>
```

需要Python可执行文件在PATH。发送命令拒绝模拟、验证专用、内容不完整或已尝试的投递。SMTP submitted只代表服务接受，实际到达仍需邮箱核对。程序不会自动注册09:00/18:00任务；这两个时间用于批次与时区配置。

## 档案、反馈与备份

网页支持按BV号、仓库链接、证据ID与标题/正文检索。材料、模型实际引用和未读范围分开保存。用户反馈先预览规则再应用；主题后续变化时重新预览。归并只把同一项目引用放在一起，不代表两来源相互证明。

在theme-radar-app目录执行 node src/cli.ts backup <输出.sqlite>，备份已保存数据；另外保管config.local.json、凭据和模型配置。不要把这些文件提交到GitHub。
