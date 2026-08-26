import { json } from "../_lib/http.js";

const runtimeEnv = (env) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...(env || {}) });
const present = (value) => typeof value === "string" && value.length > 0;

export function onRequest({ env }) {
  const config = runtimeEnv(env);
  const privateKey = present(config.GITHUB_APP_PRIVATE_KEY_B64)
    || (present(config.GITHUB_APP_PRIVATE_KEY_B64_1) && present(config.GITHUB_APP_PRIVATE_KEY_B64_2))
    || present(config.GITHUB_APP_PRIVATE_KEY);
  const checks = {
    GITHUB_APP_ID: present(config.GITHUB_APP_ID),
    GITHUB_APP_CLIENT_ID: present(config.GITHUB_APP_CLIENT_ID),
    GITHUB_APP_CLIENT_SECRET: present(config.GITHUB_APP_CLIENT_SECRET),
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_INSTALLATION_ID: present(config.GITHUB_APP_INSTALLATION_ID),
    GITHUB_OWNER: present(config.GITHUB_OWNER),
    GITHUB_REPO: present(config.GITHUB_REPO),
    ALLOWED_GITHUB_LOGIN: present(config.ALLOWED_GITHUB_LOGIN),
    SESSION_SECRET: present(config.SESSION_SECRET),
  };
  const missing = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  return json({ ok: missing.length === 0, missing, checks }, missing.length === 0 ? 200 : 503, { "Cache-Control": "no-store" });
}
