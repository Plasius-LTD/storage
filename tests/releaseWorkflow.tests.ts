import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertReleaseSnapshot } = require("../scripts/select-release-snapshot.cjs") as {
  assertReleaseSnapshot(input: {
    dispatchSha: string;
    baseSha: string;
    packageVersion: string;
    changelog: string;
    targetVersion: string;
  }): string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("release snapshot selection", () => {
  it("binds publication to the immutable workflow-dispatch commit", () => {
    const dispatchSha = "a".repeat(40);
    expect(
      assertReleaseSnapshot({
        dispatchSha,
        baseSha: dispatchSha,
        packageVersion: "1.1.0",
        changelog: "## [1.1.0] - 2026-07-13\n",
        targetVersion: "1.1.0",
      })
    ).toBe(dispatchSha);
  });

  it("rejects base movement and missing release metadata", () => {
    expect(() =>
      assertReleaseSnapshot({
        dispatchSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        packageVersion: "1.0.19",
        changelog: "## [Unreleased]\n",
        targetVersion: "1.1.0",
      })
    ).toThrow(/start a new CD workflow dispatch/u);

    const dispatchSha = "a".repeat(40);
    expect(() =>
      assertReleaseSnapshot({
        dispatchSha,
        baseSha: dispatchSha,
        packageVersion: "1.1.0",
        changelog: "## [Unreleased]\n",
        targetVersion: "1.1.0",
      })
    ).toThrow(/missing the changelog release section/u);
  });

  it("returns the exact protected-branch head from release preparation", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release-prepare.yml", import.meta.url),
      "utf8"
    );
    expect(workflow).toContain("COMMIT_SHA=$(git rev-parse HEAD)");
    expect(workflow).not.toContain(
      'git log -n 1 --format=%H -- "${PACKAGE_JSON}"'
    );
  });

  it("keeps every embedded release-preparation JavaScript block syntactically valid", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release-prepare.yml", import.meta.url),
      "utf8"
    );
    const scripts = Array.from(
      workflow.matchAll(/node -e '\n([\s\S]*?)\n\s*'(?=[\s)]|$)/gu),
      (match) => match[1]
    );

    expect(scripts).toHaveLength(3);
    for (const script of scripts) {
      expect(() => new Function("require", "process", script)).not.toThrow();
    }
  });

  it("rejects a moved remote ref while retaining immutable Git-object reads", async () => {
    const repository = await mkdtemp(join(tmpdir(), "storage-release-"));
    temporaryDirectories.push(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Release Test");
    git(repository, "config", "user.email", "release-test@example.invalid");
    await writeFile(join(repository, "package.json"), '{"version":"1.1.0"}\n');
    await writeFile(join(repository, "CHANGELOG.md"), "## [1.1.0] - 2026-07-13\n");
    git(repository, "add", "package.json", "CHANGELOG.md");
    git(repository, "commit", "-m", "prepare release");
    const dispatchSha = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "update-ref", "refs/remotes/origin/main", dispatchSha);

    const script = new URL("../scripts/select-release-snapshot.cjs", import.meta.url);
    const environment = {
      ...process.env,
      DISPATCH_SHA: dispatchSha,
      BASE_BRANCH: "main",
      PACKAGE_JSON: "package.json",
      CHANGELOG_PATH: "CHANGELOG.md",
      TARGET_VERSION: "1.1.0",
    };
    expect(
      execFileSync(process.execPath, [script.pathname], {
        cwd: repository,
        encoding: "utf8",
        env: environment,
      })
    ).toBe(dispatchSha);

    await writeFile(join(repository, "README.md"), "concurrent change\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "advance base");
    git(repository, "update-ref", "refs/remotes/origin/main", git(repository, "rev-parse", "HEAD").trim());

    expect(() =>
      execFileSync(process.execPath, [script.pathname], {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      })
    ).toThrow();
  });
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" });
}
