# 由使用者设置的内容

首次启动不预置主题、UP主、账号、邮箱或邮件授权。网页创建主题后才可采集。模型、B站登录、邮箱连接与可选ASR均使用安装者自己的配置。

## 主题与可推送内容

在主题设置填写名称、兴趣描述、关键词、排除词与平台。B站可选不限UP兴趣推荐、关键词搜索或按作者UID过滤；停用主题就不参与之后的采集。GitHub仓库按自己的主题筛选，不自动导入开发者主题。

需要批量导入时，在theme-radar-app目录运行 node tools/import-topics.ts <自己的JSON文件>，文件可以是一个主题或主题列表。主题结构以网页保存后的本地配置为参考。

## 邮件模板

网页“自定义邮件内容与模板”提供可编辑JSON，保存到本地.data/mail-template.json。也可复制mail-template.example.json到该位置后修改。保存不会启用投递。

| 字段 | 作用 |
| --- | --- |
| github.sections | 从projects、daily、weekly中选取并排列栏目；可只选主题项目或只选周榜 |
| github.subject | GitHub邮件标题，支持{date}与{slot} |
| github.titles | 各栏目的显示标题 |
| github.entry | 每个项目的条目格式 |
| bilibili.subject/title/entry | 视频邮件的标题、正文标题与条目格式 |
| footer | 自己的纯文本页脚，可留空 |

条目支持{index}、{title}、{url}、{summary}和{flow}；GitHub另支持{stars}。可以删掉Star或流程、改变顺序和换行，但必须保留{url}与{summary}。例如只保留链接和简介：

```json
{
  "github": {
    "sections": ["projects"],
    "subject": "我的项目周刊 {date}",
    "entry": "{title}\n{url}\n{summary}"
  },
  "bilibili": {
    "title": "今日视频",
    "entry": "{title}\n{url}\n{summary}"
  },
  "footer": ""
}
```

模板字段为文本，不执行HTML、脚本或任意表达式。已冻结草稿使用生成时的模板；修改模板只作用于新草稿，不改写历史或自动重发。

## 邮件与预算

收件人、发件账户和SMTP在自己的config.local.json中设置；Agent邮箱使用自己的连接和明确启用的本地政策。默认发送关闭。可在配置中降低候选与精选预算；单轮视频和邮件有界上限用于控制费用与重复投递，模板不能绕过发送次数或授权。

09:00/18:00及Asia/Shanghai仍为当前批次规则，本版未提供任意时区/时段调度器。自定义模板不等于新增定时任务。
