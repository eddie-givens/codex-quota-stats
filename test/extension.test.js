"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const settings = {};
const vscodeMock = {
    StatusBarAlignment: { Right: 2 },
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

function encodeJwtPayload(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature`;
}

function writeAuthFile(codexHome, accountId) {
    const authPayload = {
        email: "edward.givens@gmail.com",
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
            email: "edward.givens@gmail.com",
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
