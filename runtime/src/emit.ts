// One structured JSON line per event, to stdout → CloudWatch. The only observability surface:
// every invocation is fire-and-forget, so these lines are how you debug a run after the fact.
export function emit(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}
