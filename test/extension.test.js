"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const settings = {};
class MarkdownString {
    constructor(value = "") {
        this.value = value;
        this.isTrusted = false;
        this.supportThemeIcons = false;
    }

    appendMarkdown(value) {
        this.value += value;
        return this;
    }
}

const vscodeMock = {
    MarkdownString,
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor {
        constructor(id) {
            this.id = id;
        }
    },
    workspace: {
        getConfiguration(section) {
            assert.equal(section, "localCodexStats");
            return {
                get(key, fallback) {
                    return Object.hasOwn(settings, key) ? settings[key] : fallback;
                },
            };
        },
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
        return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const extension = require("../extension");

test.beforeEach(() => {
    for (const key of Object.keys(settings)) {
        delete settings[key];
    }
});

function encodeJwtPayload(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature`;
}

function writeAuthFile(codexHome, accountId) {
    const authPayload = {
        email: "codex.user@example.com",
        "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_plan_type: "pro",
        },
    };
    const accessPayload = {
        "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_plan_type: "pro",
        },
        "https://api.openai.com/profile": {
            email: "codex.user@example.com",
        },
    };

    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
            tokens: {
                id_token: encodeJwtPayload(authPayload),
                access_token: encodeJwtPayload(accessPayload),
                account_id: accountId,
            },
        })
    );
}

function writeModelsCache(codexHome) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
        path.join(codexHome, "models_cache.json"),
        JSON.stringify({
            models: [
                {
                    slug: "gpt-5.5",
                    context_window: 272000,
                    effective_context_window_percent: 95,
                },
            ],
        })
    );
}

function sampleUsageData() {
    return {
        current_thread: {
            title: "Long-running feature work",
            model: "gpt-5.5",
            tokens_used: 2400648,
            updated_at: 1777342273,
        },
        latest_response: {
            timestamp: 1777342261,
            input_tokens: 78083,
            cached_input_tokens: 77184,
            output_tokens: 66,
            reasoning_tokens: 0,
            total_tokens: 78149,
        },
        windows: {
            five_hours: { total_tokens: 1670987, request_count: 16 },
            seven_days: { total_tokens: 5250764, request_count: 72 },
        },
    };
}

function sampleRemoteUsageData() {
    return {
        rate_limit: {
            allowed: true,
            primary_window: {
                used_percent: 42,
                reset_after_seconds: 3600,
            },
            secondary_window: {
                used_percent: 58,
                reset_after_seconds: 172800,
            },
        },
    };
}

test.after(() => {
    Module._load = originalLoad;
});

test("loadAuthData uses configured account ID before auth.json account ID", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-stats-"));
    writeAuthFile(codexHome, "auth-json-account");
    settings.codexHome = codexHome;
    settings.accountId = "configured-account";

    const authData = await extension._test.loadAuthData();

    assert.equal(authData.accountId, "configured-account");
    assert.equal(authData.accountIdSource, "settings");
});

test("context health uses the latest status-bar token value instead of cumulative thread tokens", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-stats-"));
    settings.codexHome = codexHome;
    writeModelsCache(codexHome);

    const contextHealth = extension._test.getContextHealth(sampleUsageData());

    assert.equal(contextHealth.usedTokens, 78149);
    assert.equal(contextHealth.effectiveLimit, 258400);
    assert.equal(contextHealth.percent, 30);
    assert.equal(contextHealth.level.label, "Healthy");
});

test("compact tooltip shows context and quota bars with a numbers link", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-stats-"));
    settings.codexHome = codexHome;
    writeModelsCache(codexHome);

    const tooltip = extension._test.buildTooltip(
        { email: "codex.user@example.com", planType: "pro" },
        sampleUsageData(),
        sampleRemoteUsageData(),
        null,
        null
    );

    assert.match(tooltip.value, /### Context\n\n/);
    assert.match(tooltip.value, /Current context: 30% used/);
    assert.equal(tooltip.isTrusted, true);
    assert.equal(tooltip.supportHtml, true);
    assert.match(tooltip.value, /<img alt="Context usage 30%" src="data:image\/svg\+xml;base64,/);
    assert.match(tooltip.value, /<img alt="Last 5 hours usage 42%" src="data:image\/svg\+xml;base64,/);
    assert.match(tooltip.value, /\[Show numbers\]\(command:localCodexStats.showNumbers\)/);
    assert.doesNotMatch(tooltip.value, /Total tokens:/);
});

test("tooltip stays compact after detailed numbers are requested", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-stats-"));
    settings.codexHome = codexHome;
    writeModelsCache(codexHome);
    extension._test.buildDetailedNumbersHtml(
        { email: "codex.user@example.com", planType: "pro" },
        sampleUsageData(),
        sampleRemoteUsageData(),
        null,
        null
    );

    const tooltip = extension._test.buildTooltip(
        { email: "codex.user@example.com", planType: "pro" },
        sampleUsageData(),
        sampleRemoteUsageData(),
        null,
        null
    );

    assert.match(tooltip.value, /\[Show numbers\]\(command:localCodexStats.showNumbers\)/);
    assert.doesNotMatch(tooltip.value, /\[Hide numbers\]/);
    assert.doesNotMatch(tooltip.value, /Thread tokens: 2.4M \(2,400,648\)/);
    assert.doesNotMatch(tooltip.value, /Total tokens: 78.1K \(78,149\)/);
});

test("detailed numbers panel document includes full usage numbers", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-stats-"));
    settings.codexHome = codexHome;
    writeModelsCache(codexHome);

    const html = extension._test.buildDetailedNumbersHtml(
        { email: "codex.user@example.com", planType: "pro" },
        sampleUsageData(),
        sampleRemoteUsageData(),
        null,
        null
    );

    assert.match(html, /Codex Quota Numbers/);
    assert.match(html, /Thread tokens/);
    assert.match(html, /2.4M \(2,400,648\)/);
    assert.match(html, /Current context tokens/);
    assert.match(html, /78.1K \(78,149\)/);
    assert.match(html, /Last 5 hours/);
    assert.match(html, /1.7M \(1,670,987\) across 16 responses/);
    assert.doesNotMatch(html, /command:localCodexStats.toggleNumbers/);
});
