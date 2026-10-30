# 上传与发布

准备好的发布目录是独立仓库根目录，包含README、LICENSE、程序、扩展和测试。请上传这个目录，**不要上传包含开发过程与个人数据的上层工程目录**。

本地可先运行 npm test 和 npm run check。用自己的GitHub账号创建空仓库，建议名称theme-radar，再在发布目录中按GitHub页面给出的命令添加remote并push。上传前用git status --short核对变更。

```sh
git remote add origin <你创建的仓库地址>
git push -u origin main
git push origin v0.1.0-beta.34
```

准备目录已初始化Git并提交/tag时可直接采用上述步骤；否则先git init、git add和git commit。不要在命令中放令牌。GitHub Actions配置已随源码提供，首次push后检查真实CI结果；本地测试不能代替托管CI运行。

GitHub Release可使用CHANGELOG.md中的版本说明，上传对应源码ZIP。发布公开后MIT许可适用，个人账号凭据始终不随源码提供。
