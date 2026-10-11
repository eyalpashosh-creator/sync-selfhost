type HandlerRequest<T> = T extends { handler(ctx: any, args: infer Req): any } ? Req : never;
type HandlerResponse<T> = T extends { handler(ctx: any, args: any): infer Res } ? Awaited<Res> : never;

export type ActionClient<Actions> = {
  [Name in keyof Actions]: (args: HandlerRequest<Actions[Name]>) => Promise<HandlerResponse<Actions[Name]>>;
};

export function createActionClient<Actions>(): ActionClient<Actions> {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return async (args: unknown) => {
        const response = await fetch("/actions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: property, args }),
        });
        const body = await response.json().catch(() => ({ error: "The server returned an unreadable response." }));
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`);
        return body;
      };
    },
  }) as ActionClient<Actions>;
}

export type ApiRequest<Api, Name extends keyof Api> = Api[Name] extends (args: infer Req) => any ? Req : never;
export type ApiResponse<Api, Name extends keyof Api> = Api[Name] extends (...args: any[]) => infer Res ? Awaited<Res> : never;
