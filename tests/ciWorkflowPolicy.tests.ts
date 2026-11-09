import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ciWorkflow = read(".github/workflows/ci.yml");
const cdWorkflow = read(".github/workflows/cd.yml");
const releasePrepareWorkflow = read(".github/workflows/release-prepare.yml");
const npmConfig = read(".npmrc");
const packageJson = JSON.parse(read("package.json")) as {
  scripts?: Record<string, string>;
};

describe("release workflow trust boundaries", () => {
  it("runs pull-request validation only for same-repository heads", () => {
    expect(ciWorkflow).toMatch(/pull_request:\s*\n\s+branches: \[main\]/u);
    expect(ciWorkflow).not.toContain("pull_request_target:");
    expect(ciWorkflow).toContain("name: Trusted head admission");
    expect(ciWorkflow).toContain("External fork pull requests cannot be merged");
    expect(ciWorkflow.match(/needs: trusted_head/gu)).toHaveLength(2);
    expect(
      ciWorkflow.match(
        /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/gu,
      ),
    ).toHaveLength(2);
    expect(
      ciWorkflow.match(
        /runs-on: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '\["ubuntu-latest"\]' \|\| '\["self-hosted","Linux","X64"\]'\) \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(ciWorkflow.match(/actions\/checkout@v5/gu)).toHaveLength(2);
    expect(ciWorkflow.match(/actions\/setup-node@v6/gu)).toHaveLength(2);
    expect(ciWorkflow).toContain("cache: ${{ github.event_name == 'pull_request' && 'npm' || '' }}");
    expect(ciWorkflow.match(/package-manager-cache: false/gu)).toHaveLength(2);
    expect(ciWorkflow).toContain("timeout-minutes: 30");
  });

  it("binds a second publication run to the prepared main SHA and successful CI", () => {
    expect(cdWorkflow).toContain("- prepare");
    expect(cdWorkflow).toContain("- publish");
    expect(cdWorkflow).toContain("expected_commit_sha");
    expect(cdWorkflow).toContain('"ref": "main"');
    expect(cdWorkflow).toContain('"phase": "publish"');
    expect(cdWorkflow).toContain("actions/workflows/cd.yml/dispatches");
    expect(cdWorkflow).toContain('-f head_sha="${EXPECTED_SHA}"');
    expect(cdWorkflow).toContain("-f branch=main");
    expect(cdWorkflow).toContain("-f event=push");
    expect(cdWorkflow).toContain("refs/heads/main");
    expect(releasePrepareWorkflow).toContain("COMMIT_SHA=$(git rev-parse HEAD)");
  });

  it("installs the approved npm client before validating the release runtime", () => {
    const jobs = cdWorkflow.slice(cdWorkflow.indexOf("\n  validate_and_pack:"));
    const pin = "npm install --global npm@11.6.2 --ignore-scripts --registry https://registry.npmjs.org";

    for (const job of jobs.split("\n  publish:")) {
      expect(job).toContain(pin);
      expect(job.indexOf(pin)).toBeLessThan(job.indexOf("- name: Verify release runtime"));
    }
  });

  it("stops npm publication if the checkout or fetched main differs from the release SHA", () => {
    const publish = cdWorkflow.slice(cdWorkflow.indexOf("\n  publish:"));
    const steps = publish.split("\n      - name: ");
    const publishIndex = steps.findIndex((step) => step.startsWith("Publish package through npm OIDC\n"));
    expect(publishIndex).toBeGreaterThan(0);
    const guard = steps[publishIndex - 1];
    expect(guard).toMatch(/^Revalidate exact main immediately before npm publication\n/u);
    const script = guard.split("\n        run: |\n")[1];
    if (!script) throw new Error("Missing pre-publication guard script");

    const root = mkdtempSync(join(tmpdir(), "storage-publish-guard-"));
    try {
      const upstream = join(root, "upstream");
      const checkout = join(root, "checkout");
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "user.name=Release test", "-c", "user.email=release@example.test",
          "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
      git(root, "init", "--initial-branch=main", upstream);
      git(upstream, "commit", "--allow-empty", "-m", "Qualified release");
      git(root, "clone", upstream, checkout);
      const expected = git(checkout, "rev-parse", "HEAD");
      const check = () =>
        spawnSync("bash", ["-c", script], {
          cwd: checkout, encoding: "utf8", env: { ...process.env, EXPECTED_SHA: expected },
        });

      expect(check().status).toBe(0);

      git(checkout, "commit", "--allow-empty", "-m", "Different checkout");
      const mismatchedCheckout = check();
      expect(mismatchedCheckout.status).toBe(1);
      expect(mismatchedCheckout.stderr).toContain("Checked-out release commit");
      git(checkout, "reset", "--hard", expected);

      git(upstream, "commit", "--allow-empty", "-m", "Main advanced");
      const movedMain = check();
      expect(movedMain.status).toBe(1);
      expect(movedMain.stderr).toContain("refusing npm publication");

      git(checkout, "update-ref", "refs/remotes/origin/main", expected);
      git(checkout, "remote", "set-url", "origin", join(root, "unavailable"));
      const failedFetch = check();
      expect(failedFetch.status).toBeGreaterThan(0);
      expect(failedFetch.stderr).toContain("fatal:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses supported phase-isolated concurrency", () => {
    expect(cdWorkflow).toContain(
      "group: npm-cd-${{ github.repository }}-${{ inputs.phase == 'publish'",
    );
    expect(cdWorkflow).toContain("inputs.expected_commit_sha");
    expect(cdWorkflow).toContain("cancel-in-progress: false");
    expect(cdWorkflow).not.toContain("queue:");
  });

  it("uses hosted OIDC publication without npm write tokens", () => {
    expect(cdWorkflow).toContain("runs-on: ubuntu-latest");
    expect(cdWorkflow).toContain("environment: production");
    expect(cdWorkflow).toContain("id-token: write");
    expect(cdWorkflow).toContain("--provenance");
    expect(cdWorkflow).toContain("npm publish");
    expect(cdWorkflow).not.toContain("NPM_TOKEN");
    expect(cdWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(npmConfig).not.toContain("_authToken");
    expect(npmConfig).not.toContain("NODE_AUTH_TOKEN");
  });

  it("runs the repository privacy gate before dependencies are installed", () => {
    expect(packageJson.scripts?.["privacy:check"]).toBe(
      "node scripts/verify-public-artifacts.cjs --package-dir .",
    );
    expect(cdWorkflow.indexOf("- name: Verify private artifact policy")).toBeLessThan(
      cdWorkflow.indexOf("- name: Install dependencies"),
    );
  });

  it("builds standalone privacy LCOV inputs and verifies container privileges", () => {
    expect(packageJson.scripts?.["pretest:privacy:lcov"]).toBe("npm run build");
    expect(packageJson.scripts?.["test:privacy:lcov"]).not.toContain("test:coverage");
    expect(ciWorkflow).toContain("name: Verify privacy portability in containers");
    expect(ciWorkflow).toContain('for identity in "0:0" "1000:1000"');
    expect(ciWorkflow).toContain("--network none --read-only");
    expect(ciWorkflow).toContain('"$PWD:/workspace:ro"');
  });

  it("keeps dependency code out of the OIDC mutation job", () => {
    const validationJob = cdWorkflow.slice(
      cdWorkflow.indexOf("\n  validate_and_pack:"),
      cdWorkflow.indexOf("\n  publish:"),
    );
    const publishJob = cdWorkflow.slice(cdWorkflow.indexOf("\n  publish:"));

    expect(validationJob).toContain("npm ci");
    expect(validationJob).toContain("npm pack --ignore-scripts --json");
    expect(validationJob).toContain("actions/upload-artifact@v7");
    expect(validationJob).not.toContain("environment: production");
    expect(validationJob).not.toContain("id-token: write");
    expect(publishJob).toContain("actions/download-artifact@v8");
    expect(publishJob).toContain("digest-mismatch: error");
    expect(publishJob).not.toContain("npm ci");
    expect(publishJob).not.toContain("npm run ");
  });

  it("lands release metadata through a unique non-force-pushed pull request", () => {
    expect(releasePrepareWorkflow).toContain(
      'BRANCH="release/${TAG}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(releasePrepareWorkflow).not.toContain(
      'git push origin "HEAD:${BASE_BRANCH}"',
    );
    expect(releasePrepareWorkflow).not.toContain("--force-with-lease");
    expect(releasePrepareWorkflow).not.toContain("secrets: inherit");
  });

  it("uses only the scoped release-prep app token for repository mutation", () => {
    const checkoutStep = releasePrepareWorkflow.slice(
      releasePrepareWorkflow.indexOf("- name: Checkout main"),
      releasePrepareWorkflow.indexOf("- name: Create release-prep GitHub App token"),
    );

    expect(checkoutStep).toContain("persist-credentials: false");
    expect(releasePrepareWorkflow).toContain(
      'git remote set-url origin "https://x-access-token:${AUTH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"',
    );
  });
});
