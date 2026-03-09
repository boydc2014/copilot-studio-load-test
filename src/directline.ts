import axios, { AxiosInstance } from "axios";

export interface DirectLineConversation {
  conversationId: string;
  token: string;
  expires_in: number;
  streamUrl?: string;
}

export interface DirectLineActivity {
  id: string;
  type: string;
  from: { id: string; role?: string };
  text?: string;
  timestamp: string;
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
