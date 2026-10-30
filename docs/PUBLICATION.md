# 上传个人公开仓库

本目录是可公开的独立源码目录。不要上传它的开发工程父目录，也不要把本机运行后产生的配置、.data、模型、JSON导出或邮件记录复制进来。仓库保留虚构资料的自动化测试，便于安装者和CI核对工具；个人实机记录不随源码发布。

## 网页建仓库，Git上传

1. 登录GitHub，点击“+”→“New repository”。Owner选自己的账号，名称可用theme-radar，选择Public。
2. 不要勾选初始化README、.gitignore或LICENSE，因为本地已经有这些文件。创建空仓库。
3. 在这个源码目录打开PowerShell，执行下列命令。把YOUR_USERNAME替换成自己的GitHub用户名；仓库名若不同也要替换。

```powershell
git remote add origin https://github.com/YOUR_USERNAME/theme-radar.git
git push -u origin main
git push origin v0.1.0-beta.35
```

浏览器登录不一定等于Git命令行已认证。若Git弹出账户授权，使用自己的账号完成；不要把令牌写入命令或源码。也可用GitHub Desktop添加此本地仓库，再Publish repository，并取消Keep this code private。

## 开源展示

上传后首页会显示README，MIT由根目录LICENSE声明。编辑About，可用简介“按自定义主题阅读B站与GitHub，由Agent筛选并生成邮件摘要”，并添加mcp、ai-agent、automation、bilibili等相关Topics。

进入Releases → Draft a new release，选择v0.1.0-beta.17标签，标题可用“Theme Radar v0.1.0-beta.17”；版本说明参考CHANGELOG.md。可附源码ZIP。Actions第一次在GitHub运行后检查结果；本地通过不代替托管运行。

官方指引：https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github

## 发布目录的边界

源码不包含开发者邮箱、作者订阅、私人站点、本机路径、配置、Cookie、模型、数据库、实机截图、邮件正文或私有开发提交。首次创建仓库时只提交清理后的源码；更新已有公开仓库时保留其提交历史，增量提交并添加新版本标签，不强推或覆盖旧标签。所有账号由安装者在自己的机器上配置；自动运行数据目录已加入.gitignore。
