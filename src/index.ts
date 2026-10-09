// The public API of foxlend.
export { FoxlendError, type FoxlendErrorCode } from "./errors.js";
export { hostOf, loanPatterns, siteOf, withDefaultRule, type PatternInput, type PublicSuffixApi } from "./site.js";
export { planCopy, type Cookie, type CookieSetDetails, type CopyOptions, type SkippedCookie } from "./cookies.js";
export { judge, type BlockReason, type LoanState, type RequestInfo, type Verdict } from "./egress.js";
