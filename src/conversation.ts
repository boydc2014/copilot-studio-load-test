import crypto from "crypto";
import { Config } from "./config";
import { ConversationResult } from "./metrics";
import {
  DirectLineActivity,
  createConversation,
  sendActivity,
  getActivities,
} from "./directline";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runConversation(
  config: Config,
  query: string,
  phase: "warmup" | "test"
): Promise<ConversationResult> {
  const startedAt = Date.now();
  const userId = `vuser-${crypto.randomUUID()}`;

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
  let watermark: string | undefined = undefined;
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
