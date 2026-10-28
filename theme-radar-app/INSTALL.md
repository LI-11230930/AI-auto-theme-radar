# 安装与模型连接

## 1. 启动

基础功能只需要Node 24.14以上的24.x，无需npm install。仓库根目录运行：

```sh
node theme-radar-app/tools/bootstrap.ts
```

打开 http://127.0.0.1:8767/ 。首次自动创建config.local.json，主题列表为空，并生成integrations内的本机MCP片段；重复运行不覆盖已有配置。Ctrl+C停止服务。Windows也可在本目录使用 ./start.ps1 -Mode configure 和 ./start.ps1 -Mode serve。

先查看网页顶部“开始使用 · 配置检查”：分别显示GitHub阅读、B站阅读和已有档案分析的前置条件，并提供配置入口。在theme-radar-app目录也可运行 `node src/cli.ts setup-check`。检查只核对本机配置、命令/脚本路径、凭据格式和可选模型文件，不调用模型、不访问上游、不发邮件；“本机前置条件满足”之后仍须用自己的账号完成真实读取。Windows仅发现cmd/bat包装命令时，请填实际exe或node加CLI脚本。

“运行只读能力自检”会访问已启用主题对应的平台，按自己的关键词、UID或配置仓库取有界样本；空主题时全部跳过，不自动播种测试内容。它与上述本机配置检查不同。“生成本地档案预览”则只使用已存档案和榜单，遵守你的邮件模板，生成后可查看；不调用模型、不建投递，预览会注明正文或榜单缺项。主题数量不限于开发时使用的七个。

## 2. 接入现有模型

网页开始兴趣轮次时，由config.local.json的defaultAgent指定后台分析器，默认DSH。已有MCP客户端的模型连接不等于后台DSH已经配置。

如果DSH CLI已经在PATH且自身headless模式能正常响应，可沿用默认runners.DSH.command=dsh。若使用桌面发行版和现有模型补丁，把自己已验证可运行的入口填写到配置，不要复制别人的密钥。例如：

```json
{
  "runners": {
    "DSH": {
      "command": "C:/path/to/node.exe",
      "prefixArgs": ["C:/path/to/dsh-desktop-host/lib/cli.js", "--patch", "C:/path/to/my-model.local.yml"],
      "env": {}
    }
  }
}
```

这是局部字段示例，应合并到已生成的配置，不要用它覆盖全部配置。prefixArgs不包含--profile或--json，程序会按场景添加。模型提供方、Jet Hub渠道和授权由使用者自己的DSH负责。

配置后在theme-radar-app目录运行 node src/cli.ts probe-agent DSH 做一次最小真实模型检查，会消耗少量模型用量。网页首次阅读也会实际调用模型。

桌面发行版可选使用 ./start-dsh.ps1 启动项目专用web profile，默认127.0.0.1:8789；仅生成项目补丁，不改全局profile。需要该发行版已具备web profile。-PrepareOnly只生成配置，-NoOpen不打开浏览器；./stop-dsh.ps1核对自有进程后停止。启动输出中带token的本机链接不要分享。

普通DSH CLI或发行版布局不同者，使用下一节通用MCP导入，不保证专用web启动器适配所有发行版。

## 3. 四种Agent宿主

configure后生成的integrations/DSH.mcp.json、WorkBuddy.mcp.json、TRAE.mcp.json提供stdio字段，Codex.config.toml提供TOML片段。按自己宿主的MCP设置导入或合并，不要覆盖已有配置文件。它们包含本机绝对路径，不能直接发给其他电脑使用。

自定义配置位置时，在启动前设置`THEME_RADAR_CONFIG`为你自己的JSON文件路径，再运行bootstrap。首次只在该位置创建配置；四宿主片段和专用DSH入口都会引用同一绝对路径，数据目录相对于该配置文件解析。指定文件丢失时直接报错，不会静默切换到默认账本；已有文件不会被初始化覆盖。更改此环境变量后应重新生成并导入相应片段。

实际调用radar_status，确认工具41项、service.restartRequired=false；统一任务还需operator.ready=true。operator.code=OPERATOR_REQUIRED时可调用radar_operator_start启动本机服务；版本或账本不符时按提示核对，不覆盖其他服务。升级后重连MCP进程。配置片段生成不等于客户端已接入。

DSH项目web入口已实测直接调用status与兴趣轮次；WorkBuddy已实测统一轮次领取/提交模型任务并冻结真实P1草稿（未发信），TRAE已实测查询/复用。Codex提供配置片段，但不同发行版实际入口与完整轮次仍需安装者核对。旧一键兴趣轮次仍使用配置的后台分析器；beta.6统一计划的attached模式则使用当前宿主自己的模型，通过同一next/submit协议完成。后台模式使用选定CLI，WorkBuddy没有已验证CLI时只支持attached。计划配置与自定义频率见 ../docs/AUTOMATION.md。

## 4. B站

验证台“B站连接”生成二维码，用自己的B站App扫码。凭据保存在本地.data/credentials，不从Chrome提取Cookie。平台可读字幕不需要Python或浏览器扩展。

可选ASR：在本目录建立Python3.9+虚拟环境，升级该环境pip，再安装bridges/requirements-asr.txt；Windows/Python3.9可用requirements-asr-win-py39.lock.txt。然后用该环境Python执行 tools/prepare-asr-model.py --download。模型固定提交并核对哈希，不包含在源码中。

在config.local.json的bilibili.asr填enabled=true、pythonCommand（该环境Python）和modelDir（本地模型目录）。先运行 node src/cli.ts asr-check <BV号> 生成对照并自行听辨。仅P1缺可读字幕时自动回退，限10分钟/32MiB/180秒；文字不足或识别失败跳过，不以标题和简介代替正文。机器转写不代表画面理解。

可选扩展见 ../browser-extension/README.md 。作者页点击“交给本地验证台”后核对主题再导入；只接收当前可见最多20条，不需要重新导字幕。不采集Cookie或评论。

## 5. GitHub与邮箱

公开GitHub可匿名读取，遇限流会中止；如需要可在启动进程前配置自己的GITHUB_TOKEN环境变量，仅授予所需公开仓库读取权限。不要写入源码或聊天。

邮件草稿准备无需打开真实投递。B站手动政策、Agent邮箱连接与GitHub SMTP说明见 ../docs/USAGE.md 和 integrations/WORKFLOW.md 。没有邮箱连接就保留草稿，不自动发送。

## 6. 升级与备份

验证台“数据库备份与恢复演练”可创建本机数据库快照，再在临时副本中逐表逐行校验15张表。演练会测试把发送中断记录标为“不确定”、作废旧运行租约并保留已送达记录，然后删除临时副本；不会替换正式账本、访问平台、调用模型或重发邮件。

命令行可用`node src/cli.ts backups create`创建托管备份、`node src/cli.ts backups`列出备份、`node src/cli.ts backup-check <backup.sqlite>`检查指定的固定备份。当前支持V2数据库、最大1GiB；不自动迁移旧版或较新schema。

这些是**数据库备份**，包含主题、档案、判断、反馈和投递去重；不包含登录凭据、模型文件、config.local.json、邮件模板、作者观察及尚未投递的冻结样张文件。完整搬迁另需保留自己的配置和.data目录。备份含个人内容，仅保存在本机，勿加入公开仓库。真正从旧备份切换前，应核对备份后新增的投递记录；本工具提供检查与演练，不提供网页直接覆盖还原。

更新前停止服务，运行 node src/cli.ts backup <备份文件>，另存本机config.local.json及所用模型补丁。升级时保留.data和配置，不用新默认覆盖。数据库首次打开会执行既有迁移。源码不提供整目录自动删除或强制覆盖升级。

常见问题：端口占用时先停止旧服务或修改operatorUrl；模型失败检查自己的CLI和渠道；B站鉴权失败重新核对连接；HTTP412/429停止并等待，不自动反复重试。详细限制见 ../docs/LIMITATIONS.md。

## B站阅读深度

在兴趣主题选择标准P1或扩展实际前三P。扩展每份视频正文最多15000字符，按连续5000字符分段进入同一模型任务；总材料预算50000字符。旧主题保持标准，档案显示实际提供范围和截断。语音与采样画面仍仅回退P1，不为P2/P3启动媒体识别。

## 开发灵感卡

侧边目录“开发灵感”准备当前Agent指令；需要新增radar_inspiration_list/prepare/submit/cancel四个MCP工具，升级后重连刷新工具列表。两来源实际正文阅读、租约提交和Markdown导出见[指南](../docs/INSPIRATION.md)。
