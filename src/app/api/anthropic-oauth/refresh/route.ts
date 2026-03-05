import { z } from "zod";
import { refreshAnthropicAccessToken } from "@/lib/anthropic-oauth";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return new Response("Invalid JSON payload.", { status: 400 });
  }

  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return new Response(parsed.error.message, { status: 400 });
  }

  try {
    const tokens = await refreshAnthropicAccessToken(parsed.data.refreshToken);
    return Response.json(tokens);
  } catch (error) {
    return new Response(
      error instanceof Error
        ? error.message
        : "Unable to refresh Anthropic access token.",
      { status: 400 },
    );
  }
}
