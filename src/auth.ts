import axios from "axios";
import crypto from "crypto";
import http from "http";
import { exec } from "child_process";
import { Config } from "./config";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AzureErrorResponse {
  error?: string;
  error_description?: string;
  error_codes?: number[];
}

function extractAzureError(err: unknown, step: string): Error {
  const axiosErr = err as {
    response?: { status?: number; data?: AzureErrorResponse };
    message?: string;
  };
  const status = axiosErr.response?.status;
  const data = axiosErr.response?.data;
  const code = data?.error;
  const description = data?.error_description?.split("\r\n")[0]; // first line only

  let message = `SSO failed at [${step}]`;
  if (status) message += ` — HTTP ${status}`;
  if (code) message += ` (${code})`;
  if (description) message += `: ${description}`;
  if (!status && !code) message += `: ${(err as Error).message ?? "unknown error"}`;

  // Actionable hints for common Azure AD errors
  if (status === 401 || code === "unauthorized_client" || code === "invalid_client") {
    message +=
      "\n  → Fix: In Azure Portal, go to App registrations → your app → Authentication → enable 'Allow public client flows'";
  } else if (code === "invalid_scope") {
    message += "\n  → Fix: Check SSO_SCOPE — it must match a scope exposed by the target app registration";
  } else if (code === "application_not_found" || status === 404) {
    message += "\n  → Fix: Check SSO_CLIENT_ID and SSO_TENANT_ID";
  }

  return new Error(message);
}

let cachedToken: {
  accessToken: string;
  expiresAtMs: number;
  refreshToken?: string;
} | null = null;

let pendingAuth: Promise<void> | null = null;

async function silentRefresh(config: Config): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.ssoClientId,
    grant_type: "refresh_token",
    refresh_token: cachedToken!.refreshToken!,
    scope: config.ssoScope,
  });
  if (config.ssoClientSecret) {
    params.append("client_secret", config.ssoClientSecret);
  }
  const response = await axios.post(
    `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/token`,
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const { access_token, refresh_token, expires_in } = response.data;
  cachedToken = {
    accessToken: access_token,
    expiresAtMs: Date.now() + (expires_in - 60) * 1000,
    refreshToken: refresh_token ?? cachedToken!.refreshToken,
  };
  return cachedToken.accessToken;
}

async function performDeviceCodeFlow(config: Config): Promise<void> {
  const dcParams = new URLSearchParams({
    client_id: config.ssoClientId,
    scope: config.ssoScope,
  });
  let dcResponse;
  try {
    dcResponse = await axios.post(
      `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/devicecode`,
      dcParams,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
  } catch (err) {
    throw extractAzureError(err, "device_code request");
  }
  const { device_code, expires_in, interval, message } = dcResponse.data;

  // Azure AD formats `message` as:
  // "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH9"
  console.log(`\n  ${message}\n`);

  const pollIntervalMs = ((interval as number) || 5) * 1000;
  const deadline = Date.now() + (expires_in as number) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      const tokenParams = new URLSearchParams({
        client_id: config.ssoClientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
      });
      const tokenResponse = await axios.post(
        `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/token`,
        tokenParams,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      const { access_token, refresh_token, expires_in: tokenExpiresIn } =
        tokenResponse.data;
      cachedToken = {
        accessToken: access_token,
        expiresAtMs: Date.now() + ((tokenExpiresIn as number) - 60) * 1000,
        refreshToken: refresh_token,
      };
      return;
    } catch (err: unknown) {
      const error = (
        err as { response?: { data?: { error?: string } } }
      ).response?.data?.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        await sleep(pollIntervalMs); // back off on slow_down
        continue;
      }
      if (error === "authorization_declined") {
        throw new Error("Sign-in was declined");
      }
      if (error === "expired_token") {
        throw new Error("Device code expired — restart and try again");
      }
      throw extractAzureError(err, "token poll");
    }
  }
  throw new Error("Device code expired — restart and try again");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; user can open manually from printed URL
}

async function performAuthCodeFlow(config: Config): Promise<void> {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const redirectUri = `http://localhost:${config.ssoRedirectPort}/callback`;

  const authUrl = new URL(
    `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/authorize`
  );
  authUrl.searchParams.set("client_id", config.ssoClientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", config.ssoScope);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Start the server first — only open the browser once we know the port is bound.
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `Failed to start local callback server on port ${config.ssoRedirectPort}: ${err.message}\n` +
            `  → Fix: Set SSO_REDIRECT_PORT to a free port, and register that redirect URI in Azure Portal`
        )
      );
    });
    server.listen(config.ssoRedirectPort);
  });
  server.unref(); // don't keep the process alive if everything else finishes

  console.log(`\n  Opening browser for sign-in...`);
  console.log(`  If the browser does not open, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url!, `http://localhost:${config.ssoRedirectPort}`);
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<h2>Sign-in failed: ${error}</h2><p>${errorDesc ?? ""}</p><p>You can close this tab.</p>`
        );
        server.close();
        reject(new Error(`SSO auth_code failed: ${error}${errorDesc ? " — " + errorDesc : ""}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>Sign-in successful!</h2><p>You can close this tab and return to the terminal.</p>`);
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });
  });

  const params = new URLSearchParams({
    client_id: config.ssoClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: config.ssoScope,
  });
  if (config.ssoClientSecret) {
    params.append("client_secret", config.ssoClientSecret);
  }

  try {
    const response = await axios.post(
      `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/token`,
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, refresh_token, expires_in } = response.data;
    cachedToken = {
      accessToken: access_token,
      expiresAtMs: Date.now() + (expires_in - 60) * 1000,
      refreshToken: refresh_token,
    };
  } catch (err) {
    throw extractAzureError(err, "auth_code token exchange");
  }
}

export async function getOAuthToken(config: Config): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < cachedToken.expiresAtMs) {
    return cachedToken.accessToken;
  }

  // Try silent refresh before prompting again
  if (cachedToken?.refreshToken) {
    try {
      return await silentRefresh(config);
    } catch {
      // fall through to full re-auth
    }
  }

  if (config.ssoGrantType === "device_code") {
    await performDeviceCodeFlow(config);
    return cachedToken!.accessToken;
  }

  if (config.ssoGrantType === "auth_code") {
    if (!pendingAuth) {
      pendingAuth = performAuthCodeFlow(config).finally(() => {
        pendingAuth = null;
      });
    }
    await pendingAuth;
    return cachedToken!.accessToken;
  }

  // client_credentials or password (ROPC)
  const params = new URLSearchParams({
    client_id: config.ssoClientId,
    client_secret: config.ssoClientSecret,
    scope: config.ssoScope,
  });
  if (config.ssoGrantType === "password") {
    params.append("grant_type", "password");
    params.append("username", config.ssoUsername);
    params.append("password", config.ssoPassword);
  } else {
    params.append("grant_type", "client_credentials");
  }

  try {
    const response = await axios.post(
      `https://login.microsoftonline.com/${config.ssoTenantId}/oauth2/v2.0/token`,
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, refresh_token, expires_in } = response.data;
    cachedToken = {
      accessToken: access_token,
      expiresAtMs: Date.now() + (expires_in - 60) * 1000,
      refreshToken: refresh_token,
    };
    return cachedToken.accessToken;
  } catch (err: unknown) {
    throw extractAzureError(err, `token request (${config.ssoGrantType})`);
  }
}
