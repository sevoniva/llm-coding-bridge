# 可选：向导与 AI 自动配置（Windows / macOS）

如果你只需要编辑配置并双击重启，先看[简单使用方式](getting-started.zh-CN.md)。本页供需要向导、多模型、系统密钥存储或客户端自动配置的人使用。

## 1. 最短操作路径

Windows 打开 **PowerShell / Windows Terminal**；macOS 打开终端。在日常使用客户端的同一个系统账户下执行：

```text
npm install -g @sevoniva/llm-coding-bridge@latest
llm-coding-bridge setup
llm-coding-bridge status
```

需要 Node.js 18 以上；新安装建议使用 Node.js 24。可先运行 `node --version` 和 `npm --version` 检查。

向导按下面填写：

| 向导内容 | 怎么填 |
| --- | --- |
| Provider 名称 | 任意易懂名称，例如 `My Provider` |
| Provider Base URL | 服务商的 OpenAI 兼容 API 地址，例如 `https://api.example.com/v1`；不要填网页地址或完整 `/chat/completions` 路径 |
| 客户端模型别名 | 默认 `coding`，这是你在客户端选择的名称；多个模型不能重名 |
| 上游模型 ID | 原样填写服务商提供的模型 ID，不能用自己起的别名替代 |
| API Key | 在本机终端粘贴；输入显示为点号 |
| 继续添加模型 | 通常直接回车；每个模型可以使用独立密钥 |
| 接入 Codex / Claude Code / ZCode | 使用哪个就对哪个回答 `y`；不使用的直接回车 |
| 登录自动启动 | 默认 `install`，直接回车即可安装并立即启动 |
| 检测范围 | 默认 `all`，会向每个模型发送一次小请求，可能产生少量 API 用量 |

向导完成后，`status` 中 `health` 和 `models` 应为 `[OK]`，并显示 `autostart installed=true running=true`。任务刚启动时可能需要数秒，稍后再次运行 `status`。然后重新打开已配置的客户端，选择 `coding` 并发一条测试消息。

Codex 接入会修改 `~/.codex/config.toml` 的默认模型与 provider，CLI 和 Desktop 共用该文件。Claude Code 接入会合并 `~/.claude/settings.json` 的环境配置。已有文件会先备份，输出会列出备份路径。ZCode 只自动修改识别为受支持的 3.x 配置；Windows 根据安装程序的卸载注册信息识别版本，无法识别时仅预览，请按第 5 节手工接入。

## 2. 配置究竟存在哪里

**npm 安装目录保存程序；用户目录保存配置。不要修改 `node_modules` 里的文件。** 更新 npm 包不会重写你的配置或密钥。

| 文件 | Windows 默认位置 | 用途 |
| --- | --- | --- |
| 运行配置 | `%USERPROFILE%\.llm-coding-bridge\config.json` | 向导生成的地址、模型与密钥读取方式；上游 API Key 存在系统密钥存储中 |
| 加密密钥 | `%USERPROFILE%\.llm-coding-bridge\credentials\*.dpapi` | 当前 Windows 账户加密保存的上游 API Key，由命令管理 |
| 服务记录 | `%USERPROFILE%\.llm-coding-bridge\service.json` | 已安装服务使用的绝对配置路径和 Node 路径，由命令维护 |
| 自启动入口 | `%USERPROFILE%\.llm-coding-bridge\service\start.ps1` | 任务计划程序调用的入口，由命令生成 |
| 日志 | `%USERPROFILE%\.llm-coding-bridge\logs\out.log`、`err.log` | 启动与运行日志 |
| `setup.json` | 你自己选择的位置 | 可选的一次性安装说明，供 `setup --profile` 读取；不是服务运行时配置 |

macOS 对应路径为 `~/.llm-coding-bridge/`，密钥保存在登录钥匙串中，自启动文件位于 `~/Library/LaunchAgents/com.sevoniva.llm-coding-bridge.plist`。

Windows 的 `%USERPROFILE%` 是 CMD / 资源管理器写法；PowerShell 中使用 `$HOME` 或 `$env:USERPROFILE`。查看或打开配置：

```powershell
llm-coding-bridge config path
notepad "$HOME\.llm-coding-bridge\config.json"
```

路径选择规则：

1. `--config "完整路径"` 优先级最高。
2. `setup` 默认写用户目录；可用 `setup --config "完整路径"` 改位置。
3. `restart-service` 和 `status` 默认使用已安装服务记录的路径，避免换目录后启动了另一份配置。
4. 其他读取配置的命令，先查当前目录的 `llm-coding-bridge.config.json`，再查用户目录。
5. `config path` 显示当前命令的配置选择；`service-status` 的 `configPath` 显示后台服务的实际配置。自定义位置时，对 `doctor`、`config validate`、`client add` 显式传同一个 `--config`。

配置文件使用 **UTF-8 JSON**。可以有 UTF-8 BOM；不能用注释、尾逗号或单引号。Windows 路径在 JSON 中写成 `"C:/Users/me/config.json"`，或转义反斜杠 `"C:\\Users\\me\\config.json"`。

## 3. 让 AI 自动配置

可以直接复制以下说明给 AI，并替换其中的占位内容：

```text
请在这台电脑配置 @sevoniva/llm-coding-bridge，完成客户端接入和登录自动启动。
系统：Windows / macOS（按实际填写）。
上游 Base URL：填写服务商 API 地址。
上游模型 ID：填写准确模型 ID。
客户端模型别名：coding。
要接入的客户端：Codex / Claude Code / ZCode（只保留我使用的）。

先检查 node、npm 和 llm-coding-bridge --help，读取已安装包内的
docs/getting-started.zh-CN.md，不要假设旧版本支持新命令。
使用当前日常账户，保留已有配置，输出实际路径和备份路径。
密钥由我在本机运行 credential set --name coding 输入；不要写入聊天或配置文件。
用 template setup 生成 setup.json，替换服务商和模型字段，
credential.source 使用 stored，clients 只包含我要的客户端，service 使用 install。
运行 setup --profile setup.json --yes，然后检查 config validate、
service-status、status、doctor --all-models。
自定义配置路径时各命令显式传相同的 --config。
如果当前配置是 v1，先预览 config migrate --dry-run，再备份迁移。
最后说明如何修改配置、更新密钥、重启、查看日志和取消自启动。
```

AI / 脚本配置流程（Windows PowerShell）：

```powershell
# 用户在本机输入一次密钥；名称必须与 setup.json 的模型 alias 一致。
llm-coding-bridge credential set --name coding

# Windows PowerShell 5.1 的 > 默认写 UTF-16，必须显式选择 UTF-8。
llm-coding-bridge template setup | Set-Content -Encoding utf8 .\setup.json
notepad .\setup.json

# 替换下面模板中的服务商和模型信息后执行。
llm-coding-bridge setup --profile .\setup.json --yes
llm-coding-bridge config validate
llm-coding-bridge service-status
llm-coding-bridge status
```

macOS 生成模板可用 `llm-coding-bridge template setup > setup.json`，后续命令相同。`setup` 的默认 `probe: "all"` 已检测上游，需要再次诊断时再运行 `doctor --all-models`。

完整 `setup.json` 示例：

```json
{
  "provider": {
    "name": "My Provider",
    "baseUrl": "https://api.example.com/v1"
  },
  "models": [
    {
      "alias": "coding",
      "upstreamModel": "replace-with-provider-model-id",
      "credential": { "source": "stored" },
      "reliabilityPolicy": "stable"
    }
  ],
  "clients": ["codex"],
  "service": "install",
  "probe": "all",
  "server": { "host": "127.0.0.1", "port": 37629 }
}
```

| 字段 | 可选值与含义 |
| --- | --- |
| `provider.baseUrl` | 服务商的 Chat Completions 基础地址 |
| `models[].alias` | 客户端选择的名字；字母、数字、点、下划线、连字符；全局唯一 |
| `models[].upstreamModel` | 服务商要求的真实模型 ID |
| `models[].credential` | 推荐 `{"source":"stored"}`；也支持 `{"source":"env","env":"LLM_API_KEY"}`、`command`、`client` |
| `clients` | `[]` 只配置 bridge；可组合 `"codex"`、`"claude-code"`、`"zcode"` |
| `service` | `"install"` 安装并启动 / 更新自启动；`"restart"` 重新安装并启动；`"none"` 不操作服务 |
| `probe` | `"all"` 检测全部模型；指定别名只测一个；`"none"` 跳过上游检测 |
| `server` | 通常保持 `127.0.0.1:37629`；不要让自启动服务使用随机端口 `0` |
| `reliabilityPolicy` | 通常 `"stable"`；需要更长推理等待时使用 `"long-thinking"` |

`stored` 只用于 **setup profile**。执行后会被解析成当前系统的密钥读取命令，运行配置中的 `credentials` 使用 `command` 描述。自动生成的 `server.localToken` 是客户端访问本地 bridge 的令牌，与上游 API Key 不同。

脚本已有环境变量时可以用 `credential set --name coding --from-env YOUR_API_KEY_ENV` 导入到系统密钥存储；命令行不接收明文 `--api-key`。Windows 使用 DPAPI 加密，并用当前用户 ACL 保护生成的配置、密钥和备份文件。换 Windows 账户或机器时应重新运行 `credential set`；不要复制加密文件期待跨机器直接解密。

重新执行相同服务商名称和 Base URL 的 profile 会更新该服务商的模型列表，并保留其他服务商；因此需要在 profile 里保留该服务商所有要继续使用的模型。修改 provider 名称或 Base URL 会生成另一个服务商，原别名冲突会校验失败；这类修改可直接编辑运行配置中的对应 provider。

## 4. 修改配置和密钥

日常只需要知道运行配置的这些字段：

| 需求 | 修改哪里 |
| --- | --- |
| 换服务商地址 | `providers[].baseUrl` |
| 换真实模型 | `providers[].models[].upstreamModel` |
| 改客户端模型名 | `providers[].models[].alias`；随后重新接入客户端 |
| 增加另一个模型 | 在向导或 profile 中添加模型，给它独立 alias |
| 改本地端口 | `server.port`；随后重新接入客户端以同步地址 |
| 更新 API Key | 运行 `credential set --name coding`，然后重启服务 |
| 查有哪些模型与有效设置 | `config show --effective`；输出隐藏密钥和本地令牌 |

更改后执行：

```text
llm-coding-bridge config validate
llm-coding-bridge restart-service
llm-coding-bridge status
llm-coding-bridge doctor --all-models
```

`config validate` 只校验本地 JSON 和配置结构；`status` 检查运行中的 bridge；`doctor --all-models` 实际访问上游。三者检查范围不同。

需要手工创建运行配置时，使用 `template config`；这个模板使用环境变量 `LLM_API_KEY`，适合前台调试。Windows 可用 `$env:LLM_API_KEY = '你的密钥'` 后执行 `serve`，但这种临时变量只对当前终端有效。日常自启动使用上面的 `stored` 流程即可。

## 5. 接入客户端

向导里漏选了客户端，也可以单独添加：

```text
llm-coding-bridge client add codex --dry-run
llm-coding-bridge client add codex --yes
llm-coding-bridge client add claude-code --yes
llm-coding-bridge client add zcode --dry-run
llm-coding-bridge client add zcode --yes
```

只运行你需要的命令。`--dry-run` 预览，不修改文件。Windows 下修改 ZCode 配置前请完全退出 ZCode，完成后再打开；自动关闭并重启 ZCode 的 `--restart-zcode` 仅适用于 macOS。

其他支持自定义 OpenAI 接口的客户端，手工填写：

| 客户端字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:37629/v1` |
| Model | `coding`（或你配置的其他 alias） |
| API Key / Token | 运行配置中的 `server.localToken`；这是本地令牌，不是服务商密钥 |

Claude Code 使用 `http://127.0.0.1:37629`，自动接入命令会正确设置。对于 `credential.source: "client"` 的高级接入，令牌含义不同，见[完整配置参考](configuration.md)。

## 6. 开机自动启动与日常管理

Windows 使用当前用户的**任务计划程序**，macOS 使用当前用户的 **launchd**。两者都是**开机后登录该账户时启动**；不是无人登录时运行的系统服务。安装后会立即启动，关闭配置用的终端不会关闭 bridge。Windows 任务限制为单实例，关闭运行时长限制，可在电池供电时运行，失败后每分钟重试，最多连续重试 999 次。

```text
llm-coding-bridge install-service
llm-coding-bridge service-status
llm-coding-bridge status
llm-coding-bridge logs --lines 80
llm-coding-bridge restart-service
```

Windows 可以打开任务计划程序，找到 `LLM Coding Bridge-<账户目录标识>`。`service-status` 可在 bridge 没启动、配置暂时损坏时单独执行；查看 `installed`、`running`、`configPath`，Windows 还显示 `lastExitCode`。

| 操作 | 命令 |
| --- | --- |
| 暂时停止，下次登录仍启动 | `llm-coding-bridge stop-service` |
| 恢复 / 重启 | `llm-coding-bridge restart-service` |
| 停止并取消自动启动 | `llm-coding-bridge uninstall-service` |
| 只在当前终端运行 | `llm-coding-bridge serve`，退出用 Ctrl+C |
| 更新程序 | `npm install -g @sevoniva/llm-coding-bridge@latest`，再 `restart-service` |
| 卸载程序 | 先 `uninstall-service`，再 `npm uninstall -g @sevoniva/llm-coding-bridge` |

取消自启动和卸载程序会保留用户配置与密钥。更新 Node.js 或改变 npm 全局安装位置后，要执行 `restart-service` 更新服务中的绝对程序路径。电脑休眠时不能继续处理请求，唤醒后客户端需重新请求。

首次安装完成后，建议实际注销再登录一次，执行 `service-status`、`status`，然后在客户端发一条消息，确认自启动和密钥均可使用。登录前的系统级启动不在本向导范围内。

## 7. Windows 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 `node` / `npm` | 安装 Node.js 后重新打开 PowerShell，确认 `node --version` 和 `npm --version` |
| 找不到 `llm-coding-bridge` | 运行 `npm prefix -g`，确认输出目录在用户 PATH 中，再重新打开终端；Windows 的命令入口直接位于该目录 |
| PowerShell 提示禁止运行 `npm.ps1` / `llm-coding-bridge.ps1` | 使用 `npm.cmd` 和 `llm-coding-bridge.cmd` 执行相同命令，无需改全局执行策略 |
| JSON 无效 | 用 UTF-8 保存；PowerShell 5.1 不用 `>` 生成 JSON，改用 `Set-Content -Encoding utf8` |
| 当前终端能用，重启后密钥丢失 | 使用 `credential set` 加 `stored` profile；临时 `$env:...` 不会自动持久化到后台任务 |
| `Credential ... unavailable` / Windows 密钥读取失败 | 确认账户与机器一致；重新执行 `credential set --name coding` 并重启 |
| 连接 `127.0.0.1:37629` 被拒绝 | 查看 `service-status`、`logs`，执行 `restart-service`，稍等后重试 `status` |
| 端口占用 | 不要同时运行前台 `serve` 与后台服务；关闭自己的前台实例，或修改 `server.port` 并同步客户端 |
| Task Scheduler 操作失败 | 确认 Windows“Task Scheduler”服务正在运行；企业设备的策略可能限制当前账户创建任务，需由管理员检查策略 |
| `status` 成功但模型失败 | 运行 `doctor --all-models`；检查上游 URL、真实模型 ID、API Key 与服务商余额 / 限流 |
| 修改配置后没有生效 | `config path` 与 `service-status` 对比路径；修改后执行 `restart-service` |
| 旧包不认识新命令 | 检查 `--help`；Windows 支持和这些新命令从 `0.9.0` 起提供 |

实现依据：[Windows 登录触发器](https://learn.microsoft.com/en-us/windows/win32/taskschd/logon-trigger-example--xml-)；[PowerShell DPAPI 加密](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring)。

高级参数、多个 provider、协议与迁移细节见[完整配置参考](configuration.md)。
