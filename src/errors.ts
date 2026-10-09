export type FoxlendErrorCode =
  | "bad-domain"
  | "bad-allow"
  | "bad-ttl"
  | "bad-url"
  | "bad-scope"
  | "lend-failed"
  | "revoke-failed";

/** Every error that foxlend throws on purpose. Read `code`, not the message. */
export class FoxlendError extends Error {
  readonly code: FoxlendErrorCode;
  constructor(code: FoxlendErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FoxlendError";
    this.code = code;
  }
}
