import { DidResolver, MemoryCache } from "@atproto/did-resolver";
import { invariant } from "../util/invariant";
import {
  RequestConfig,
  niceRequestConfig,
  niceRequestWrapper,
} from "../util/niceRequestWrapper";
import { AxiosError } from "axios";
import { Trace } from "../util/Trace";

const didCache = new MemoryCache();
const didResolver = new DidResolver(
  { plcUrl: "https://plc.directory" },
  didCache
);

const requestConfigOverride: Partial<RequestConfig<string, string | null>> = {
  shouldRetryError(err: Error) {
    if ((err as AxiosError).isAxiosError) {
      const axiosError = err as AxiosError;
      const status = axiosError.response?.status;
      // Retry on 5XX or connection aborted
      if (status && status >= 500 && status < 600) {
        return true;
      } else if (status === 429) {
        return true;
      } else if (axiosError.code === "ECONNABORTED") {
        return true;
      }
    }
    return false;
  },
  shouldSlowRetry(err: Error) {
    if ((err as AxiosError).isAxiosError) {
      const axiosError = err as AxiosError;
      return axiosError.status === 429;
    }
    return false;
  },

  cacheKey(did: string) {
    return did;
  },
  serialize(result: string | null) {
    return JSON.stringify(result);
  },
  deserialize(serialized: string) {
    // @todo: deal with old-non-json entries
    if (serialized.startsWith('"') || serialized === "null") {
      return JSON.parse(serialized);
    } else {
      return serialized;
    }
  },
};

async function unwrappedResolveDid(trc: Trace, did: string) {
  const resolved = await didResolver.resolveDid(did);

  // did not found
  if (resolved === null) {
    return null;
  }

  invariant(
    resolved?.alsoKnownAs?.length,
    "Could not resolve did to a username: %s",
    did
  );

  const [url] = resolved.alsoKnownAs;
  invariant(url.startsWith("at://"), "Expected url to start with at://");
  return url.substring("at://".length);
}

export const resolveDid = niceRequestWrapper(
  {
    ...niceRequestConfig["resolveDid"],
    ...requestConfigOverride,
  },
  unwrappedResolveDid
);

export const resolveDidSlow = niceRequestWrapper(
  {
    ...niceRequestConfig["resolveDidSlow"],
    ...requestConfigOverride,
  },
  unwrappedResolveDid
);
