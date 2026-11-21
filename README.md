# Blazar

Blazar is a local-first agent coordinator with a Router, a desktop client, an iOS client, and workspace-scoped execution devices. See the [product design](docs/blazar-design.md) for the full target architecture.

## Local development

Use Node.js 22.19 or newer, then run `npm ci` and `npm test`. Start the Router with `npm run router` after setting `BLAZAR_ROUTER_TOKEN` to a randomly generated secret of at least 32 characters. The development desktop client runs with `npm run desktop` and uses the same token to connect to the local Router.

Register an execution device through `POST /v1/admin/devices` with the Router token and a JSON body containing `name` and `workspace`. Use the returned device token as `BLAZAR_DEVICE_TOKEN`, set `BLAZAR_WORKSPACE_PATH` to the local workspace directory, and run `npm run device`. The default executor supports `/preview relative-file.md`.

Set `BLAZAR_WORKER_GIT_WORKTREE=1` on a Worker device to start each run in a separate detached checkout from the configured repository's committed HEAD. Configure the repository root as its workspace. Checkouts are retained at `~/.blazar-device/run-worktrees/<run-id>`, including after a failed or interrupted run. Review the changes there and remove the checkout with `git worktree remove` from the source repository after saving anything you need. The Worker runs with the device account's OS permissions. The checkout isolates ordinary relative-path edits. Successful runs publish a `git-changes.json` artifact with base and final commit IDs, changed paths, and working tree status. Dependent workflow steps can read the report through the usual artifact handoff. Set `BLAZAR_WORKER_GIT_PATCH=1` to include a tracked text patch in the Router artifact. This shares changed lines with authorized artifact readers and dependent steps. If the patch exceeds the artifact size limit, the report records the omission and the checkout retains the change. The patch excludes untracked files and files Git classifies as binary. The Router only gives a workspace concurrent Worker leases when all participating devices use isolated checkouts, subject to any configured workspace limit. Each device still executes one run at a time, and local devices need distinct workspace paths.

The Router holds an exclusive lock in the database directory. Set `BLAZAR_DB` to a file in a dedicated local directory to run a separate instance, and assign each instance a distinct port. Leave the lock file in place. The operating system releases its lock when the Router exits, including after a crash.

The local administrator can query `GET /v1/admin/metrics` for task counts by status, device availability, routing counts, and latency summaries for direct event submissions, supported webhook intake, and model routing. Latency counters reset after restart. Each reported p95 is a histogram bucket upper bound in milliseconds.

Run `npm run router:benchmark` to test a temporary local SQLite database with 300 submissions, including retries, and 10 concurrent WebSocket preview workers. The run checks local acknowledgement and first-claim p95, task duplication, assignment accuracy, and duplicate outbound notices. It uses fixture documents and does not call a model or send messages to an IM service.

## Native desktop build

Install the Rust toolchain and macOS build tools, run `npm ci`, then use `npm run desktop:bundle` to build the Tauri app and a background-safe DMG with an Applications shortcut. The native app connects to the Router over loopback. If you change the Router port, launch Blazar with the same `BLAZAR_PORT` value in its environment.

## iOS build

With full Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen/releases) installed, run `npm run ios:project` to generate `apps/ios/Blazar.xcodeproj`. Run `npm run ios:build` for an unsigned simulator build and `npm run ios:test` to run the client tests on an available iPhone simulator. For an iPhone build, open the project, select the shared Blazar scheme, and configure a signing team. The deployment target is iOS 17.

To enable task notifications, turn on Push Notifications for the signed iOS App ID and configure the Router with `BLAZAR_APNS_TEAM_ID`, `BLAZAR_APNS_KEY_ID`, `BLAZAR_APNS_KEY_PATH`, `BLAZAR_APNS_TOPIC` (the bundle ID), and `BLAZAR_APNS_ENVIRONMENT`. Use `sandbox` with a development push entitlement and `production` with a distribution push entitlement. Keep the signing key in a private file. Pair the iPhone and use **Enable task notifications** in Blazar to grant permission and register with its Router. When migrating to another Router, turn off notifications on the existing pairing or revoke that pairing from its desktop settings.

## Run in the background on macOS

Create a private configuration directory and a mode-600 environment file. For the Router, set `BLAZAR_ROUTER_TOKEN` in the file. Its default SQLite database lives alongside the file. For an execution device, set `BLAZAR_DEVICE_TOKEN` and `BLAZAR_WORKSPACE_PATH`, plus any Worker or computer driver settings. Use separate configuration files for the Router and device.

```sh
mkdir -p "$HOME/Library/LaunchAgents"
npm run macos:launch-agent -- router "$HOME/.config/blazar/router.env" "$HOME/Library/LaunchAgents/com.blazar.router.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.blazar.router.plist"
```

Use the same command with `device`, its environment file, and a distinct label such as `com.blazar.device.plist` to run a device. Put absolute executable locations or an explicit `PATH` in the device configuration when a Worker depends on shell setup. Both jobs run in the logged-in user session and continue when the desktop app closes. Use `launchctl bootout "gui/$(id -u)/com.blazar.router"` to stop the Router before maintenance. The generator writes a service definition, and `launchctl bootstrap` starts the service.

## Database backup and recovery

Stop the Router before backing up or restoring. The archive contains SQLite data including tasks, device records, channel cursors, saved memory, and stored artifacts. Keep the archive private and retain a separate copy of your deployment configuration and secrets.

```sh
BLAZAR_DB=/path/to/router.sqlite npm run router:db -- backup /backup/blazar.sqlite
BLAZAR_DB=/recovery/router.sqlite npm run router:db -- restore /backup/blazar.sqlite
```

Create the destination directory before running either command. Restore into a fresh path, then point the Router at that database. Before enabling live IM or device connections after a restore, review any work or outbound deliveries that may have occurred after the backup was taken.

Set `BLAZAR_PROGRESS_RETENTION_DAYS` on the Router to clear old Worker progress events at startup and hourly. Choose a whole number from 1 to 3650. Task instructions, approvals, and results remain available.

## Remote iOS and device access

Run Caddy on the Router host with a public DNS name pointing to that host. Allow Caddy to receive traffic on ports 80 and 443 so it can obtain and renew a TLS certificate. If the Router uses a custom `BLAZAR_PORT`, pass the same value to Caddy.

```sh
BLAZAR_PUBLIC_HOST=blazar.example.com caddy run --config deploy/Caddyfile --adapter caddyfile
```

In the desktop pairing form, enter `https://blazar.example.com` and scan the QR code from the iOS app. Approve the request under **Linked phones** on the desktop. For a remote execution device, set `BLAZAR_ROUTER_URL=https://blazar.example.com` and use its own device token. Caddy proxies the device WebSocket, the iOS API, and the Feishu and QQ callback routes. Create pairing codes, manage devices, and configure app connections on the Router host using the loopback address.

A new execution run has a ten-minute maximum duration, including time spent awaiting approval. The Router caps each renewal at that deadline. If the deadline is reached before the result arrives, the task timeline records the timeout and the task waits for review.

## Interrupted device recovery

If an execution device exits unexpectedly during a task, its workspace remains blocked on that OS account. Review the interrupted run in Blazar, confirm that the Worker and its children have stopped, and check the workspace and any external effects. The execution devices view shows the interrupted run ID when the device reconnects. Stop the device service before inspecting or clearing an interrupted run. For an isolated Git run, inspect the recorded base commit, current HEAD, up to 100 commits added by the Worker, and staged, unstaged, and untracked changes. Older checkouts may have no recorded base commit.

```sh
BLAZAR_WORKSPACE_PATH=/path/to/workspace npm run device:reconcile -- --inspect RUN_ID
```

After reviewing the run, clear its interrupted record and restart the device service.

```sh
BLAZAR_WORKSPACE_PATH=/path/to/workspace npm run device:reconcile -- RUN_ID
```

The command clears the local execution record. Task status and the decision to retry remain in the Router.

## Worker presets

Set `BLAZAR_DEVICE_WORKER` to choose the locally installed executable for a device. Complete any provider login with the worker's own CLI. Set `BLAZAR_WORKER_EXECUTABLE` to an absolute path when the executable is outside the device's Path.

| Preset | Executable |
| --- | --- |
| `codex`, `pi` | `codex`, `pi` |
| `claude` | Claude Agent SDK, with its bundled Claude Code executable |
| `deepseek`, `opencode`, `copilot` | `dsh`, `opencode`, `copilot` |
| `droid`, `qwen`, `kimi`, `kiro`, `auggie` | `droid`, `qwen`, `kimi`, `kiro-cli`, `auggie` |
| `gemini`, `cursor`, `antigravity` | `gemini`, `cursor-agent`, Antigravity ACP server |
| `cline`, `goose`, `amp`, `aider` | `cline`, `goose`, Amp ACP wrapper, `aider` |

The ACP presets follow the [ACP Registry](https://agentclientprotocol.com/get-started/registry). Codex has been exercised with a real local account. Other presets need vendor-specific authentication and integration validation. For ACP requests, Blazar can ask the user to approve one-time reads of named files inside the workspace. Other client permission requests are cancelled.

For DeepSeek Harness, install the official [`@deepseek-ai/dsh` package](https://www.npmjs.com/package/@deepseek-ai/dsh). Version `0.2.2-rc.5` requires Node.js 24.9 or newer on the execution device. Blazar launches `dsh --profile acp` and forwards `DEEPSEEK_API_KEY` and an optional `DSH_HOME` from the device environment. On macOS arm64, Blazar verified the ACP v1 handshake and new-session creation with this release using Node.js 24.22.3.

Run `npm run device:probe -- <preset>` with the same configuration as the execution device to check executable discovery. For ACP Workers, the probe performs a protocol handshake. For Pi, it verifies the RPC `get_state` response and reports whether a model is configured. Credential reporting is limited to environment variable presence. Provider login and model access require a successful authenticated task.

Use `BLAZAR_DEVICE_WORKER=custom` and `BLAZAR_WORKER_MANIFEST` to point to an absolute path containing a version 1 ACP manifest:

```json
{
  "version": 1,
  "protocol": "acp",
  "label": "My agent",
  "executable": "/absolute/path/to/agent",
  "args": ["acp"],
  "env": ["MY_AGENT_API_KEY"]
}
```

For a JSONL extension, set `"protocol": "jsonl"` in the same manifest. Blazar writes one UTF-8 line with `version: 1`, `type: "run"`, and an `input` containing `goal`, `instructions`, and `predecessorResults`, then closes standard input. The Worker can emit progress lines and must emit exactly one terminal line. Write any diagnostic output to standard error.

```jsonl
{"version":1,"type":"progress","message":"Read the input"}
{"version":1,"type":"completed","result":"Task summary"}
```

For a failed run, send `{"version":1,"type":"failed","message":"Reason"}` as the terminal line. A successful Worker exits with status zero after writing its result. Configure local executable paths and environment names only for Workers you trust to run with your local account.

Set `"includeFullInputArtifacts": true` in a JSONL manifest to fetch complete text for truncated predecessor artifacts where the run has access. Blazar verifies the content hash and limits full-text fetches to 64,000 bytes per run. Use `artifact.text` when available and `artifact.excerpt` for bounded context.

## Feishu / Lark document memory

To enable document import, set `BLAZAR_DOCS_ACCESS_TOKEN` and `BLAZAR_DOCS_ACCOUNT` on the Router. Use `BLAZAR_DOCS_REGION=lark` for Lark. The account label in Apps and memory must match the configured label. Paste a document ID into the import form. Imports use the access token's existing document permissions and retain the connection and content revision with the memory.

To connect multiple Feishu or Lark accounts, configure their labels and credential environment variable names on the Router. Register a source account in Apps and memory for each configured `region` and matching `account`.

```sh
export BLAZAR_FEISHU_DOCS='[{"region":"feishu","account":"Project team","tokenEnv":"BLAZAR_DOCS_TOKEN_PROJECT"},{"region":"lark","account":"Global team","tokenEnv":"BLAZAR_DOCS_TOKEN_GLOBAL"}]'
```

Set each named token variable to the access token for that account. Labels must be unique within each region. Use a new label when replacing a source with an unrelated account, so stored memory retains its original provenance.

## GitHub document memory

Configure one entry per repository and account label in `BLAZAR_GITHUB_DOCS`. Each entry names a separate environment variable that holds a GitHub token with read access to that repository's contents.

```sh
export BLAZAR_GITHUB_DOCS='[{"account":"Engineering handbook","repository":"org/handbook","tokenEnv":"BLAZAR_GITHUB_TOKEN_HANDBOOK"}]'
```

For MCP document sources, configure an account with a Streamable HTTP endpoint and a map from document aliases to MCP resource URIs.

```bash
export BLAZAR_MCP_DOCS='[{"account":"Handbook","endpoint":"http://127.0.0.1:4198/mcp","resources":{"review":"docs://handbook/review"}}]'
```

Register the account in the desktop app with app type `mcp`, then use `review` as the document ID. For a server requiring bearer authentication, set `tokenEnv` to the name of a `BLAZAR_MCP_TOKEN_*` environment variable. The connector reads text resources by alias.

To give a custom MCP application its own identity in the desktop catalog, add a versioned manifest to the Router environment. The same application ID may have multiple account entries with a shared label.

```sh
export BLAZAR_APP_MANIFESTS='[{"version":1,"id":"custom.handbook","label":"Team Handbook","connector":"mcp-resources","account":"Production","endpoint":"http://127.0.0.1:4198/mcp","resources":{"review":"docs://handbook/review"}}]'
```

Restart the Router, then connect `custom.handbook` with account `Production` in the desktop app. Credentials and endpoints stay on the Router. The catalog exposes the manifest name, account label, and document capabilities.

A manifest can list up to two ordered `fallbacks` with an `endpoint` and optional `tokenEnv` each. Configure only mirrors of the same resources. Every endpoint uses the application account's existing resource URI map and its own credential reference. The Router tries the next backend after HTTP 502, 503, or 504. Authentication failures, access denials, and application errors end the read.

Router administrators can invoke a catalog capability with `POST /v1/app-connections/{connection-id}/capabilities/{capability-id}`. Supported document capabilities are `document.test`, `document.import`, `document.search`, and `document.refresh`. The JSON body includes `workspace`, plus `document` for test and import, `query` for search, or an optional `after` cursor for refresh. MCP applications also expose `document.discover` with a `workspace` input. Discovery returns approved aliases currently listed by the server, with `complete: false` if the bounded scan ends before finding every configured alias. Search returns excerpts of current imported documents for that connection from the local index. In the desktop app, select a source account under **Documents** and use **Search imported documents**. MCP accounts also show **Check available documents**, which filters the import picker to aliases found in the live server listing.

In **Apps and memory**, choose a source account and workspace to refresh previously imported documents. You can also save an automatic refresh interval for that account and workspace.

In the desktop task view, **Create task with selected apps** lets a Worker use matching knowledge from source accounts you select. Access is rechecked when the task is assigned and when the Worker submits a result. Administrators can share a completed result version with an individual paired phone while each referenced version remains authorized.

Register a `github` source account with the matching label in Apps and memory. Import a Markdown or text path relative to the repository root. The reader uses the repository's default branch. Select the GitHub and Feishu sources together to search across both, with each result retaining its connection and content revision.

In Apps and memory, use **Disable memory** to keep an item out of normal search and model answers. Use **Find disabled memory** with the same workspace and authorized sources to locate it and restore it. Source revocation applies to both active and disabled items.

## Computer observation

An execution device can run in `observe` mode using a locally installed [agent-desktop](https://github.com/vercel-labs/agent-desktop). Set `BLAZAR_COMPUTER_DRIVER` to its absolute executable path and `BLAZAR_COMPUTER_APPS` to an alias map such as `{"calculator":"Calculator"}`. From the desktop or iOS client, submit `/observe calculator` in the registered workspace. The result is an access-controlled text artifact derived from the application's accessibility tree. Run `npm run device:probe -- observe` with the same configuration to inspect Accessibility, Screen Recording, and Automation permission states without prompting for access.

To enable window images, configure `BLAZAR_COMPUTER_VISUAL_APPS='["calculator"]'` on the execution device and grant Screen Recording permission. In iOS Desktop Control, list the application's windows and select **View window image**. The selected window must have a process identity. Blazar captures only that window and makes the PNG available for five minutes.

Set the application name to its localized macOS display name, such as `计算器` on a Chinese system. Use `/observe calculator --windows` to list visible windows for the configured app. Then use `/observe calculator --window w-123` with a current accessible window ID to inspect that window.

To enable clicks for named buttons, set `BLAZAR_COMPUTER_BUTTONS` to an alias-to-label map such as `{"calculator":["Clear"]}`. Submit `/click calculator Clear` from desktop or iOS, then review and approve the one-time action in Blazar. Include a window ID before the button label to scope the approval, for example `/click calculator --window w-123 Clear`.

To cancel a task from a linked IM thread, send `/blazar /cancel` as a reply. On channels that use explicit task references, use the channel’s follow-up syntax with `/cancel` as the follow-up text. The original workspace and conversation must match the task link.

Linked conversations also accept `/status`, `/pause`, `/resume`, and `/retry` as follow-up text. Their Chinese equivalents are `/状态`, `/暂停`, `/继续`, and `/重试`. Resume applies to paused tasks. Retry queues a new version of a failed task or one that is waiting for attention without an active run. To review a linked result, use `/status` to check its current version, then reply with `/accept <version>` or `/reject <version>` (`/验收` or `/退回`).

To continue an existing task in another supported IM conversation, open the task on desktop and create a one-time link command. Send the command as a new message in an authorized conversation for the same workspace. Reply in the linked Feishu or Lark thread, or use `/blazar follow TASK_ID your instruction` on channels that require an explicit task reference.

Configure Feishu with `BLAZAR_FEISHU_*` and the `/v1/channels/feishu/events` callback. A Router can also run an independent Lark bot using `BLAZAR_LARK_VERIFY_TOKEN`, `BLAZAR_LARK_APP_ID`, `BLAZAR_LARK_TENANT`, `BLAZAR_LARK_WORKSPACE`, `BLAZAR_LARK_SENDERS`, `BLAZAR_LARK_CHATS`, and `BLAZAR_LARK_APP_SECRET`, with callback `/v1/channels/lark/events`. Existing `BLAZAR_FEISHU_REGION=lark` deployments can keep their original callback and task links.

Feishu and Lark can attach UTF-8 `.txt`, `.md`, `.csv`, `.json`, and `.log` files to a Worker task. Send the file as a reply in its linked thread. Configure the bot app secret and [message resource access](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1). The Router accepts up to 8 KiB per file and 16 KiB per task.

For QQ attachments, set `BLAZAR_QQ_MEDIA_HOSTS` to the exact QQ media hostnames your bot receives. Send a single UTF-8 file with `/blazar follow TASK_ID /attach` in the linked chat. The same size limits apply. Downloads are restricted to configured HTTPS hosts under `qq.com` or `qpic.cn`.

For DingTalk bot direct messages, set `BLAZAR_DINGTALK_MEDIA_HOSTS` to the exact HTTPS hostnames returned by the [message-file API](https://opensource.dingtalk.com/developerpedia/docs/learn/bot/message/). In the linked chat, send `/blazar follow TASK_ID /attach`, then send one UTF-8 file within five minutes. Each command accepts one file from the same sender and chat.

For WeCom smart-bot file messages, set `BLAZAR_WECOM_MEDIA_HOSTS` to the exact HTTPS media hostnames under `qq.com` used by the bot. In the linked chat, send `/blazar follow TASK_ID /attach`, then send one UTF-8 file within five minutes from the same account. Blazar decrypts the downloaded file using the [official WeCom SDK](https://github.com/WecomTeam/aibot-node-sdk).

Weixin bot direct messages support the same two-step attachment flow. Send `/blazar follow TASK_ID /attach` in the linked chat, then send one UTF-8 file within five minutes. Blazar downloads the bounded encrypted file through the [Tencent iLink CDN protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md).
