# Checkin

GitHub Actions 实现 [GLaDOS][glados] 自动签到

([GLaDOS][glados] 可用邀请码: `MW4DK-O0RSF-C7AOU-EN1MP`, 双方都有奖励天数)

## 使用说明

1. Fork 这个仓库

1. 登录 [GLaDOS][glados] 获取 Cookie

1. 添加 Cookie 到 Secret `GLADOS`

1. 添加 Secret `GLADOS_UA`，内容为获取 Cookie 时同一浏览器的 User-Agent。在该浏览器开发者工具的控制台输入 `navigator.userAgent`，复制返回的字符串（不含外层引号）。GLaDOS 会校验登录设备；更换浏览器或浏览器更新后，可能需要重新登录并同时更新 `GLADOS` 与 `GLADOS_UA`。

1. 启用 Actions, 每天北京时间 09:00 自动签到

## 高级功能

1. 如有多个帐号, 可以写为多行 Secret `GLADOS`, 每行写一个 Cookie

1. 多帐号使用同一浏览器标识时，`GLADOS_UA` 填一行即可；使用不同浏览器时，逐行与 `GLADOS` 对应。未配置时使用默认浏览器标识，但不能保证通过设备校验。

1. 如实际登录地址为 `glados.rocks`，在 Settings → Secrets and variables → Actions → Variables 中设置仓库变量 `GLADOS_DOMAIN` 为 `glados.rocks`。默认值为 `glados.cloud`，目前仅支持这两个域名。Cookie 和浏览器标识请从所选地址的同一次登录获取；不要手动更改 Cookie 字段前缀或省略签名字段。

1. 如需修改时间, 可以修改文件 [run.yml](.github/workflows/run.yml#L7) 中的 `cron` 参数, 格式可参考 [crontab]

1. 如需推送通知, 可配置 Secret `NOTIFY`, 已支持:
    1. [WxPusher][wxpusher]: 格式 `wxpusher:{token}:{uid}`
    1. [PushPlus][pushplus]: 格式 `pushplus:{token}`
    1. [Bark][bark]: 格式 `bark:{key}`
    1. [企业微信][qyweixin]: 格式 `qyweixin:{key}`
    1. Console: 格式 `console:log`, 作为日志输出, 一般用于调试
    1. 如需配置多个, 可以写为多行, 每行写一个

1. 注意: Cookie 以及接口输出数据, 包含帐号敏感信息, 因此不要随意公开

## 排查失败

Actions 日志会直接输出每个帐号的成功或失败状态，无需配置 `NOTIFY`。任一帐号失败、Cookie 未配置或接口异常时，任务会显示失败，不再静默显示绿色成功。

若看到 `device-mismatch`、`Automated check-in detected` 或 `没有权限`，请在 GLaDOS 网站重新登录，再从同一浏览器更新完整 Cookie 和 User-Agent 到上述两个 Secret。不要将这些内容提交到仓库或发到公开评论。

`HTTP 429/5xx`、超时或非 JSON 响应应按对应网络或服务器错误排查。不要把运行环境的版本弃用警告当作签到成功或失败的依据。

本地运行 `npm test` 可验证成功、重复签到、设备校验失败、失效 Cookie 和网络错误等路径；测试仅使用模拟响应，不会访问真实帐号。

---

[glados]: https://github.com/glados-network/GLaDOS
[crontab]: https://crontab.guru/
[pushplus]: https://www.pushplus.plus/
[wxpusher]: https://wxpusher.zjiecode.com/
[bark]: https://github.com/Finb/Bark
[qyweixin]: https://developer.work.weixin.qq.com/document/path/91770
