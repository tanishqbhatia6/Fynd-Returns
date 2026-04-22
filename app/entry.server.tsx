import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import type { EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { appLogger } from "./lib/observability/logger.server";
import { assertEncryptionConfigured } from "./lib/encryption.server";

// Boot-time validation. Surfaces misconfig (missing/invalid ENCRYPTION_KEY) at
// the first request rather than at the first encrypt/decrypt call, which would
// otherwise be the moment a merchant tries to save Fynd credentials in prod.
// Logs the failure but does NOT crash the process — the readiness probe / health
// endpoint will surface the issue and operations can roll back.
try {
  assertEncryptionConfigured();
  appLogger.info({ module: "encryption" }, "Encryption key validated at startup");
} catch (err) {
  appLogger.error({ err, module: "encryption" }, "Encryption key NOT configured — secrets cannot be read or written");
}

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  try {
    addDocumentResponseHeaders(request, responseHeaders);
  } catch (err) {
    appLogger.error({ err }, "addDocumentResponseHeaders failed");
    // Don't fail the request — some routes (e.g. /api/webhooks/fynd) don't have shop context
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError: reject,
        onError: (error) => {
          responseStatusCode = 500;
          appLogger.error({ err: error }, "SSR render error");
        },
      }
    );
    setTimeout(abort, streamTimeout + 1000);
  });
}
