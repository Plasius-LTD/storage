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

  it("consumes the complete tar listing while verifying built output", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/cd.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).not.toMatch(
      /tar -tzf "\$\{TARBALL\}" \| grep -E[q]? '\^package\/dist/gu
    );
    expect(workflow).toContain(
      `tar -tzf "\${TARBALL}" | awk '\n            /^package\\/dist(\\/|$)/ { found = 1 }\n            END { exit(found ? 0 : 1) }\n          '`
    );
  });

  it("publishes the verified tarball as an explicit local package path", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/cd.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).toContain(
      'npm publish "./${TARBALL}" --ignore-scripts "${PUBLISH_ARGS[@]}"'
    );
    expect(workflow).not.toContain(
      'npm publish "${TARBALL}" --ignore-scripts "${PUBLISH_ARGS[@]}"'
    );
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

describe("public release notes", () => {
  it("contains no placeholder marker in the package changelog", async () => {
    const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(/\(placeholder\)/iu.test(changelog)).toBe(false);
  });

  it("never seeds placeholder text from release preparation", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release-prepare.yml", import.meta.url),
      "utf8"
    );
    expect(/\(placeholder\)/iu.test(workflow)).toBe(false);
  });
});

describe("changelog promotion", () => {
  const metadata = {
    version: "1.2.0",
    date: "2026-11-09",
    tag: "v1.2.0",
    repository: "Plasius-LTD/storage",
  };
  const base = "https://github.com/Plasius-LTD/storage";
  const historical = "## [1.1.0] - 2026-10-23\n\n### Added\n\n- Existing API.\n\n";
  const oldReference = `[1.1.0]: ${base}/releases/tag/v1.1.0\n`;

  it("promotes real notes, preserves history and refreshes release links", async () => {
    const { promoteChangelog } = await import("../scripts/release-changelog.mjs");
    const notes = "- **Fixed**\n  - Ship meaningful release notes.";
    const input = `# Changelog\n\n## [Unreleased]\n\n${notes}\n\n${historical}` +
      `[Unreleased]: ${base}/compare/v1.1.0...HEAD\n${oldReference}`;

    const output = promoteChangelog(input, metadata);
    expect(output).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-11-09\n\n${notes}\n\n${historical}` +
      `[Unreleased]: ${base}/compare/v1.2.0...HEAD\n${oldReference}` +
      `[1.2.0]: ${base}/releases/tag/v1.2.0\n`
    );
    expect(promoteChangelog(output, metadata)).toBe(output);
  });

  it("supports standard category headings and an unbracketed Unreleased heading", async () => {
    const { promoteChangelog } = await import("../scripts/release-changelog.mjs");
    const input = "## Unreleased\r\n\r\n### Added\r\n\r\n- First real note.\r\n";
    const output = promoteChangelog(input, metadata);
    expect(output).toContain("## Unreleased\r\n\r\n## [1.2.0] - 2026-11-09\r\n");
    expect(output).toContain("### Added\r\n\r\n- First real note.\r\n");
    expect(output).toContain(`[Unreleased]: ${base}/compare/v1.2.0...HEAD\r\n`);
  });

  it.each(["", "### Fixed\n", "- **Fixed**\n  -   \n", "- (no notable changes)\n",
    "### Fixed\n\n- Fix release notes.\n\n### Added\n"])(
    "fails closed if notes or any declared category are empty (%j)",
    async (notes) => {
      const { promoteChangelog } = await import("../scripts/release-changelog.mjs");
      expect(() => promoteChangelog(`## [Unreleased]\n\n${notes}`, metadata)).toThrow(/Add real notes/);
    }
  );

  it("rejects unsafe metadata, missing sections, and a version prefix match", async () => {
    const { assertChangelog, promoteChangelog } = await import("../scripts/release-changelog.mjs");
    expect(() => promoteChangelog(historical, metadata)).toThrow(/missing its Unreleased section/);
    expect(() => promoteChangelog(historical, { ...metadata, tag: "../malicious" })).toThrow(/Invalid/);
    expect(() => assertChangelog("## [1.2.01] - 2026-11-09\n\n- Note.\n", "1.2.0")).toThrow(/missing/);
    expect(() => assertChangelog("## [1.2.0] - 2026-11-09\n\n### Fixed\n", "1.2.0")).toThrow(/real notes/);
  });

  it("rejects placeholders in historical or pending notes without rewriting the file", async () => {
    const { runChangelogCommand } = await import("../scripts/release-changelog.mjs");
    const directory = await mkdtemp(join(tmpdir(), "storage-changelog-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "CHANGELOG.md");
    const clean = "## [Unreleased]\n\n### Fixed\n\n- Preserve release history.\n\n";
    const dirty = clean + historical + "- (PLACEHOLDER)\n";
    await writeFile(file, dirty);
    expect(() => runChangelogCommand(["check", file])).toThrow(/placeholder/);
    expect(() => runChangelogCommand(["prepare", file, ...Object.values(metadata)])).toThrow(/placeholder/);
    expect(await readFile(file, "utf8")).toBe(dirty);
    await writeFile(file, clean + historical + oldReference);
    runChangelogCommand(["prepare", file, ...Object.values(metadata)]);
    runChangelogCommand(["check", file, metadata.version]);
    expect(await readFile(file, "utf8")).toContain("## [1.2.0] - 2026-11-09");
  });
});
