import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  callsTo,
  methodsOf,
  runEnforcePrTarget,
  type HarnessResult,
} from "../helpers/enforce-pr-target-harness";
import { repoRoot } from "../helpers/repo-root";

// The fork cuts tagged releases from release/<semver>-vadymhimself.<n>, and
// fixes for a cut release target that line. These scenarios run the real
// enforce-target script: a same-repository branch into that exact line is a
// correct target, while a PR from another repository or any lookalike base
// stays wrong_base.

const RELEASE_LINE = "release/2.65.0-vadymhimself.15";
const SAME_REPO_HEAD = {
  ref: "fix/release-line",
  sha: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
  repo: { name: "opencodex", owner: { login: "lidge-jun" } },
};
const TITLE_PREFIX = "[WRONG BRANCH] ";

async function enforceScript(): Promise<string> {
  const text = await Bun.file(
    join(repoRoot(), ".github", "workflows", "enforce-pr-target.yml")
  ).text();
  const workflow = Bun.YAML.parse(text) as {
    jobs?: Record<string, { steps?: Array<{ with?: { script?: string } }> }>;
  };
  const step = workflow.jobs?.["enforce-target"]?.steps?.find(
    candidate => typeof candidate.with?.script === "string"
  );
  expect(step).toBeDefined();
  return String(step!.with!.script);
}

async function run(options: Parameters<typeof runEnforcePrTarget>[1]) {
  return runEnforcePrTarget(await enforceScript(), options);
}

function failed(result: HarnessResult): boolean {
  return result.warnings.some(warning => warning.startsWith("setFailed:"));
}

function titleUpdates(result: HarnessResult): string[] {
  return (callsTo(result, "pulls.update") as Array<{ title?: string }>)
    .map(call => call.title)
    .filter((title): title is string => typeof title === "string");
}

function draftConversions(result: HarnessResult): number {
  return (callsTo(result, "graphql") as Array<{ query: string }>).filter(call =>
    call.query.includes("convertPullRequestToDraft")
  ).length;
}

describe("enforce-pr-target: fork release line", () => {
  test("a same-repo branch into the release line is a correct target", async () => {
    const result = await run({
      pr: {
        base: { ref: RELEASE_LINE },
        head: SAME_REPO_HEAD,
        title: "fix(pool): rotate accounts",
        draft: false,
      },
      authorPermission: "write",
    });

    // Ancestry compares run only for an accepted base; the stacked-base
    // lookup (`pulls.list`) runs only for a rejected one.
    expect(methodsOf(result)).toContain("repos.compareCommitsWithBasehead");
    expect(methodsOf(result)).not.toContain("pulls.list");
    expect(titleUpdates(result)).toEqual([]);
    expect(draftConversions(result)).toBe(0);
    expect(failed(result)).toBe(false);
    expect(result.logs.join(" ")).toContain("All PR quality gates passed");
  });

  test("a PR from another repository into the release line stays wrong_base", async () => {
    const result = await run({
      pr: {
        base: { ref: RELEASE_LINE },
        title: "fix(pool): rotate accounts",
        draft: false,
      },
      authorPermission: "write",
    });

    expect(titleUpdates(result)).toEqual([`${TITLE_PREFIX}fix(pool): rotate accounts`]);
    expect(draftConversions(result)).toBe(1);
    expect(failed(result)).toBe(true);
  });

  for (const base of [
    "release/2.65.0",
    "release/maintenance",
    "release/2.65.0-vadymhimself.15-extra",
    "release/2.65.0-vadymhimself",
    "release/2.65-vadymhimself.15",
    "release/2.65.0-someoneelse.15",
    "xrelease/2.65.0-vadymhimself.15",
  ]) {
    test(`a same-repo branch into lookalike base ${base} stays wrong_base`, async () => {
      const result = await run({
        pr: { base: { ref: base }, head: SAME_REPO_HEAD, title: "Add a thing", draft: false },
        authorPermission: "write",
      });

      expect(titleUpdates(result)).toEqual([`${TITLE_PREFIX}Add a thing`]);
      expect(draftConversions(result)).toBe(1);
      expect(failed(result)).toBe(true);
    });
  }
});
