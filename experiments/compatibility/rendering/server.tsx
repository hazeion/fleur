/** Disposable trusted renderer fixture, not a restricted Fleur application worker. */
import { renderToString } from "preact-render-to-string";
import { Editor } from "./island";
import { validateProps } from "./props";

// Fake canaries, never credentials. These must be absent from browser chunks/maps.
const SERVER_SECRET = "FLEUR_SERVER_SECRET_CANARY_23";
function serverOnlyExerciseLookup() {
  if (SERVER_SECRET.length === 0) throw new Error("Missing fixture canary");
  return "Server exercise";
}
function ServerName({ name }: { name: string }) {
  return <span id="server-name" aria-label="Saved server name">{name}</span>;
}
function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
Bun.serve({
  hostname: "127.0.0.1", port: 43287,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/")) {
      const path = url.pathname.slice("/assets/".length);
      if (!/^[a-zA-Z0-9_.-]+$/.test(path)) return new Response(null, { status: 404 });
      const file = Bun.file(`./dist/${path}`);
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/refresh") {
      const props = { name: "Updated exercise", revision: 2 };
      // A deliberately corrupt response exercises the browser boundary separately.
      const publicProps = url.searchParams.has("invalid") ? { ...props, secret: "forbidden" } : validateProps(props);
      return Response.json({ html: renderToString(<ServerName name={props.name} />), props: publicProps });
    }
    if (url.pathname !== "/") return new Response(null, { status: 404 });
    try {
      const props = validateProps({
        name: serverOnlyExerciseLookup(), revision: 1,
        ...(url.searchParams.has("invalid") ? { secret: "forbidden" } : {}),
      });
      const region = renderToString(<section id="region">
        <ServerName name={props.name} />
        <div id="editor" data-island-key="exercise-editor"><Editor {...props} /></div>
      </section>);
      const publicProps = url.searchParams.has("invalid-hydration") ? { ...props, secret: "forbidden" } : props;
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Rendering experiment</title></head><body>${region}<p role="status" aria-label="Fixture state"></p><script type="application/json" id="props">${jsonScript(publicProps)}</script><script type="module" src="/assets/client.js"></script></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("Rejected public props", { status: 422 });
    }
  },
});
