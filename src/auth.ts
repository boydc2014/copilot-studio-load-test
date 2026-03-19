import axios from "axios";
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
