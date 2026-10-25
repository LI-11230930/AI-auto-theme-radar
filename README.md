# 主题雷达 · Theme Radar

让 Agent 按你的兴趣阅读 B站视频和 GitHub 项目，筛选后生成简洁中文邮件。

**v0.1.0-beta.2** · 本地优先 · Node 24 · SQLite · MCP · MIT

```text
兴趣主题 → 推荐/搜索 → 字幕或语音转写 → Agent筛选 → 中文摘要与流程示意 → 邮件草稿
                              ↓
                     可检索档案 · 去重 · 阅读记录
```

## 可以做什么

- **B站兴趣阅读**：登录后使用推荐和主题搜索，每轮最多20个候选、读取3条视频的P1；不限于固定UP主。字幕优先，可选本地 faster-whisper 语音回退。弹幕只作辅助材料，不读取评论。
- **作者订阅**：按UID区分作者；公共投稿接口受限时，可用扩展把当前可见链接直接交给验证台，再逐条核对真实UID和正文。
- **GitHub主题汇总**：用户自选主题，读取公开仓库资料；生成主题精选、Trending Daily前十和Weekly前十，附中文介绍、对应周期新增Star、累计Star与简短流程示意。Trending是GitHub公开展示顺序，不是全站项目新增Star的独立排名。
- **邮件与档案**：正文保持简洁，详细引用与阅读范围留在本地档案；支持检索、变化检测、反馈规则和跨来源归并。发信默认关闭，需要自己的SMTP或Agent邮箱连接。
- **多宿主接入**：提供DSH、WorkBuddy、TRAE和Codex的MCP配置片段，共用同一份本地SQLite数据。当前主要验证环境为Windows，DSH负责后台模型筛选。

## 启动仅需五分钟

安装 **Node 24.14以上的24.x**，下载源码后在仓库根目录运行：

```sh
node theme-radar-app/tools/bootstrap.ts
```

也可以使用 `npm start`。不需要先执行 `npm install`；基础功能没有外部npm运行依赖。命令首次创建空主题配置、生成MCP配置片段并启动验证台，重复启动保留配置。

打开 **http://127.0.0.1:8767/** ：

1. 在“B站连接”用自己的B站App扫码；连接只保存在本机。
2. 先在主题设置创建自己的主题，选择平台、关键词和排除词；作者订阅填写自己的UP主UID。
3. 按[安装说明](theme-radar-app/INSTALL.md)连接已有DSH模型渠道，或把生成的MCP片段导入自己的Agent。
4. 在“B站兴趣自主阅读”开始一轮，查看取得的正文、模型判断和草稿。

仅启动网页不等于配置好了模型。未配置模型时会返回明确错误；可以先运行离线演示：

```sh
node theme-radar-app/src/cli.ts demo
```

## 交给 Agent 的任务

先创建主题；以下示例topicId需替换成自己创建的主题ID。接入MCP后可使用：

> 按我的主题运行一轮主题雷达，topicId=bilibili-interest-tools。先检查radar_status，再调用radar_bilibili_interest_round。最多读取3条P1正文，返回精选与sample.absolutePreview。没有邮箱连接或已授权策略时只保留草稿；不要创建定时任务。

四宿主配置及邮件交接见[工作流](theme-radar-app/integrations/WORKFLOW.md)。DSH的模型授权与邮箱授权是两件事；本仓库不携带任何账号、模型密钥或邮箱连接。

## 自定义邮件

验证台的“自定义邮件内容与模板”可设置邮件标题、GitHub内容栏目与顺序、条目排版及页脚。可删去Star或流程占位符；B站标题、格式独立配置。收件人、SMTP和Agent邮箱连接由安装者设置，默认不发送。详见[自定义说明](docs/CUSTOMIZATION.md)。

## 邮件长什么样

GitHub邮件包含三部分：主题项目链接与简短中文介绍、Daily前十、Weekly前十。每项可附2至4节点的用途或运行示意；Star未知时保留未知。B站邮件包含视频链接/BV号、简短介绍和示意。示意图是材料概括，不表示执行过项目代码。

本地网页和兴趣CLI只生成草稿。B站手动邮件由具有邮箱连接的Agent执行领取、发送、记录结果，默认每轮1次、每天2次、每封3条；失败或结果不明不自动重发。GitHub SMTP需要另行启用配置。参考[使用指南](docs/USAGE.md)。

## 首版边界

| 能力 | 当前情况 |
| --- | --- |
| B站字幕、缺字幕P1语音回退、兴趣筛选 | 已有真实阅读与用户验收；ASR需另装Python和模型 |
| 扩展作者清单直接交接 | 0.3.2，主动提交当前可见链接 |
| GitHub Daily / Weekly与简洁正文 | 已实现；网络限流和页面变化可能中止采集 |
| DSH / WorkBuddy / TRAE | 已有各自真实调用证据，范围见安装说明 |
| Codex | 提供配置片段；不同发行版入口需自行核对 |
| 云端无人值守、任意多分P、画面理解、小红书 | 后续版本范围，不作为首版已完成能力 |

持续作者发现受平台接口限制；扩展只接收当前可见链接，不自动滚动全量投稿。阅读文字不等同于观看画面或核验视频中的新闻事实。[已知限制](docs/LIMITATIONS.md)列出首版范围。

## 开发与检查

```sh
npm test
node theme-radar-app/tools/check-installation.ts
python -m unittest discover -s theme-radar-app/tests -p smtp_bridge_test.py
```

测试使用临时数据库与模拟平台资料；不会调用真实模型或发送邮件。SMTP检查使用离线替身。CI覆盖Windows和Linux的自动化测试，不代表两个系统的真实账号全部验收。

目录：`theme-radar-app/`为程序与测试，`browser-extension/`为可选扩展，`docs/`为使用和发布说明。私有配置、Cookie、数据库、模型、邮件正文及开发过程档案不在发布目录中。

## 许可证与致谢

[MIT](LICENSE)。二维码组件保留原作者许可证，见[第三方说明](THIRD_PARTY_NOTICES.md)。

项目受 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 启发，将Agent兴趣阅读扩展为邮件与本地档案。DSH、模型渠道及可选ASR依赖需要使用者自行安装和授权。
