import { getCodexAuthStatus } from "@/lib/codex-auth";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const status = await getCodexAuthStatus();

  return Response.json(status);
}
