import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OAuthCallbackFlow, loopbackBindHostnames } from "../../src/oauth/callback-server";
import type { OAuthController } from "../../src/oauth/types";
import { XaiOAuthFlow } from "../../src/oauth/xai";
import { repoPath } from "../helpers/repo-root";

describe("loopbackBindHostnames", () => {
  test("localhost redirect over IPv4 bind also binds ::1 (Windows resolves localhost to ::1 first)", () => {
    expect(loopbackBindHostnames("localhost", "127.0.0.1")).toEqual(["127.0.0.1", "::1"]);
    expect(loopbackBindHostnames("LOCALHOST", "127.0.0.1")).toEqual(["127.0.0.1", "::1"]);
  });

  test("explicit IPv4 redirect hosts keep a single IPv4 listener", () => {
    expect(loopbackBindHostnames("127.0.0.1", "127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  test("non-default binds are never widened", () => {
    expect(loopbackBindHostnames("localhost", "::1")).toEqual(["::1"]);
    expect(loopbackBindHostnames("example.test", "0.0.0.0")).toEqual(["0.0.0.0"]);
  });

  test("an occupied IPv6 loopback abandons the whole port instead of leaving ::1 to a foreign listener", () => {
    // localhost may resolve to ::1 first — silently serving IPv4-only while another
    // process holds ::1:<port> would hand the OAuth callback (auth code) to that process.
    const source = readFileSync(repoPath("src", "oauth", "callback-server.ts"), "utf8");
    expect(source).toContain('import { isAddrInUse } from "../server/ports";');
    const createServers = source.slice(source.indexOf("#createServers(port: number"), source.indexOf("#handleCallback(req: Request"));
    expect(createServers).toContain("if (isAddrInUse(err))");
    expect(createServers).toContain("server.stop(true)");
    expect(createServers).toContain("throw err");
  });
});

describe("callback wait", () => {
  const ctrl = {} as OAuthController;

  test("the xAI browser sign-in waits 20 minutes for its redirect", () => {
    expect(new XaiOAuthFlow(ctrl).timeoutMs).toBe(1_200_000);
  });

  test("a flow that sets no wait keeps the 5-minute default", () => {
    class PlainFlow extends OAuthCallbackFlow {
      async generateAuthUrl(): Promise<{ url: string }> {
        return { url: "http://127.0.0.1/" };
      }
      async exchangeToken(): Promise<never> {
        throw new Error("not used");
      }
    }
    expect(new PlainFlow(ctrl, 0).timeoutMs).toBe(300_000);
    expect(new PlainFlow(ctrl, { preferredPort: 0 }).timeoutMs).toBe(300_000);
  });
});
