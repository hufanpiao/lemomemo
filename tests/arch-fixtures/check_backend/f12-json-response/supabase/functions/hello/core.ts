// F12 样例：自己又定义一份 json(
export function json(status: number, body: unknown): Response {
  return new Response(String(body), { status });
}
