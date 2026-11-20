import { expect, test } from "bun:test";
import { resolveMetadataProvider } from "../../src/generated/model-metadata";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

test("xai-apikey is a separate key provider carrying the xai row's key-auth capabilities", () => {
  // Hosted gateways regenerate their key-provider list from this registry and store the xAI key
  // under this id; a missing row would drop the configured Grok key.
  const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai")!;
  const key = PROVIDER_REGISTRY.find(entry => entry.id === "xai-apikey")!;
  expect(key).toMatchObject({
    authKind: "key", adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", jawcodeBundle: "xai",
    supportsServiceTier: true, chatServiceTier: true,
    supportsOpenAiWebSearchToolFields: false, supportsResponsesCustomTools: false, parallelToolCalls: true, liveModels: true,
  });
  expect(key.deprecated).toBeUndefined();
  for (const field of ["allowKeyAuthOverride", "keyAuthServiceTier", "oauthId"] as const) expect(key[field]).toBeUndefined();
  const { id: _a, label: _b, authKind: _c, allowKeyAuthOverride: _d, keyAuthServiceTier: _e, oauthId: _f, featured: _g, note: _h,
    supportsServiceTier: _i, chatServiceTier: _j, dashboardUrl: _k, ...shared } = xai;
  expect(key).toMatchObject(shared);
  expect(KEY_LOGIN_PROVIDERS["xai-apikey"]).toMatchObject({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1" });
  expect(resolveMetadataProvider("xai-apikey")).toBe("xai");
});
