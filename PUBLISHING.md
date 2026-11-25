# 发布与上架（维护者用）

本插件同时是：一个 npm 包（`local-token-meter`）、一个 DSH bundle（`dsh.bundle.patch`）、一个 DSH Go 原生插件（`dshGo` 清单）。发布流程按下面四步走。

## 0. 前置

- 公开 GitHub 仓库：`https://github.com/ZiiMoy/dsh-go-token-meter`
- npm 账号：`ziimo`（发布前先 `npm login`；开了 2FA 会要求输入验证码）
- 市场投稿仓库：`https://github.com/ccch1mneyyy/dsh-go-market`

## 1. 推代码

```sh
git init
git add -A
git commit -m "feat: local-token-meter 1.0.0"
git branch -M main
git remote add origin https://github.com/ZiiMoy/dsh-go-token-meter.git
git push -u origin main
```

仓库 Settings → Topics 填：`dsh-plugin`、`dsh-bundle`、`dsh-go`、`deepseek-harness`。
（`dsh-plugin` 是 dshfind「全部」市场的自动收录信号，约 1 天后生效。）

## 2. 发 npm

手动：

```sh
npm publish --ignore-scripts
npm view local-token-meter name version repository dist.integrity --json
```

或者配好 Actions：仓库 Secrets 加 `NPM_TOKEN`（npm → Access Tokens → Automation token），然后

```sh
git tag v1.0.0 && git push origin v1.0.0
```

市场钉的是 **npm 上的精确版本**，所以必须先发成功再提 PR。

## 3. 上架官方「DSH Go 市场」（进「适配 DSH Go」分区）

1. Fork `ccch1mneyyy/dsh-go-market`。
2. 在 fork 的 `plugins/` 下新建 `local-token-meter.json`，内容用本仓库 `market/local-token-meter.json`（改版本号时要同步）。
3. 向 `main` 提 PR，标题例如 `Add local-token-meter 1.0.0`。
4. CI 检查（npm 精确版本、OSI 许可证、DSH bundle、体积、安全公告）全过 → GitHub 自动合并，无需人工审核。
5. 合并后 `publish.yml` 生成索引，Worker 最多 10 分钟同步。App 里 `设置 → 插件 → 插件市场` 下拉刷新即可搜到。

投稿模板见 `ccch1mneyyy/dsh-go-market` 的 README「提交插件」；**不要**在条目里写 `tier`、`risk`、`integrity`，写了会被拒。

## 4. 可选的其他目录

- `dsh.so`：<https://www.dsh.so/zh/submit/>（要求公开仓库、README 安装说明、SPDX 许可证、`dsh-plugin` topic）
- `dsh-plugin.org`：<https://dsh-plugin.org/zh/submit>
- `awesome-dsh-plugin`（dsh-market 的数据源）：向 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/*.yml` 提 PR
- `dshfind`（App「全部」分区）：无需投稿，npm 发布 + 公开仓库 + `dsh-plugin` topic + package.json 的 `repository` 回链即可

## 发新版本

1. 改 `package.json` 的 `version`。
2. 同步改 `market/local-token-meter.json` 的 `version`。
3. `git tag vX.Y.Z && git push origin vX.Y.Z`（或手动 `npm publish`）。
4. 向市场仓库提一个「改同一个 JSON 版本号」的 PR。

## 注意

- 市场只接受精确版本（`1.0.0`），不接受 `latest`、范围或 Git 地址。
- 包内 `cordis.patch.yml` 的 `name` 必须等于 `package.json` 的 `name`；改包名要同时改这两处和本文件的包名相关文字。
- 已发布的同版本号不能重发。
