import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// Product photos (and other stored images) are served publicly by storage id.
// Storage ids are random Convex UUIDs — unguessable, so this doubles as the
// access key (same rule as everywhere else: never expose enumerable ids).
http.route({
  path: "/api/getImage",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const storageId = new URL(request.url).searchParams.get("storageId");
    if (!storageId) return new Response(null, { status: 400 });
    const blob = await ctx.storage.get(storageId);
    if (!blob) return new Response(null, { status: 404 });
    return new Response(blob, {
      headers: {
        "content-type": blob.type,
        // Storage ids are immutable, so the browser may cache forever.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }),
});

export default http;
