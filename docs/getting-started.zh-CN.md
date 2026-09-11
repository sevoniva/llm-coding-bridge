# 改配置 → 双击重启 → 接入 ZCode

只需要一个 `config.json`。保存修改后，双击重启脚本，ZCode 连接固定的本地地址即可。向导是可选功能。

## 第一次使用

先安装 Node.js（18 以上），打开 PowerShell，执行：

```powershell
npm install -g @sevoniva/llm-coding-bridge@latest
llm-coding-bridge init-files
explorer "$HOME\.llm-coding-bridge"
```

如果 PowerShell 提示 `.ps1` 禁止执行，将上述前两条命令的程序名换成 `npm.cmd`、`llm-coding-bridge.cmd` 即可。不需要修改系统执行策略。

会打开这个文件夹：

```text
C:\Users\你的用户名\.llm-coding-bridge\
  config.json             ← 只需编辑这个文件
  restart.cmd             ← 改完配置后双击这个
  start.cmd               ← 启动，也会加载最新配置
  stop.cmd                ← 暂时停止
  status.cmd              ← 检查运行状态
  disable-autostart.cmd   ← 停止并取消自启动
  HOW-TO-USE.txt
```

也可以选择自己的文件夹：`llm-coding-bridge init-files --out "D:\LLM Bridge"`。脚本始终使用**脚本旁边的 `config.json`**，从哪个目录双击都一样。重复运行 `init-files` 会更新脚本，保留已有配置。

macOS 使用相同的安装和 `init-files` 命令，生成 `.command` 脚本；用 `open ~/.llm-coding-bridge` 打开文件夹，双击 `restart.command`。

## 配置只改三个值

用记事本或编辑器打开 `config.json`：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 37629
  },
  "upstream": {
    "name": "My Provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "YOUR_MODEL_ID",
    "apiKey": "YOUR_API_KEY"
  }
}
```

| 配置项 | 填什么 |
| --- | --- |
| `baseUrl` | 服务商提供的 OpenAI 兼容 API 地址，通常带 `/v1`；不要填网页地址或完整 `/chat/completions` 路径 |
| `model` | 服务商的准确模型 ID |
| `apiKey` | 服务商的真实 API Key |

`host`、`port` 保持默认即可，`name` 随便起。文件按 **UTF-8** 保存，保留 JSON 的双引号和逗号，不要添加注释。文件包含真实 API Key，请保留在本机；生成时会设置当前用户的文件权限。

## 双击重启，然后填 ZCode

保存配置，双击 **`restart.cmd`**。首次运行会安装当前用户的登录自启动，以后每次都会重新读取这份配置并重启。脚本会等新配置生效后显示：

```text
[OK] 配置已重新加载
ZCode Base URL: http://127.0.0.1:37629/v1
ZCode Model: 你填的模型 ID
ZCode API Key: local
```

在 ZCode 新建 **OpenAI compatible / 自定义服务商**：

| ZCode 字段 | 填什么 |
| --- | --- |
| Base URL | `http://127.0.0.1:37629/v1` |
| Model | 与 `config.json` 中的 `model` 一致 |
| API Key | `local` |

服务商的真实 Key 已由 bridge 从配置文件读取。默认只监听本机，ZCode 的 `local` 是占位值。若你另外设置了 `server.localToken`，ZCode 的 API Key 应填该令牌。

配置一次后，**平时换 Key、模型或服务商，只需编辑 `config.json`，保存，再双击 `restart.cmd`**。更换模型后同步修改 ZCode 的模型名；本地地址不变。如果修改了 `server.port`，ZCode 的地址也要跟着改。

重启会结束正在处理的请求。脚本检查的是本地新配置已加载；要确认服务商接口能用，可以在 ZCode 发一条消息，或运行 `llm-coding-bridge doctor --config "完整配置路径"`。

## 自启动和更新

- Windows 使用任务计划程序，macOS 使用 launchd，都是**开机登录当前账户后启动**。无需每天点脚本，关闭脚本窗口不会关闭后台 bridge。
- `stop.cmd` 暂停服务，下次登录仍会启动；`disable-autostart.cmd` 停止并取消自启动。以后双击 `start.cmd` 或 `restart.cmd` 可以恢复。
- 更新：执行 `npm install -g @sevoniva/llm-coding-bridge@latest`，再对原文件夹执行 `init-files`（原来用了 `--out` 就继续用同一个路径），最后双击重启。配置内容会保留，脚本和服务的程序路径会刷新。
- 自启动在当前系统账户下运行，不是无人登录时运行的系统服务。

## 出问题时

| 现象 | 处理 |
| --- | --- |
| 提示先填写配置 | 检查三个占位值是否已替换，确认保存的是脚本旁的 `config.json` |
| 提示 JSON 无效 | 使用 UTF-8 编码、双引号，不写注释或多余逗号 |
| 提示端口占用 / 未加载新配置 | 关闭之前手工启动的 `serve` 窗口，再双击重启；不要同时运行前台与后台实例 |
| ZCode 连接被拒绝 | 双击 `status.cmd` 检查，再查看 `logs/err.log` |
| 本地启动成功但上游报错 | 检查服务商地址、模型 ID 和真实 Key；上游检测用 `doctor` |
| 任务计划程序操作失败 | 检查 Windows Task Scheduler 服务是否正常，企业设备需检查账户策略 |
| 找不到 npm 命令 | 确认 Node.js 已安装；重新打开终端；检查 `npm prefix -g` 对应目录是否在 PATH |

让 AI 帮忙时，只需说：

```text
请安装 @sevoniva/llm-coding-bridge，并运行 init-files 生成配置和双击脚本。
我要直接编辑 config.json，然后双击 restart.cmd 加载配置，ZCode 手工填本地地址。
请告诉我配置文件的位置，以及 baseUrl、model、apiKey 怎么填。
保留已有配置，启用当前用户登录自启动，最后验证新配置加载成功。
不要替我修改 ZCode 的配置。
```

`init-files` 和双击脚本从 `0.9.0` 起提供。旧版用户先更新 npm 包。更多功能见[可选向导与系统密钥存储](guided-setup.zh-CN.md)、[完整配置参考](configuration.md)。
