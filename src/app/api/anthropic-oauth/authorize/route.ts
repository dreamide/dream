import { z } from "zod";
import {
  type AnthropicOAuthMode,
  createAnthropicAuthorizationUrl,
  generateAnthropicPkceVerifier,
} from "@/lib/anthropic-oauth";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  mode: z.enum(["max", "console"]).default("max"),
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

  const mode = parsed.data.mode as AnthropicOAuthMode;
  const verifier = generateAnthropicPkceVerifier();
  const url = createAnthropicAuthorizationUrl(mode, verifier);

  return Response.json({
    url,
    verifier,
  });
}
