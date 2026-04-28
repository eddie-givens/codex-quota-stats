"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const vscode = require("vscode");

const REMOTE_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REMOTE_ORIGINATOR = "codex_vscode";
const SHOW_NUMBERS_COMMAND = "localCodexStats.showNumbers";
const LEGACY_TOGGLE_NUMBERS_COMMAND = "localCodexStats.toggleNumbers";
const USAGE_LEVELS = {
    healthy: { label: "Healthy", color: "#73c991", severity: 0 },
    warning: { label: "Watch", color: "#cca700", severity: 1 },
    danger: { label: "High", color: "#f14c4c", severity: 2 },
};

let statusBarItem;
let updateTimer;
let detailedNumbersPanel;
let latestSnapshot = null;

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

    const showNumbers = async () => {
        await showDetailedNumbersPanel();
    };
    context.subscriptions.push(vscode.commands.registerCommand(SHOW_NUMBERS_COMMAND, showNumbers));
    context.subscriptions.push(vscode.commands.registerCommand(LEGACY_TOGGLE_NUMBERS_COMMAND, showNumbers));

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
    if (detailedNumbersPanel) {
        detailedNumbersPanel.dispose();
        detailedNumbersPanel = undefined;
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
        const snapshot = await collectStatsSnapshot();
        latestSnapshot = snapshot;
        const { authData, usageData, remoteUsageData, usageError, remoteUsageError } = snapshot;

        if (!usageData && !remoteUsageData) {
            showFetchError(authData, usageError, remoteUsageError);
            updateDetailedNumbersPanel(snapshot);
            return;
        }

        updateStatusBar(authData, usageData, remoteUsageData, usageError, remoteUsageError);
        updateDetailedNumbersPanel(snapshot);
    } catch (error) {
        showUpdateError(error);
    }
}

async function collectStatsSnapshot() {
    const authData = await loadAuthData();
    const [usageResult, remoteUsageResult] = await Promise.allSettled([
        readUsageSnapshot(),
        fetchRemoteUsage(authData),
    ]);

    return {
        authData,
        usageData: usageResult.status === "fulfilled" ? usageResult.value : null,
        remoteUsageData: remoteUsageResult.status === "fulfilled" ? remoteUsageResult.value : null,
        usageError: usageResult.status === "rejected" ? usageResult.reason : null,
        remoteUsageError: remoteUsageResult.status === "rejected" ? remoteUsageResult.reason : null,
    };
}

async function showDetailedNumbersPanel() {
    let snapshot = latestSnapshot;
    if (!snapshot) {
        try {
            snapshot = await collectStatsSnapshot();
            latestSnapshot = snapshot;
        } catch (error) {
            await vscode.window.showErrorMessage(`Codex Quota Stats could not load usage numbers: ${getErrorMessage(error)}`);
            return;
        }
    }

    const columnToShowIn = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
    if (detailedNumbersPanel) {
        detailedNumbersPanel.reveal(columnToShowIn);
    } else {
        detailedNumbersPanel = vscode.window.createWebviewPanel(
            "codexQuotaNumbers",
            "Codex Quota Numbers",
            columnToShowIn,
            {
                enableScripts: false,
                retainContextWhenHidden: true,
            }
        );
        detailedNumbersPanel.onDidDispose(() => {
            detailedNumbersPanel = undefined;
        });
    }

    updateDetailedNumbersPanel(snapshot);
}

function updateDetailedNumbersPanel(snapshot) {
    if (!detailedNumbersPanel || !snapshot) {
        return;
    }
    detailedNumbersPanel.webview.html = buildDetailedNumbersHtml(
        snapshot.authData,
        snapshot.usageData,
        snapshot.remoteUsageData,
        snapshot.usageError,
        snapshot.remoteUsageError
    );
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
    const contextHealth = getContextHealth(usageData);
    const usageLevel = getUsageLevel(remoteUsageData, contextHealth);
    const parts = [];

    if (displayValue > 0) {
        parts.push(`${formatCompactNumber(displayValue)} tok`);
    }
    if (contextHealth) {
        parts.push(`ctx ${contextHealth.percent}%`);
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
    tooltip.supportHtml = true;
    const contextHealth = getContextHealth(usageData);
    const usageLevel = getUsageLevel(remoteUsageData, contextHealth);

    tooltip.appendMarkdown("## Codex Quota Stats\n\n");
    tooltip.appendMarkdown(`- Status: ${escapeMarkdown(usageLevel.label)}\n`);

    appendContextSummary(tooltip, contextHealth, usageError);
    appendQuotaSummary(tooltip, remoteUsageData, remoteUsageError, authData);

    tooltip.appendMarkdown(`\n[Show numbers](command:${SHOW_NUMBERS_COMMAND})`);
    tooltip.appendMarkdown(" | [Refresh](command:localCodexStats.refresh) | [Settings](command:workbench.action.openSettings?%22localCodexStats%22)\n");

    tooltip.appendMarkdown("\n> This extension reads local Codex SQLite usage and, when `auth.json` is present, the same `/wham/usage` quota endpoint the official OpenAI VS Code extension uses.\n");
    return tooltip;
}

function appendContextSummary(tooltip, contextHealth, usageError) {
    tooltip.appendMarkdown("\n### Context\n\n");
    if (contextHealth) {
        tooltip.appendMarkdown(`- Current context: ${contextHealth.percent}% used ${formatUsageBar(contextHealth.percent, contextHealth.level, "Context usage")}\n`);
        tooltip.appendMarkdown(`- Effective window: ${formatUsageNumber(contextHealth.effectiveLimit)}\n`);
        if (contextHealth.level !== USAGE_LEVELS.healthy) {
            tooltip.appendMarkdown("- Context is in the warning range. Codex cleanup may keep the thread usable; this is visibility, not a reset recommendation.\n");
        }
    } else if (usageError) {
        tooltip.appendMarkdown(`- Context data unavailable: ${escapeMarkdown(getErrorMessage(usageError))}\n`);
    } else {
        tooltip.appendMarkdown("- Context window data unavailable\n");
    }
}

function appendQuotaSummary(tooltip, remoteUsageData, remoteUsageError, authData) {
    tooltip.appendMarkdown("\n### Quota\n\n");
    if (remoteUsageData?.rate_limit?.primary_window && remoteUsageData?.rate_limit?.secondary_window) {
        const primaryWindow = remoteUsageData.rate_limit.primary_window;
        const secondaryWindow = remoteUsageData.rate_limit.secondary_window;
        tooltip.appendMarkdown(`- Last 5 hours: ${formatPercent(primaryWindow.used_percent)} used ${formatUsageBar(primaryWindow.used_percent, getContextLevel(primaryWindow.used_percent), "Last 5 hours usage")}\n`);
        tooltip.appendMarkdown(`- Last 7 days: ${formatPercent(secondaryWindow.used_percent)} used ${formatUsageBar(secondaryWindow.used_percent, getContextLevel(secondaryWindow.used_percent), "Last 7 days usage")}\n`);
        tooltip.appendMarkdown(`- Allowed: ${remoteUsageData.rate_limit.allowed ? "yes" : "no"}\n`);
    } else if (remoteUsageError) {
        tooltip.appendMarkdown(`- Remote quota data unavailable: ${escapeMarkdown(getErrorMessage(remoteUsageError))}\n`);
    } else if (authData?.accessToken) {
        tooltip.appendMarkdown("- Remote quota data unavailable\n");
    } else {
        tooltip.appendMarkdown("- No access token available for remote quota data\n");
    }
}

function buildDetailedNumbersHtml(authData, usageData, remoteUsageData, usageError, remoteUsageError) {
    const contextHealth = getContextHealth(usageData);
    const usageLevel = getUsageLevel(remoteUsageData, contextHealth);
    const sections = [
        buildDetailSection("Account", getAccountRows(authData)),
        buildDetailSection("Context Numbers", getContextNumberRows(contextHealth)),
        buildDetailSection("Rate Limits", getRateLimitRows(authData, remoteUsageData, remoteUsageError, usageLevel)),
        buildDetailSection("Current Thread", getCurrentThreadRows(usageData, usageError)),
        buildDetailSection("Latest Response", getLatestResponseRows(usageData, usageError)),
        buildDetailSection("Local Token Windows", getLocalTokenWindowRows(usageData, usageError)),
        buildDetailSection("Sources", getSourceRows(authData)),
    ].join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Codex Quota Numbers</title>
    <style>
        body {
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.45;
        }

        main {
            box-sizing: border-box;
            max-width: 920px;
            padding: 24px 32px 40px;
        }

        h1 {
            margin: 0 0 4px;
            font-size: 24px;
            font-weight: 600;
            letter-spacing: 0;
        }

        h2 {
            margin: 0 0 12px;
            font-size: 15px;
            font-weight: 600;
            letter-spacing: 0;
        }

        .summary {
            margin: 0 0 22px;
            color: var(--vscode-descriptionForeground);
        }

        section {
            border-top: 1px solid var(--vscode-panel-border);
            padding: 18px 0;
        }

        dl {
            margin: 0;
        }

        .detail-row {
            display: grid;
            grid-template-columns: minmax(160px, 260px) 1fr;
            gap: 16px;
            padding: 6px 0;
        }

        dt {
            color: var(--vscode-descriptionForeground);
        }

        dd {
            margin: 0;
            overflow-wrap: anywhere;
        }

        @media (max-width: 640px) {
            main {
                padding: 18px 20px 32px;
            }

            .detail-row {
                grid-template-columns: 1fr;
                gap: 2px;
            }
        }
    </style>
</head>
<body>
    <main>
        <h1>Codex Quota Numbers</h1>
        <p class="summary">Status: ${escapeHtml(usageLevel.label)} - Updated ${escapeHtml(new Date().toLocaleString())}</p>
        ${sections}
    </main>
</body>
</html>`;
}

function buildDetailSection(title, rows) {
    return `<section>
    <h2>${escapeHtml(title)}</h2>
    <dl>
        ${rows.map(([label, value]) => `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("\n        ")}
    </dl>
</section>`;
}

function getAccountRows(authData) {
    if (!authData) {
        return [["Auth", "No auth.json details available"]];
    }

    const rows = [
        ["Email", authData.email || "Unknown"],
        ["Plan", String(authData.planType || "Unknown").toUpperCase()],
    ];
    if (authData.accountId) {
        rows.push(["Account ID", `${maskIdentifier(authData.accountId)} (${formatAccountIdSource(authData.accountIdSource)})`]);
    }
    return rows;
}

function getContextNumberRows(contextHealth) {
    if (!contextHealth) {
        return [["Context window", "Data unavailable"]];
    }

    return [
        ["Current context tokens", formatUsageNumber(contextHealth.usedTokens)],
        ["Context window", formatUsageNumber(contextHealth.contextWindow)],
        ["Effective window", `${formatUsageNumber(contextHealth.effectiveLimit)} (${formatPercent(contextHealth.effectivePercent)})`],
        ["Remaining estimate", formatUsageNumber(contextHealth.remainingTokens)],
    ];
}

function getRateLimitRows(authData, remoteUsageData, remoteUsageError, usageLevel) {
    const rows = [["Status", usageLevel.label]];
    if (remoteUsageData?.rate_limit?.primary_window && remoteUsageData?.rate_limit?.secondary_window) {
        const primaryWindow = remoteUsageData.rate_limit.primary_window;
        const secondaryWindow = remoteUsageData.rate_limit.secondary_window;
        rows.push(
            ["Last 5 hours", `${formatPercent(primaryWindow.used_percent)} used, resets ${formatReset(primaryWindow.reset_at, primaryWindow.reset_after_seconds)}`],
            ["Last 7 days", `${formatPercent(secondaryWindow.used_percent)} used, resets ${formatReset(secondaryWindow.reset_at, secondaryWindow.reset_after_seconds)}`],
            ["Allowed", remoteUsageData.rate_limit.allowed ? "yes" : "no"]
        );
        if (remoteUsageData.additional_rate_limits?.length) {
            for (const entry of remoteUsageData.additional_rate_limits) {
                const extraPrimary = entry?.rate_limit?.primary_window;
                const extraSecondary = entry?.rate_limit?.secondary_window;
                if (!extraPrimary || !extraSecondary) {
                    continue;
                }
                rows.push([
                    entry.limit_name || entry.metered_feature || "Additional limit",
                    `${formatPercent(extraPrimary.used_percent)} / ${formatPercent(extraSecondary.used_percent)}`,
                ]);
            }
        }
    } else if (remoteUsageError) {
        rows.push(["Remote quota data", getErrorMessage(remoteUsageError)]);
    } else if (authData?.accessToken) {
        rows.push(["Remote quota data", "Unavailable"]);
    } else {
        rows.push(["Remote quota data", "No access token available"]);
    }
    return rows;
}

function getCurrentThreadRows(usageData, usageError) {
    if (usageData?.current_thread) {
        return [
            ["Title", trimText(usageData.current_thread.title, 100) || "Untitled"],
            ["Model", usageData.current_thread.model || "unknown"],
            ["Thread tokens", formatUsageNumber(usageData.current_thread.tokens_used)],
            ["Updated", formatTimestamp(usageData.current_thread.updated_at)],
        ];
    }
    if (usageError) {
        return [["Local thread data", getErrorMessage(usageError)]];
    }
    return [["Current thread", "No active Codex thread found"]];
}

function getLatestResponseRows(usageData, usageError) {
    if (usageData?.latest_response) {
        return [
            ["Total tokens", formatUsageNumber(usageData.latest_response.total_tokens)],
            ["Input tokens", formatUsageNumber(usageData.latest_response.input_tokens)],
            ["Cached input", formatUsageNumber(usageData.latest_response.cached_input_tokens)],
            ["Output tokens", formatUsageNumber(usageData.latest_response.output_tokens)],
            ["Reasoning tokens", formatUsageNumber(usageData.latest_response.reasoning_tokens)],
            ["Timestamp", formatTimestamp(usageData.latest_response.timestamp)],
        ];
    }
    if (usageError) {
        return [["Local response data", getErrorMessage(usageError)]];
    }
    return [["Latest response", "No completed Codex responses found yet"]];
}

function getLocalTokenWindowRows(usageData, usageError) {
    if (usageData?.windows?.five_hours && usageData?.windows?.seven_days) {
        return [
            ["Last 5 hours", `${formatUsageNumber(usageData.windows.five_hours.total_tokens)} across ${usageData.windows.five_hours.request_count} responses`],
            ["Last 7 days", `${formatUsageNumber(usageData.windows.seven_days.total_tokens)} across ${usageData.windows.seven_days.request_count} responses`],
        ];
    }
    if (usageError) {
        return [["Local SQLite usage", getErrorMessage(usageError)]];
    }
    return [["Local SQLite usage", "Unavailable"]];
}

function getSourceRows(authData) {
    const rows = [["Codex home", getCodexHome()]];
    if (authData?.accessToken) {
        rows.push(["Remote quota endpoint", REMOTE_USAGE_URL]);
    }
    return rows;
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

function getUsageLevel(remoteUsageData, contextHealth = null) {
    const primaryPercent = Number(remoteUsageData?.rate_limit?.primary_window?.used_percent || 0);
    const secondaryPercent = Number(remoteUsageData?.rate_limit?.secondary_window?.used_percent || 0);
    const maxPercent = Math.max(primaryPercent, secondaryPercent);
    let level = USAGE_LEVELS.healthy;

    if (remoteUsageData?.rate_limit?.limit_reached || remoteUsageData?.rate_limit?.allowed === false || maxPercent >= 90) {
        level = USAGE_LEVELS.danger;
    } else if (maxPercent >= 70) {
        level = USAGE_LEVELS.warning;
    }

    if (contextHealth?.level?.severity > level.severity) {
        return contextHealth.level;
    }
    return level;
}

function getContextHealth(usageData) {
    const usedTokens = Number(usageData?.latest_response?.total_tokens || usageData?.latest_response?.input_tokens || 0);
    const modelSlug = usageData?.current_thread?.model || "";
    const metadata = loadModelContextMetadata(modelSlug);
    if (!usedTokens || !metadata?.contextWindow) {
        return null;
    }

    const effectivePercent = metadata.effectivePercent || 100;
    const effectiveLimit = Math.round(metadata.contextWindow * (effectivePercent / 100));
    if (!effectiveLimit) {
        return null;
    }

    const percent = Math.round((usedTokens / effectiveLimit) * 100);
    const remainingTokens = Math.max(effectiveLimit - usedTokens, 0);
    return {
        modelSlug,
        usedTokens,
        contextWindow: metadata.contextWindow,
        effectivePercent,
        effectiveLimit,
        percent,
        remainingTokens,
        level: getContextLevel(percent),
    };
}

function loadModelContextMetadata(modelSlug) {
    if (!modelSlug) {
        return null;
    }

    try {
        const modelsPath = path.join(getCodexHome(), "models_cache.json");
        if (!fs.existsSync(modelsPath)) {
            return null;
        }
        const modelsJson = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
        const model = (modelsJson.models || []).find((entry) => entry?.slug === modelSlug);
        if (!model) {
            return null;
        }

        return {
            contextWindow: Number(model.context_window || model.max_context_window || 0),
            effectivePercent: Number(model.effective_context_window_percent || 100),
        };
    } catch (error) {
        console.error("Codex Quota Stats could not read models_cache.json:", error);
        return null;
    }
}

function getContextLevel(percent) {
    if (percent >= 98) {
        return USAGE_LEVELS.danger;
    }
    if (percent >= 85) {
        return USAGE_LEVELS.warning;
    }
    return USAGE_LEVELS.healthy;
}

function formatUsageBar(percent, level, label) {
    const width = 124;
    const height = 8;
    const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
    const fillWidth = Math.round((safePercent / 100) * width);
    const fillColor = level?.color || USAGE_LEVELS.healthy.color;
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<rect width="${width}" height="${height}" rx="4" fill="#2d333b"/>`,
        `<rect width="${fillWidth}" height="${height}" rx="4" fill="${fillColor}"/>`,
        "</svg>",
    ].join("");
    const encodedSvg = Buffer.from(svg, "utf8").toString("base64");
    return `<img alt="${escapeHtml(label)} ${Math.round(safePercent)}%" src="data:image/svg+xml;base64,${encodedSvg}" width="${width}" height="${height}">`;
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

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
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
        buildDetailedNumbersHtml,
        buildTooltip,
        fetchRemoteUsage,
        getContextHealth,
        getCodexHome,
        httpsGetJson,
        loadAuthData,
        readUsageSnapshot,
    },
};
