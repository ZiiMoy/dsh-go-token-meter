# local-token-meter · 用量

[![npm](https://img.shields.io/npm/v/local-token-meter)](https://www.npmjs.com/package/local-token-meter)
[![license](https://img.shields.io/npm/l/local-token-meter)](LICENSE)

给 **dsh-go 手机 App 原生界面**用的本地用量插件：输入框上方一行胶囊，显示**本对话预估花费**和**DeepSeek 余额**；余额不足 5 元时变红提醒，点开是用量面板。

没有按钮套按钮：所有统计都在同一个面板里，胶囊点一下就到。

- 兼容：DSH `>=0.2.1-rc.2 <0.3.0`（0.2.2-rc.1 实测），dsh-go App `>=1.3.0`
- 依赖：只用 Node 内置模块，没有第三方依赖

## 安装

**另一台设备（推荐）**：上架后，`设置 → 插件 → 插件市场` 搜 `local-token-meter` 或「用量」→ 安装到本机。也可以用分享页 `https://go.dshtui.com/p/local-token-meter`（上架后可用）。

**npm**（在目标主机的终端里）：

```sh
dsh plugin --profile web add local-token-meter@1.0.0
```

**GitHub**（不想等 npm 时；`<commit>` 换 40 位 SHA）：

```sh
dsh plugin --profile web add git+https://github.com/ZiiMoy/dsh-go-token-meter.git#<commit>
```

装完在 App「引擎」页重启一次引擎（首次安装通常自动生效，改 `lib/` 代码必须重启）。

## 看到什么

**胶囊（输入框上方）**

- 正常（谷时，绿色）：`本对话¥0.42·余额¥12.30·谷3h20m`
- 峰时（橙色警告色）：`本对话¥5.18·余额¥11.05·峰48m`
- 余额不足 5 元（红色）：`⚠余额¥4.94不足·本对话¥1.29·峰48m`（放不下时先省掉「本对话」，这就是充值提醒）
- 读不到余额：`本对话¥0.42·余额—·谷2h`
- `峰/谷` 是当前计价时段，后面的 `3h20m` 是距离下次切换（峰↔谷）还剩多久，每分钟自动更新
- 点胶囊 → 打开用量面板

**面板（胶囊 / 对话详情页「插件」/ 全部功能）**

- 一句话提示：余额不足时给出「建议充值」，并显示当前是峰时还是谷时、还有多久切换
- 三个数字：余额 / 本对话（含子智能体）/ 今日
- 缓存命中率（今日）、今日缓存节省、近 7 天、近 30 天、累计、余额大约还能用多少次调用
- 最近 7 天每日花费柱状图
- 按模型的花费与调用次数
- 唯一一个按钮「去充值」：打开 DeepSeek 官方充值页

**每轮尾注**

每条回复下面一行：`本轮 tokens · 本轮花费`（≤16 字，不占地方）。

> 截图：欢迎在 `docs/` 放两张（胶囊 + 面板），再更新市场条目里的 `screenshots`。

## 数据来源与隐私

- **用量**：本机 `$DSH_HOME/sessions` 的会话日志（`session.vN.jsonl.zstd`），按引擎自己的 token 口径折账：`assistant/message` 的 `usage`、`assistant/attempt` 的流内 usage、重试替换、以及 seeded 会话的继承前缀跳过。**不联网、不上传**。
- **花费**：按 DeepSeek 官方价目表折算（人民币 / 百万 token，含高峰 2× 与错峰半价），所以是**预估**；单位是元。
- **余额**：优先走宿主账号服务（`ctx.deepseekAccount`，引擎维护登录态）；拿不到时读 `$DSH_HOME/.credentials.yaml` 里的本机凭据，直接请求 `GET {issuer}/api/v0/users/get_user_summary`（只把 token 发给 https 的官方 origin）。余额只缓存在本机 `$DSH_HOME/dsh-go/local-token-meter.state.json`，**只存金额和充值链接，不存凭据、不上传**。每 5 分钟最多查一次；App 打开时如果上次读数超过 1 分钟会马上刷新一次。查失败保留上次读数（不显示 ¥0）。
- 子智能体（delegationDepth > 0）的花费会按日志头部的 `parentSession` 归到发起它的那场对话，所以「本对话」包含子任务；面板 caption 会注明有几个子任务。
- 「今日/近 7 天/近 30 天」按上海时区分天；价格时段按官方高峰时段（北京时间工作日 9:00-12:00、14:00-18:00）。

## 性能

- 每个日志文件按 mtime + 大小缓存，没变不重读；首次安装会异步扫一遍历史（几秒内完成，不阻塞引擎）。
- 实时更新靠 `session/event`：每次模型调用结束只重扫**那一场对话**的日志，且 1.2 秒防抖；超过 4 MB 的大对话降到每 20 秒最多一次。
- 每 2 分钟一次便宜的变动检查；App 在前台、胶囊可见时才轮询余额。
- 面板/胶囊数据只在数字变化时推送（桥接本身还有 4Hz 节流 + 去重）。

## 配置（可选）

`$DSH_HOME/dsh-go/local-token-meter.config.json`：

```json
{
  "lowBalance": 5,
  "topUpUrl": "https://platform.deepseek.com/top_up",
  "prices": {
    "deepseek-flash": { "hit": 0.02, "miss": 1, "out": 4, "peakFactor": 2 }
  }
}
```

- `lowBalance`：余额低于多少钱时提醒（默认 5）。
- `topUpUrl`：充值按钮打开的地址（默认 DeepSeek 官方充值页）。
- `prices`：按模型覆盖价目（元 / 百万 token；`hit` 缓存命中、`miss` 未命中、`out` 输出、`peakFactor` 高峰倍率）。

改配置后重启引擎生效。

## 本地开发

```sh
# 把仓库放到 dsh-go 插件目录再装
cp -r dsh-go-token-meter "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/dsh-go-token-meter"
```

改了 `lib/` 里的代码后，在 App「引擎」页重启引擎生效；改 `package.json` 清单会自动重读。

卸载：

```sh
dsh plugin --profile web remove local-token-meter
```

## 发布

见 [PUBLISHING.md](PUBLISHING.md)。

## License

[MIT](LICENSE)
