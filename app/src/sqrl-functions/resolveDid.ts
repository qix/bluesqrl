import { DidResolver, MemoryCache } from "@atproto/did-resolver";
import { invariant } from "../util/invariant";

const didCache = new MemoryCache();

const didResolver = new DidResolver(
  { plcUrl: "https://plc.directory" },
  didCache
);

export async function resolveDid(did: string) {
  const resolved = await didResolver.resolveDid(did);

  invariant(
    resolved?.alsoKnownAs?.length,
    "Could not resolve did to a username"
  );
  const [url] = resolved.alsoKnownAs;
  invariant(url.startsWith("at://"), "Expected url to start with at://");
  return url.substring("at://".length);
}
