import type { CodexAuthContext } from "../../codex/auth-context";
import type { RouteResult } from "../../router";
import type { OcxConfig } from "../../types";
import type { DataPlaneAdmission } from "../auth-cors";
import { hasForwardableCodexBearer } from "../auth-cors";
import { usesCodexForwardPoolAuth } from "./core-codex-account";

/**
 * Why a 401 did NOT reach the native-main refresh. Without this the skip is silent and looks like a
 * refresh that ran and was refused. A caller-owned `main` context carries no account id, so `kind`
 * and the resolver's own inputs are the only record of its branch. Booleans, enums and the pinned
 * account id (already in config) only; never a token.
 */
export function logCodexMain401Skip(
  req: Request, config: OcxConfig, route: RouteResult, authCtx: CodexAuthContext,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
): void {
  const forwardPoolAuth = usesCodexForwardPoolAuth(authCtx, route.provider);
  // A forward pool context reaches the native-main refresh; only the other branches are skips.
  if ((authCtx.kind === "main-pool" || authCtx.kind === "pool") && forwardPoolAuth) return;
  console.warn(
    "[codex] 401 upstream without native-main refresh:"
      + ` kind=${authCtx.kind}`
      + ` forwardableBearer=${hasForwardableCodexBearer(req.headers, config) ? "y" : "n"}`
      + ` callerBearer=${req.headers.has("authorization") ? "y" : "n"}`
      + ` admission=${admission?.source ?? "none"}`
      + ` pinned=${config.activeCodexAccountPinned ?? "none"}`
      + ` forwardPoolAuth=${forwardPoolAuth ? "y" : "n"}`
      + ` adapter=${route.provider.adapter ?? "none"} authMode=${route.provider.authMode ?? "none"}`
      + ` accountMode=${route.codexAccountMode ?? "none"}`,
  );
}
