import { z } from "zod";
import { exchangeAnthropicAuthorizationCode } from "@/lib/anthropic-oauth";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  code: z.string().min(1),
  verifier: z.string().min(1),
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
    const tokens = await exchangeAnthropicAuthorizationCode(
      parsed.data.code,
      parsed.data.verifier,
    );

    return Response.json(tokens);
  } catch (error) {
    return new Response(
      error instanceof Error
        ? error.message
        : "Unable to exchange Anthropic authorization code.",
      { status: 400 },
    );
  }
}
