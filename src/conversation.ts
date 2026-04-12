import crypto from "crypto";
import { Config } from "./config";
import { ConversationResult } from "./metrics";
import {
  DirectLineActivity,
  createConversation,
  sendActivity,
  getActivities,
  sendStartConversation,
  sendTokenExchange,
  findOAuthCard,
} from "./directline";
import { getOAuthToken, getUserIdFromToken } from "./auth";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runConversation(
  config: Config,
  query: string,
  phase: "warmup" | "test"
): Promise<ConversationResult> {
  const startedAt = Date.now();
  let userId = `vuser-${crypto.randomUUID()}`;

  // Create conversation
  let conversationId: string;
  let token: string;
  try {
    const conv = await createConversation(
      config.directlineBaseUrl,
      config.directlineSecret
    );
    conversationId = conv.conversationId;
    token = conv.token;
  } catch (err) {
    return {
      phase,
      status: "error",
      query,
      latencyMs: Date.now() - startedAt,
      errorMessage: `createConversation failed: ${(err as Error).message}`,
      startedAt,
    };
  }

  // Main polling watermark — advanced by SSO steps so the query loop only
  // sees activities that arrive after the SSO pre-flight is complete.
  let watermark: string | undefined = undefined;

  // SSO pre-flight
  if (config.ssoEnabled) {
    // Step 1: acquire OAuth token
    let oauthToken: string;
    try {
      oauthToken = await getOAuthToken(config);
      userId = getUserIdFromToken(oauthToken);
    } catch (err) {
      return {
        phase,
        status: "error",
        query,
        latencyMs: Date.now() - startedAt,
        errorMessage: `SSO token acquisition failed: ${(err as Error).message}`,
        conversationId,
        startedAt,
      };
    }

    // Step 2: send webchat/join event to trigger the bot's SSO topic
    try {
      await sendStartConversation(
        config.directlineBaseUrl,
        token,
        conversationId,
        userId
      );
    } catch (err) {
      return {
        phase,
        status: "error",
        query,
        latencyMs: Date.now() - startedAt,
        errorMessage: `SSO pre-flight failed: webchat/join error: ${(err as Error).message}`,
        conversationId,
        startedAt,
      };
    }

    // Step 3: poll for OAuthCard from bot
    const ssoDeadline = Date.now() + config.ssoTimeoutMs;
    const ssoActivities: DirectLineActivity[] = [];
    let oauthCard: { activity: DirectLineActivity; connectionName: string } | null = null;

    while (Date.now() < ssoDeadline) {
      await sleep(config.pollIntervalMs);
      try {
        const activitySet = await getActivities(
          config.directlineBaseUrl,
          token,
          conversationId,
          watermark
        );
        watermark = activitySet.watermark;
        ssoActivities.push(...activitySet.activities);
        oauthCard = findOAuthCard(ssoActivities);
        if (oauthCard) break;
      } catch {
        // transient error — keep polling
      }
    }

    if (!oauthCard) {
      // Bot already has the user's token cached (recognised the oid) — no challenge needed.
      // Skip token exchange and proceed directly to the query.
    } else {
      // Step 4: send token exchange
      try {
        await sendTokenExchange(
          config.directlineBaseUrl,
          token,
          conversationId,
          userId,
          oauthCard.activity.id,
          oauthCard.connectionName,
          oauthToken
        );
      } catch (err) {
        return {
          phase,
          status: "error",
          query,
          latencyMs: Date.now() - startedAt,
          errorMessage: `SSO pre-flight failed: sendTokenExchange error: ${(err as Error).message}`,
          conversationId,
          startedAt,
          activities: ssoActivities,
        };
      }

      // Step 5: poll for invoke response with status 200
      const exchangeDeadline = Date.now() + config.ssoTimeoutMs;

      while (Date.now() < exchangeDeadline) {
        await sleep(config.pollIntervalMs);
        try {
          const activitySet = await getActivities(
            config.directlineBaseUrl,
            token,
            conversationId,
            watermark
          );
          watermark = activitySet.watermark;
          ssoActivities.push(...activitySet.activities);

          const invokeResponse = activitySet.activities.find(
            (a) => a.type === "invokeResponse" && a.value?.status === 200
          );
          if (invokeResponse) break;

          // Check for non-200 invoke response indicating failure
          const failedInvoke = activitySet.activities.find(
            (a) => a.type === "invokeResponse" && a.value?.status !== undefined && a.value.status !== 200
          );
          if (failedInvoke) {
            return {
              phase,
              status: "error",
              query,
              latencyMs: Date.now() - startedAt,
              errorMessage: `SSO pre-flight failed: token exchange rejected (status ${failedInvoke.value?.status})`,
              conversationId,
              startedAt,
              activities: ssoActivities,
            };
          }
        } catch {
          // transient error — keep polling
        }
      }
    }
  }

  // Send message — latency starts here
  const sendStartMs = Date.now();
  try {
    await sendActivity(
      config.directlineBaseUrl,
      token,
      conversationId,
      query,
      userId
    );
  } catch (err) {
    return {
      phase,
      status: "error",
      query,
      latencyMs: Date.now() - sendStartMs,
      errorMessage: `sendActivity failed: ${(err as Error).message}`,
      conversationId,
      startedAt,
    };
  }

  // Poll for bot response
  const deadline = Date.now() + config.responseTimeoutMs;
  const allActivities: DirectLineActivity[] = [];

  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);

    let activitySet;
    try {
      activitySet = await getActivities(
        config.directlineBaseUrl,
        token,
        conversationId,
        watermark
      );
    } catch (err) {
      // Transient poll error — keep trying until deadline
      continue;
    }

    watermark = activitySet.watermark;
    allActivities.push(...activitySet.activities);

    const botReplies = activitySet.activities.filter(
      (a) => a.type === "message" && a.from.role === "bot"
    );

    if (botReplies.length > 0) {
      const botTimestamp = new Date(botReplies[0].timestamp).getTime();
      return {
        phase,
        status: "success",
        query,
        latencyMs: botTimestamp - sendStartMs,
        conversationId,
        startedAt,
        activities: allActivities,
      };
    }
  }

  return {
    phase,
    status: "timeout",
    query,
    latencyMs: config.responseTimeoutMs,
    conversationId,
    startedAt,
    activities: allActivities,
  };
}
