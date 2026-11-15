# Checkin

GitHub Actions 实现 [GLaDOS][glados] 自动签到

([GLaDOS][glados] 可用邀请码: `MW4DK-O0RSF-C7AOU-EN1MP`, 双方都有奖励天数)

## 使用说明

1. Fork 这个仓库

1. 登录 [GLaDOS][glados] 获取 Cookie

1. 添加 Cookie 到 Secret `GLADOS`

1. 添加 Secret `GLADOS_UA`，内容为获取 Cookie 时同一浏览器的 User-Agent。在该浏览器开发者工具的控制台输入 `navigator.userAgent`，复制返回的字符串（不含外层引号）。GLaDOS 会校验登录设备；更换浏览器或浏览器更新后，可能需要重新登录并同时更新 `GLADOS` 与 `GLADOS_UA`。

1. 启用 Actions。每日首次签到目标在北京时间 **09:10—11:50** 内随机选择一次，由后续调度检查按需执行。

## 动态时间与每日状态

- 每天北京时间08:11起，每30分钟检查一次计划；22:30后不再发送签到请求。检查任务可能由GitHub延迟启动，因此目标时间不等于准点执行时间。
- 当天随机目标只生成一次，保存在独立的 `checkin-state` 分支；成功或“今日已签到”后当天不再自动请求。
- 超时、HTTP 408/429/5xx等临时故障，计划间隔60—120分钟补偿。若服务器要求更长的 `Retry-After` 则遵守该要求。每个账户每天最多3次尝试，22:30截止。
- Turnstile/Cloudflare验证失败、登录或设备校验失败时，标为 `manual_required`，停止当天自动重试。请在正常浏览器完成验证和签到，必要时更新登录信息；随机时间不能替代页面验证。
- 运行意外中断且签到结果未知时，保留已占用次数，转人工核对，避免盲目重复请求。
- 多账户分别保存状态。请保持 `GLADOS` 各行的账户顺序；当天修改账户数量时会停止并提示检查。
- 状态仅包含日期、账户序号、时间、次数及结果类别，不保存Cookie、User-Agent、邮箱、余额或接口原文。使用自动提供的 `GITHUB_TOKEN`，无需新增密钥；工作流需要 `contents: write` 保存状态。

### 查看结果和手动执行

在 Actions → `run` → 某次运行的 Summary 中查看每个账户的**今日状态**。未到时间或已完成时，调度检查成功不代表又签了一次；需要人工处理的状态也会明确保留。只有实际失败、新增的截止遗漏或中断异常才产生新的失败提示，后续空检查不会重复推送。

`Run workflow` 提供两个选项：

- `dry_run`：只展示当前计划，不调用GLaDOS，不写入状态，不通知。代码推送自动执行这种预演及测试。
- `reset_blocked`：仅在你已人工处理验证或更新登录信息后使用；解除当天人工处理标记，但不重置随机目标、成功记录或3次上限，也不能越过22:30截止时间。

普通手动执行和定时执行遵守相同的每日限制。若使用已有 `NOTIFY` 渠道，只有产生新签到结果或需要处理的事件才推送；也可按GitHub账户设置接收Actions失败通知。

## 高级功能

1. 如有多个帐号, 可以写为多行 Secret `GLADOS`, 每行写一个 Cookie

1. 多帐号使用同一浏览器标识时，`GLADOS_UA` 填一行即可；使用不同浏览器时，逐行与 `GLADOS` 对应。未配置时使用默认浏览器标识，但不能保证通过设备校验。

1. 如实际登录地址为 `glados.rocks`，在 Settings → Secrets and variables → Actions → Variables 中设置仓库变量 `GLADOS_DOMAIN` 为 `glados.rocks`。默认值为 `glados.cloud`，目前仅支持这两个域名。Cookie 和浏览器标识请从所选地址的同一次登录获取；不要手动更改 Cookie 字段前缀或省略签名字段。

1. 如需修改随机窗口、截止时间或次数上限，修改 [scheduler.js](scheduler.js) 中的 `policy`。`run.yml` 的 `cron` 只控制检查频率，格式可参考 [crontab]，不是每天的随机签到时间。

1. 如需推送通知, 可配置 Secret `NOTIFY`, 已支持:
    1. [WxPusher][wxpusher]: 格式 `wxpusher:{token}:{uid}`
    1. [PushPlus][pushplus]: 格式 `pushplus:{token}`
    1. [Bark][bark]: 格式 `bark:{key}`
    1. [企业微信][qyweixin]: 格式 `qyweixin:{key}`
    1. Console: 格式 `console:log`, 作为日志输出, 一般用于调试
    1. 如需配置多个, 可以写为多行, 每行写一个

1. 注意: Cookie 以及接口输出数据, 包含帐号敏感信息, 因此不要随意公开

## 排查失败

Actions 日志会直接输出每个帐号的成功或失败状态，无需配置 `NOTIFY`。实际尝试失败、Cookie 未配置或本次运行出现异常时，任务会显示失败；后续未发起签到的检查请以 Summary 中保留的今日状态为准。

若看到 `device-mismatch`、`Automated check-in detected` 或 `没有权限`，请在 GLaDOS 网站重新登录，再从同一浏览器更新完整 Cookie 和 User-Agent 到上述两个 Secret。不要将这些内容提交到仓库或发到公开评论。

`code=5, reason=turnstile` 表示需要页面验证，不是修改cron或持续重试就能解决。`HTTP 408/429/5xx` 和超时可补偿重试；非JSON响应或其他业务异常停止当天尝试，并保留失败类别。不要把运行环境的版本弃用警告当作签到成功或失败的依据。

签到POST已确认成功后，即使余额查询失败，也保留成功状态，避免为了查询账户详情重复签到。状态读取失败、权限不足、写入冲突或记录损坏时，在发请求前停止。

本地运行 `npm test` 可验证接口分类、随机时间持久化、延迟补执行、跨天、次数上限、截止时间、中断恢复及存储故障等路径；测试仅使用模拟响应，不访问真实帐号。`npm run scheduled` 是带状态限制的入口；`npm run main` 保留为单次接口诊断入口，不用于定时调度。

---

[glados]: https://github.com/glados-network/GLaDOS
[crontab]: https://crontab.guru/
[pushplus]: https://www.pushplus.plus/
[wxpusher]: https://wxpusher.zjiecode.com/
[bark]: https://github.com/Finb/Bark
[qyweixin]: https://developer.work.weixin.qq.com/document/path/91770
