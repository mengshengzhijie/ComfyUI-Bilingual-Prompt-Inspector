# Security policy

## Supported version

Security fixes are applied to the latest public release. Older development snapshots
are not maintained separately.

## Reporting a vulnerability

Do not post API keys, access tokens, private prompts, personal dictionaries, or full
configuration files in a public issue.

Use GitHub private vulnerability reporting when it is enabled for the repository:

https://github.com/mengshengzhijie/ComfyUI-Bilingual-Prompt-Inspector/security/advisories/new

If that channel is unavailable, email the maintainer and provide only a minimal
reproduction with secrets removed:

mengshengzhijie@163.com

Community homepage (non-security questions only): https://space.bilibili.com/697555747

## Deployment boundary

This extension adds local `/bpi/*` routes to the existing ComfyUI server. Its same-origin
checks, session token, request limits, and API-key isolation reduce accidental access,
but they are not a user-login system or a network firewall. Do not expose an
unauthenticated ComfyUI instance directly to the public internet.

External translation and optimization requests are sent only to the provider configured
by the user. Review that provider's privacy policy, logging behavior, content policy,
and cost before use.

## Outbound request targets

AI requests are sent only to the address stored in the local configuration file, and that
address is validated before a request is sent:

- OpenAI-compatible endpoints must use HTTPS. Plain HTTP is accepted only for loopback
  addresses on the same machine (127.0.0.0/8, ::1, localhost), so a local runtime such as
  LM Studio keeps working without sending the API key in clear text across the network.
- Remote OpenAI-compatible endpoints must be public. An address written directly as a
  private, reserved or link-local IP (192.168.x.x, 10.x.x.x, 172.16.x.x, 169.254.169.254,
  ...) is rejected even over HTTPS. Domain names are accepted; they are not resolved during
  validation.
- Ollama endpoints must be a loopback address on the same machine.

Credentials embedded in the URL (`user:pass@`) and query strings are rejected as well, and
only the `http` and `https` schemes are allowed. The address is re-validated immediately
before each request, so editing the configuration file by hand cannot bypass these rules.

The large Danbooru dictionary is a local read-only SQLite file under the extension's data
directory. Despite the `connect(` call, it opens a file on disk and opens no socket.
