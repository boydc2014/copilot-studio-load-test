import axios, { AxiosInstance } from "axios";

export interface DirectLineConversation {
  conversationId: string;
  token: string;
  expires_in: number;
  streamUrl?: string;
}

export interface OAuthCardContent {
  connectionName: string;
  text?: string;
}

export interface DirectLineAttachment {
  contentType: string;
  content: OAuthCardContent | unknown;
}

export interface DirectLineActivity {
  id: string;
  type: string;
  from: { id: string; role?: string };
  text?: string;
  timestamp: string;
  name?: string;
  attachments?: DirectLineAttachment[];
  value?: { status?: number; [key: string]: unknown };
}

export interface DirectLineActivitySet {
  activities: DirectLineActivity[];
  watermark: string;
}

function makeClient(token: string): AxiosInstance {
  return axios.create({
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 10000,
  });
}

export async function createConversation(
  baseUrl: string,
  secret: string
): Promise<DirectLineConversation> {
  const client = makeClient(secret);
  const response = await client.post<DirectLineConversation>(
    `${baseUrl}/conversations`
  );
  return response.data;
}

export async function sendWebchatJoin(
  baseUrl: string,
  token: string,
  conversationId: string,
  userId: string
): Promise<void> {
  const client = makeClient(token);
  await client.post(`${baseUrl}/conversations/${conversationId}/activities`, {
    type: "event",
    name: "webchat/join",
    from: { id: userId },
  });
}

export async function sendActivity(
  baseUrl: string,
  token: string,
  conversationId: string,
  text: string,
  userId: string
): Promise<{ id: string }> {
  const client = makeClient(token);
  const response = await client.post<{ id: string }>(
    `${baseUrl}/conversations/${conversationId}/activities`,
    {
      type: "message",
      from: { id: userId },
      text,
    }
  );
  return response.data;
}

export async function getActivities(
  baseUrl: string,
  token: string,
  conversationId: string,
  watermark?: string
): Promise<DirectLineActivitySet> {
  const client = makeClient(token);
  const url = watermark
    ? `${baseUrl}/conversations/${conversationId}/activities?watermark=${watermark}`
    : `${baseUrl}/conversations/${conversationId}/activities`;
  const response = await client.get<DirectLineActivitySet>(url);
  return response.data;
}

export async function sendTokenExchange(
  baseUrl: string,
  token: string,
  conversationId: string,
  userId: string,
  botActivityId: string,
  connectionName: string,
  oauthToken: string
): Promise<void> {
  const client = makeClient(token);
  await client.post(`${baseUrl}/conversations/${conversationId}/activities`, {
    type: "invoke",
    name: "signin/tokenExchange",
    from: { id: userId },
    value: {
      id: botActivityId,
      connectionName,
      token: oauthToken,
    },
  });
}

export function findOAuthCard(
  activities: DirectLineActivity[]
): { activity: DirectLineActivity; connectionName: string } | null {
  for (const activity of activities) {
    if (activity.type === "message" && activity.attachments) {
      for (const attachment of activity.attachments) {
        if (attachment.contentType === "application/vnd.microsoft.card.oauth") {
          const content = attachment.content as OAuthCardContent;
          return { activity, connectionName: content.connectionName };
        }
      }
    }
  }
  return null;
}
