# 安装与模型连接

## 1. 启动

基础功能只需要Node 24.14以上的24.x，无需npm install。仓库根目录运行：

```sh
node theme-radar-app/tools/bootstrap.ts
```

打开 http://127.0.0.1:8767/ 。首次自动创建config.local.json，主题列表为空，并生成integrations内的本机MCP片段；重复运行不覆盖已有配置。Ctrl+C停止服务。Windows也可在本目录使用 ./start.ps1 -Mode configure 和 ./start.ps1 -Mode serve。

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

实际调用radar_status，确认工具30项和service.restartRequired=false。升级后重连MCP进程。配置片段生成不等于客户端已接入。

DSH项目web入口已实测直接调用status与兴趣轮次；WorkBuddy已实测领取/提交阅读判断，TRAE已实测查询/复用。Codex提供配置片段，但不同发行版实际入口与完整轮次仍需安装者核对。WorkBuddy/TRAE的交互阅读可使用当前宿主模型；一键兴趣轮次仍使用配置的后台分析器。

## 4. B站

验证台“B站连接”生成二维码，用自己的B站App扫码。凭据保存在本地.data/credentials，不从Chrome提取Cookie。平台可读字幕不需要Python或浏览器扩展。

可选ASR：在本目录建立Python3.9+虚拟环境，升级该环境pip，再安装bridges/requirements-asr.txt；Windows/Python3.9可用requirements-asr-win-py39.lock.txt。然后用该环境Python执行 tools/prepare-asr-model.py --download。模型固定提交并核对哈希，不包含在源码中。

在config.local.json的bilibili.asr填enabled=true、pythonCommand（该环境Python）和modelDir（本地模型目录）。先运行 node src/cli.ts asr-check <BV号> 生成对照并自行听辨。仅P1缺可读字幕时自动回退，限10分钟/32MiB/180秒；文字不足或识别失败跳过，不以标题和简介代替正文。机器转写不代表画面理解。

可选扩展见 ../browser-extension/README.md 。作者页点击“交给本地验证台”后核对主题再导入；只接收当前可见最多20条，不需要重新导字幕。不采集Cookie或评论。

## 5. GitHub与邮箱

公开GitHub可匿名读取，遇限流会中止；如需要可在启动进程前配置自己的GITHUB_TOKEN环境变量，仅授予所需公开仓库读取权限。不要写入源码或聊天。

邮件草稿准备无需打开真实投递。B站手动政策、Agent邮箱连接与GitHub SMTP说明见 ../docs/USAGE.md 和 integrations/WORKFLOW.md 。没有邮箱连接就保留草稿，不自动发送。

## 6. 升级与备份

更新前停止服务，运行 node src/cli.ts backup <备份文件>，另存本机config.local.json及所用模型补丁。升级时保留.data和配置，不用新默认覆盖。数据库首次打开会执行既有迁移。源码不提供整目录自动删除或强制覆盖升级。

常见问题：端口占用时先停止旧服务或修改operatorUrl；模型失败检查自己的CLI和渠道；B站鉴权失败重新核对连接；HTTP412/429停止并等待，不自动反复重试。详细限制见 ../docs/LIMITATIONS.md。
