"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const vscode = require("vscode");

const REMOTE_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REMOTE_ORIGINATOR = "codex_vscode";
const USAGE_LEVELS = {
    healthy: { label: "Healthy", color: "#73c991" },
    warning: { label: "Watch", color: "#cca700" },
    danger: { label: "High", color: "#f14c4c" },
};

let statusBarItem;
let updateTimer;

function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "localCodexStats.refresh";
    statusBarItem.text = "$(graph) $(sync~spin)";
    statusBarItem.tooltip = "Initializing Codex Quota Stats...";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(vscode.commands.registerCommand("localCodexStats.refresh", async () => {
        await refreshStats();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("localCodexStats.openCodexFolder", async () => {
        const codexHome = getCodexHome();
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(codexHome));
    }));

    context.subscriptions.push({
        dispose() {
            if (updateTimer) {
                clearInterval(updateTimer);
            }
        },
    });

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("localCodexStats")) {
            startAutoRefresh();
            void refreshStats();
        }
    }));

    startAutoRefresh();
    void refreshStats();
}

function deactivate() {
    if (updateTimer) {
        clearInterval(updateTimer);
    }
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}

function startAutoRefresh() {
    if (updateTimer) {
        clearInterval(updateTimer);
    }
    const config = vscode.workspace.getConfiguration("localCodexStats");
    const intervalSeconds = Math.max(30, Number(config.get("updateInterval", 300)) || 300);
    updateTimer = setInterval(() => {
        void refreshStats();
    }, intervalSeconds * 1000);
}

async function refreshStats() {
    if (!statusBarItem) {
        return;
    }
    statusBarItem.text = "$(graph) $(sync~spin)";
    statusBarItem.tooltip = "Refreshing Codex Quota Stats...";

    try {
        const authData = await loadAuthData();
        const [usageResult, remoteUsageResult] = await Promise.allSettled([
            readUsageSnapshot(),
            fetchRemoteUsage(authData),
        ]);
        const usageData = usageResult.status === "fulfilled" ? usageResult.value : null;
        const remoteUsageData = remoteUsageResult.status === "fulfilled" ? remoteUsageResult.value : null;
        const usageError = usageResult.status === "rejected" ? usageResult.reason : null;
        const remoteUsageError = remoteUsageResult.status === "rejected" ? remoteUsageResult.reason : null;

        if (!usageData && !remoteUsageData) {
            showFetchError(authData, usageError, remoteUsageError);
            return;
        }

        updateStatusBar(authData, usageData, remoteUsageData, usageError, remoteUsageError);
    } catch (error) {
        showUpdateError(error);
    }
}

async function loadAuthData() {
    const authPath = path.join(getCodexHome(), "auth.json");
    if (!fs.existsSync(authPath)) {
        return null;
    }

    try {
        const authJson = JSON.parse(fs.readFileSync(authPath, "utf8"));
        const idToken = authJson?.tokens?.id_token;
        const accessToken = authJson?.tokens?.access_token;
        if (!idToken && !accessToken) {
            return null;
        }

        const idPayload = parseJwtPayload(idToken);
        const accessPayload = parseJwtPayload(accessToken);
        const authClaims =
            accessPayload["https://api.openai.com/auth"] ||
            idPayload["https://api.openai.com/auth"] ||
            {};
        const profileClaims = accessPayload["https://api.openai.com/profile"] || {};
        const configuredAccountId = getConfiguredAccountId();
        const authAccountId = authJson?.tokens?.account_id || authClaims.chatgpt_account_id || null;

        return {
            email: idPayload.email || profileClaims.email || "Unknown",
            planType: authClaims.chatgpt_plan_type || "Unknown",
            accessToken: accessToken || null,
            accountId: configuredAccountId || authAccountId,
            accountIdSource: configuredAccountId ? "settings" : (authAccountId ? "auth.json" : "none"),
        };
    } catch (error) {
        console.error("Codex Quota Stats could not read auth.json:", error);
        return null;
    }
}

function parseJwtPayload(token) {
    try {
        if (!token) {
            return {};
        }
        const parts = token.split(".");
        if (parts.length !== 3) {
            return {};
        }
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch (error) {
        console.error("Codex Quota Stats could not parse auth token:", error);
        return {};
    }
}

async function readUsageSnapshot() {
    const config = vscode.workspace.getConfiguration("localCodexStats");
    const pythonCommand = config.get("pythonCommand", "python");
    const scriptPath = path.join(__dirname, "scripts", "read_codex_usage.py");
    const codexHome = getCodexHome();

    return new Promise((resolve, reject) => {
        execFile(
            pythonCommand,
            [scriptPath, "--codex-home", codexHome],
            {
                cwd: __dirname,
                windowsHide: true,
                timeout: 15000,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const message = stderr ? stderr.trim() : error.message;
                    reject(new Error(message || "Python helper failed"));
                    return;
                }

                try {
                    resolve(JSON.parse(stdout));
                } catch (parseError) {
                    reject(new Error(`Could not parse helper output: ${stdout || stderr || parseError}`));
                }
            }
        );
    });
}

async function fetchRemoteUsage(authData) {
    if (!authData?.accessToken) {
        return null;
    }

    const headers = {
        Authorization: `Bearer ${authData.accessToken}`,
        Accept: "application/json",
        originator: REMOTE_ORIGINATOR,
        "User-Agent": "local-codex-stats",
    };
    if (authData.accountId) {
        headers["ChatGPT-Account-Id"] = authData.accountId;
    }

    return httpsGetJson(REMOTE_USAGE_URL, headers);
}

function httpsGetJson(url, headers) {
    return new Promise((resolve, reject) => {
        const request = https.request(
            url,
            {
                method: "GET",
                headers,
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8");
                    if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
                        reject(new Error(`Usage API returned ${response.statusCode || 500} ${response.statusMessage || "Unknown Error"}`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(new Error(`Could not parse usage API response: ${body || error}`));
                    }
                });
            }
        );

        request.on("error", reject);
        request.end();
    });
}

function getCodexHome() {
    const config = vscode.workspace.getConfiguration("localCodexStats");
    const configured = String(config.get("codexHome", "") || "").trim();
    if (configured) {
        return configured;
    }
    return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function getConfiguredAccountId() {
    const config = vscode.workspace.getConfiguration("localCodexStats");
    return String(config.get("accountId", "") || "").trim();
}

function updateStatusBar(authData, usageData, remoteUsageData, usageError, remoteUsageError) {
    const latestResponseTokens = usageData?.latest_response?.total_tokens || 0;
    const threadTokens = usageData?.current_thread?.tokens_used || 0;
    const displayValue = latestResponseTokens || threadTokens;
    const primaryWindow = remoteUsageData?.rate_limit?.primary_window || null;
    const secondaryWindow = remoteUsageData?.rate_limit?.secondary_window || null;
    const usageLevel = getUsageLevel(remoteUsageData);
    const parts = [];

    if (displayValue > 0) {
        parts.push(`${formatCompactNumber(displayValue)} tok`);
    }
    if (primaryWindow && secondaryWindow) {
        parts.push(`${primaryWindow.used_percent}%/${secondaryWindow.used_percent}%`);
    }
    if (parts.length === 0) {
        parts.push("Codex");
    }

    statusBarItem.text = `$(circle-large-filled) $(graph) ${parts.join(" | ")}`;
    statusBarItem.color = usageLevel.color;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = buildTooltip(authData, usageData, remoteUsageData, usageError, remoteUsageError);
}

function buildTooltip(authData, usageData, remoteUsageData, usageError, remoteUsageError) {
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;
    const usageLevel = getUsageLevel(remoteUsageData);

    tooltip.appendMarkdown("## Codex Quota Stats\n\n");
    tooltip.appendMarkdown(`- Source: Local Codex SQLite files in \`${escapeMarkdown(getCodexHome())}\`\n`);
    if (remoteUsageData) {
        tooltip.appendMarkdown(`- Quota source: \`${escapeMarkdown(REMOTE_USAGE_URL)}\`\n`);
    }
    if (authData) {
        tooltip.appendMarkdown(`- Email: ${escapeMarkdown(authData.email)}\n`);
        tooltip.appendMarkdown(`- Plan: ${escapeMarkdown(String(authData.planType).toUpperCase())}\n`);
        if (authData.accountId) {
            tooltip.appendMarkdown(`- Account ID: \`${escapeMarkdown(maskIdentifier(authData.accountId))}\` (${escapeMarkdown(formatAccountIdSource(authData.accountIdSource))})\n`);
        }
    } else {
        tooltip.appendMarkdown("- Auth: No `auth.json` details available\n");
    }

    tooltip.appendMarkdown("\n### Rate Limits\n\n");
    tooltip.appendMarkdown(`- Status: ${escapeMarkdown(usageLevel.label)}\n`);
    if (remoteUsageData?.rate_limit?.primary_window && remoteUsageData?.rate_limit?.secondary_window) {
        const primaryWindow = remoteUsageData.rate_limit.primary_window;
        const secondaryWindow = remoteUsageData.rate_limit.secondary_window;
        tooltip.appendMarkdown(`- Last 5 hours: ${formatPercent(primaryWindow.used_percent)} used, resets ${escapeMarkdown(formatReset(primaryWindow.reset_at, primaryWindow.reset_after_seconds))}\n`);
        tooltip.appendMarkdown(`- Last 7 days: ${formatPercent(secondaryWindow.used_percent)} used, resets ${escapeMarkdown(formatReset(secondaryWindow.reset_at, secondaryWindow.reset_after_seconds))}\n`);
        tooltip.appendMarkdown(`- Allowed: ${remoteUsageData.rate_limit.allowed ? "yes" : "no"}\n`);
        if (remoteUsageData.additional_rate_limits?.length) {
            tooltip.appendMarkdown("\n#### Additional Limits\n\n");
            for (const entry of remoteUsageData.additional_rate_limits) {
                const extraPrimary = entry?.rate_limit?.primary_window;
                const extraSecondary = entry?.rate_limit?.secondary_window;
                if (!extraPrimary || !extraSecondary) {
                    continue;
                }
                tooltip.appendMarkdown(`- ${escapeMarkdown(entry.limit_name || entry.metered_feature || "extra")}: ${formatPercent(extraPrimary.used_percent)} / ${formatPercent(extraSecondary.used_percent)}\n`);
            }
        }
    } else if (remoteUsageError) {
        tooltip.appendMarkdown(`- Remote quota data unavailable: ${escapeMarkdown(getErrorMessage(remoteUsageError))}\n`);
    } else if (authData?.accessToken) {
        tooltip.appendMarkdown("- Remote quota data unavailable\n");
    } else {
        tooltip.appendMarkdown("- No access token available for remote quota data\n");
    }

    tooltip.appendMarkdown("\n### Current Thread\n\n");
    if (usageData?.current_thread) {
        tooltip.appendMarkdown(`- Title: ${escapeMarkdown(trimText(usageData.current_thread.title, 100))}\n`);
        tooltip.appendMarkdown(`- Model: ${escapeMarkdown(usageData.current_thread.model || "unknown")}\n`);
        tooltip.appendMarkdown(`- Thread tokens: ${formatUsageNumber(usageData.current_thread.tokens_used)}\n`);
        tooltip.appendMarkdown(`- Updated: ${formatTimestamp(usageData.current_thread.updated_at)}\n`);
    } else if (usageError) {
        tooltip.appendMarkdown(`- Local thread data unavailable: ${escapeMarkdown(getErrorMessage(usageError))}\n`);
    } else {
        tooltip.appendMarkdown("- No active Codex thread found\n");
    }

    tooltip.appendMarkdown("\n### Latest Response\n\n");
    if (usageData?.latest_response) {
        tooltip.appendMarkdown(`- Total tokens: ${formatUsageNumber(usageData.latest_response.total_tokens)}\n`);
        tooltip.appendMarkdown(`- Input tokens: ${formatUsageNumber(usageData.latest_response.input_tokens)}\n`);
        tooltip.appendMarkdown(`- Cached input: ${formatUsageNumber(usageData.latest_response.cached_input_tokens)}\n`);
        tooltip.appendMarkdown(`- Output tokens: ${formatUsageNumber(usageData.latest_response.output_tokens)}\n`);
        tooltip.appendMarkdown(`- Reasoning tokens: ${formatUsageNumber(usageData.latest_response.reasoning_tokens)}\n`);
        tooltip.appendMarkdown(`- Timestamp: ${formatTimestamp(usageData.latest_response.timestamp)}\n`);
    } else if (usageError) {
        tooltip.appendMarkdown(`- Local response data unavailable: ${escapeMarkdown(getErrorMessage(usageError))}\n`);
    } else {
        tooltip.appendMarkdown("- No completed Codex responses found yet\n");
    }

    tooltip.appendMarkdown("\n### Local Token Windows\n\n");
    if (usageData?.windows?.five_hours && usageData?.windows?.seven_days) {
        tooltip.appendMarkdown(`- Last 5 hours: ${formatUsageNumber(usageData.windows.five_hours.total_tokens)} across ${usageData.windows.five_hours.request_count} responses\n`);
        tooltip.appendMarkdown(`- Last 7 days: ${formatUsageNumber(usageData.windows.seven_days.total_tokens)} across ${usageData.windows.seven_days.request_count} responses\n`);
    } else if (usageError) {
        tooltip.appendMarkdown(`- Local SQLite usage unavailable: ${escapeMarkdown(getErrorMessage(usageError))}\n`);
    } else {
        tooltip.appendMarkdown("- Local SQLite usage unavailable\n");
    }

    tooltip.appendMarkdown("\n> This extension reads local Codex SQLite usage and, when `auth.json` is present, the same `/wham/usage` quota endpoint the official OpenAI VS Code extension uses.\n\n");
    tooltip.appendMarkdown("[Refresh](command:localCodexStats.refresh) | [Open Codex Folder](command:localCodexStats.openCodexFolder) | [Settings](command:workbench.action.openSettings?%22localCodexStats%22)\n");
    return tooltip;
}

function showFetchError(authData, usageError, remoteUsageError) {
    statusBarItem.text = "$(warning) Codex";
    statusBarItem.color = new vscode.ThemeColor("editorWarning.foreground");
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown("## Codex Quota Stats\n\n");
    tooltip.appendMarkdown("Could not read local or remote usage data.\n\n");
    tooltip.appendMarkdown("- Confirm that Codex has been used on this machine\n");
    tooltip.appendMarkdown(`- Confirm that \`${escapeMarkdown(getCodexHome())}\` exists\n`);
    tooltip.appendMarkdown("- Confirm that Python is available for the helper script\n");
    if (authData) {
        tooltip.appendMarkdown(`- Auth is present for ${escapeMarkdown(authData.email)}\n`);
    }
    if (usageError) {
        tooltip.appendMarkdown(`- Local error: ${escapeMarkdown(getErrorMessage(usageError))}\n`);
    }
    if (remoteUsageError) {
        tooltip.appendMarkdown(`- Remote error: ${escapeMarkdown(getErrorMessage(remoteUsageError))}\n`);
    }
    tooltip.appendMarkdown("\n[Refresh](command:localCodexStats.refresh)\n");
    statusBarItem.tooltip = tooltip;
}

function showUpdateError(error) {
    statusBarItem.text = "$(error) Codex";
    statusBarItem.color = new vscode.ThemeColor("errorForeground");
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown("## Codex Quota Stats Error\n\n");
    tooltip.appendMarkdown(`\`${escapeMarkdown(error?.message || String(error))}\`\n\n`);
    tooltip.appendMarkdown("[Refresh](command:localCodexStats.refresh)\n");
    statusBarItem.tooltip = tooltip;
}

function formatCompactNumber(value) {
    return new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(value || 0);
}

function formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatUsageNumber(value) {
    return `${formatCompactNumber(value)} (${formatNumber(value)})`;
}

function formatPercent(value) {
    return `${formatNumber(value)}%`;
}

function getUsageLevel(remoteUsageData) {
    const primaryPercent = Number(remoteUsageData?.rate_limit?.primary_window?.used_percent || 0);
    const secondaryPercent = Number(remoteUsageData?.rate_limit?.secondary_window?.used_percent || 0);
    const maxPercent = Math.max(primaryPercent, secondaryPercent);

    if (remoteUsageData?.rate_limit?.limit_reached || remoteUsageData?.rate_limit?.allowed === false || maxPercent >= 90) {
        return USAGE_LEVELS.danger;
    }
    if (maxPercent >= 70) {
        return USAGE_LEVELS.warning;
    }
    return USAGE_LEVELS.healthy;
}

function formatTimestamp(timestamp) {
    if (!timestamp) {
        return "unknown";
    }
    const millis = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
    return new Date(millis).toLocaleString();
}

function formatReset(resetAtSeconds, resetAfterSeconds) {
    const atText = resetAtSeconds ? formatTimestamp(resetAtSeconds) : "unknown";
    if (typeof resetAfterSeconds !== "number") {
        return `at ${atText}`;
    }
    return `at ${atText} (${formatDuration(resetAfterSeconds)} remaining)`;
}

function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return "unknown";
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts = [];

    if (days > 0) {
        parts.push(`${days}d`);
    }
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0 || parts.length === 0) {
        parts.push(`${minutes}m`);
    }

    return parts.slice(0, 2).join(" ");
}

function trimText(value, maxLength) {
    if (!value || value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

function getErrorMessage(error) {
    if (!error) {
        return "unknown";
    }
    if (error instanceof Error) {
        return error.message || error.name || "unknown";
    }
    return String(error);
}

function escapeMarkdown(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
}

function maskIdentifier(value) {
    const text = String(value || "");
    if (text.length <= 8) {
        return text ? "*".repeat(text.length) : "";
    }
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatAccountIdSource(source) {
    if (source === "settings") {
        return "from setting";
    }
    if (source === "auth.json") {
        return "from auth.json";
    }
    return "unknown source";
}

module.exports = {
    activate,
    deactivate,
    _test: {
        buildTooltip,
        fetchRemoteUsage,
        getCodexHome,
        httpsGetJson,
        loadAuthData,
        readUsageSnapshot,
    },
};
