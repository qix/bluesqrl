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

const requestConfigOverride: Partial<RequestConfig<string, string>> = {
  shouldRetryError(err: Error) {
    if ((err as AxiosError).isAxiosError) {
      const axiosError = err as AxiosError;
      const status = axiosError.response?.status;
      // Retry on 5XX or connection aborted
      if (status && status >= 500 && status < 600) {
        return true;
      } else if (status === 429) {
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
  serialize(username: string) {
    return username;
  },
  deserialize(username: string) {
    return username;
  },
};

async function unwrappedResolveDid(trc: Trace, did: string) {
  const resolved = await didResolver.resolveDid(did);

  invariant(
    resolved?.alsoKnownAs?.length,
    "Could not resolve did to a username"
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
