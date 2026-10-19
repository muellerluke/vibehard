import { normalizeNote } from "../../lib/notes";

interface HelloRequest {
  query: { name?: string | string[] };
}

interface HelloResponse {
  json: (body: unknown) => void;
}

export default function handler(req: HelloRequest, res: HelloResponse): void {
  const raw = req.query.name;
  const name = Array.isArray(raw) ? (raw[0] ?? "world") : (raw ?? "world");
  res.json({ hello: normalizeNote(name) });
}
