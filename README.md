# pi-reconnect

Automatically retry [Pi](https://github.com/earendil-works/pi) when your internet connection comes back. Useful when moving between Wi-Fi networks, switching to Ethernet, or reconnecting after a commute.

**No `continue` message. No repeated prompt. No extra provider retries when your internet already works.**

## Requirements

- **macOS**: network detection uses the built-in `scutil` command. Linux and Windows are not supported.
- **Pi with `agent_before_settle` and append-only context edits**. Tested with `@earendil-works/pi-coding-agent` **1.4.0**; older versions/forks may not provide these APIs.
- **Node.js 22.19 or newer**.
- **Interactive terminal mode**. Recovery does not run in print, JSON, or RPC mode.

## Install

```sh
pi install git:github.com/marandaneto/pi-reconnect
```

Then run `/reload` in an existing Pi session, or start a new one. Recovery is enabled automatically; no configuration is needed.

For a project-only installation:

```sh
pi install --local git:github.com/marandaneto/pi-reconnect
```

If you previously copied this extension into `~/.pi/agent/extensions/`, remove or disable that copy before installing the package to avoid loading it twice.

## Usage

Use Pi normally. After a network error exhausts Pi's built-in retries, the extension checks your connection:

| Connection state | Behavior |
| --- | --- |
| No active network connection | Shows **No network connection** and waits. |
| Connected to a network, but no internet | Shows **Connected, but no internet** and waits. |
| Internet is already working | Does nothing. A provider-specific failure is not an offline recovery. |
| Internet returns after an observed outage | Requests one native retry of the existing conversation. |

While waiting, it checks again every **five seconds after each check finishes**. It makes **no model/provider requests** during this wait. Pi stays busy until the connection returns or you cancel.

Press **Escape** or **Ctrl+C** to cancel waiting. New submitted input, model changes, session switching/forking/tree navigation, reload, and shutdown also cancel pending recovery. An intentionally aborted run never starts recovery.

### Commands

| Command | Purpose |
| --- | --- |
| `/reconnect` or `/reconnect status` | Show whether recovery is enabled and currently waiting. |
| `/reconnect off` | Cancel waiting and disable recovery. |
| `/reconnect on` | Enable recovery for future failures. |

On/off state lasts until the extension is reloaded or Pi restarts. Pending recovery is not restored across restarts.

## How it works

1. Wait until Pi's own retry budget is exhausted and `agent_before_settle` runs with a transport error such as `fetch failed`, `ENOTFOUND`, `ENETUNREACH`, or `ECONNRESET`.
2. Use `scutil --nwi` to check for an active macOS network path, rather than merely checking whether Wi-Fi is enabled.
3. If connected, probe two independent HTTPS endpoints in parallel:
   - `https://www.gstatic.com/generate_204`
   - `https://cp.cloudflare.com/generate_204`
4. Either endpoint returning **HTTP 204** counts as internet access. Redirects and captive-portal pages do not count. Network-path checks time out after three seconds, and each internet probe times out after four seconds.
5. Only after observing an offline state followed by restored internet, return `{ continue: true }` from Pi's pre-settlement hook. Append-only context edits omit the failed assistant attempt and any paired tool results from future model context, like Pi's built-in retry. The original entries remain in raw history.

No user or custom message is injected, and the original prompt is not resubmitted. If the provider still fails while internet access works, the extension does not request another retry. Pi's existing retry settings are unchanged.

## Privacy and limitations

- Connectivity probes send **no conversation content, API keys, or provider credentials**. The two connectivity services receive ordinary HTTPS requests and can see your public IP address.
- Blocking **both** probe services can look like an internet outage. If either probe works while the model provider is unreachable, the extension treats you as online and does not retry.
- A captive portal must be completed before recovery can resume.
- `scutil` checks usable network paths, not just association with a Wi-Fi access point.
- HTTP authentication, quota, rate-limit, and server errors do not trigger recovery.
- This handles failed assistant model requests, not failed shell commands, tools, or separate summarization requests.

## Update or uninstall

```sh
pi update git:github.com/marandaneto/pi-reconnect
pi remove git:github.com/marandaneto/pi-reconnect
```

Run `/reload` afterward. For project-only installations, use `pi remove --local git:github.com/marandaneto/pi-reconnect`.

## Development

```sh
git clone https://github.com/marandaneto/pi-reconnect.git
cd pi-reconnect
npm ci
npm run check
```

The tests cover offline/online transitions, provider outages, cancellation, and message-free retries. Native-lifecycle tests use Pi's real session runner with fake model streams and temporary settings/auth storage; they make no provider requests and do not require API keys.

To try your checkout in a single session:

```sh
pi -e ./index.ts
```

Disable any other installed copy first so the extension is loaded only once.

## License

[MIT](LICENSE)
