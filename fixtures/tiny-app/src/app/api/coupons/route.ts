export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { code?: string };
  if (!body.code) {
    return new Response(JSON.stringify({ error: "code required" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, code: body.code }), {
    headers: { "content-type": "application/json" },
  });
}
