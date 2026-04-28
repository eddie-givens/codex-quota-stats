# Codex Quota Stats

Codex Quota Stats shows Codex usage directly in the VS Code status bar. It
combines local token history from your Codex state with the current 5-hour and
7-day quota windows so you can see both token volume and quota pressure without
leaving the editor.

Repository: https://github.com/eddie-givens/codex-quota-stats

## What It Shows

- compact token counts such as `42M` or `22.2K`
- 5-hour and 7-day quota percentages in the status bar
- green, yellow, and red usage states based on current quota pressure
- a hover tooltip with:
  - current thread title and model
  - latest completed response token usage
  - rolling local token totals for 5 hours and 7 days
  - quota reset times
  - additional model-specific limits when available

## How It Works

The extension reads local Codex usage from your Codex home directory, usually:

```text
~/.codex
```

When `auth.json` is present, it also requests quota data from:

```text
https://chatgpt.com/backend-api/wham/usage
```

## Requirements

- VS Code `1.74.0` or newer
- Python available as `python`, or a custom Python command configured in settings
- local Codex state on the machine you are using

## Installation

Install from the VS Code Marketplace, or install from a `.vsix` file:

1. Open VS Code.
2. Open the Command Palette.
3. Run `Extensions: Install from VSIX...`
4. Select the `.vsix` file.
5. Reload VS Code if prompted.

## Commands

- `Codex Quota Stats: Refresh`
- `Codex Quota Stats: Open Codex Folder`

## Settings

- `localCodexStats.updateInterval`
  Refresh interval in seconds.
- `localCodexStats.pythonCommand`
  Python command used to run the bundled usage reader.
- `localCodexStats.codexHome`
  Optional override for the Codex home directory.
- `localCodexStats.accountId`
  Optional ChatGPT account ID to send with quota requests. Leave blank to use
  the active account in `~/.codex/auth.json`.

## Privacy

- local usage data is read from files on your machine
- quota data is requested directly from OpenAI using your existing local Codex auth state
- the extension does not require a separate API key

## Troubleshooting

- If local token data does not appear, confirm that Codex has been used on that machine.
- If quota percentages do not appear, confirm that `~/.codex/auth.json` exists and is current.
- If quota data comes from the wrong ChatGPT account, set `localCodexStats.accountId`
  to the desired account ID and refresh.
- If Python is only available as `python3`, set `localCodexStats.pythonCommand` accordingly.
- If the extension will not install, confirm that your VS Code version meets the minimum requirement.
