const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectRepositoryArtifactPaths,
  collectWorkingTreeArtifactPaths,
  compareExactPathAllowlist,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
  normalizeArtifactPath,
} = require("../scripts/private-artifact-policy.cjs");

test("normalizes platform separators and an optional npm package prefix", () => {
  assert.equal(
    normalizeArtifactPath(".\\package\\legal\\contributor-registry.json"),
    "legal/contributor-registry.json"
  );
  assert.equal(
    normalizeArtifactPath("package/src/../legal/PRIVATE-ROSTER.txt"),
    "legal/PRIVATE-ROSTER.txt"
  );
});

test("rejects every CSV extension case-insensitively", () => {
  const violations = findPrivateArtifactViolations([
    "fixtures/public-data.csv",
    "package/reports/example.CsV",
  ]);

  assert.deepEqual(
    violations.map(({ artifactPath, ruleId }) => ({ artifactPath, ruleId })),
    [
      { artifactPath: "fixtures/public-data.csv", ruleId: "csv-artifact" },
      { artifactPath: "reports/example.CsV", ruleId: "csv-artifact" },
    ]
  );
});

test("rejects CLA and contributor registries with any extension", () => {
  const violations = findPrivateArtifactViolations([
    "legal/cla-registry.json",
    "packages/example/legal/contributor_roster.xlsx",
    "legal/register-cla.txt",
    "legal/CLARegistry.bin",
  ]);

  assert.equal(violations.length, 4);
  assert.ok(
    violations.every(({ ruleId }) => ruleId === "cla-contributor-registry")
  );
});

test("rejects privacy-marked registry paths and signed CLA storage", () => {
  const violations = findPrivateArtifactViolations([
    "legal/private-ledger.json",
    "reports/PII_registry.ndjson",
    "reports/privateRegistry.dat",
    "legal/signed-clas/example.pdf",
    "legal/cla-submissions/example.pdf",
  ]);

  assert.deepEqual(
    new Set(violations.map(({ ruleId }) => ruleId)),
    new Set(["private-registry", "signed-cla-storage"])
  );
});

test("allows public CLA templates and benign technical registries", () => {
  assert.deepEqual(
    findPrivateArtifactViolations([
      "CONTRIBUTORS.md",
      "legal/CLA.md",
      "legal/INDIVIDUAL_CLA.md",
      "legal/CORPORATE_CLA.md",
      "src/mcp-admin-registry.ts",
      "docs/cla-signing-process.md",
    ]),
    []
  );
});

test("working-tree discovery is path-only and skips dependency metadata", (t) => {
  const root = createTemporaryDirectory(t);
  const privateDirectory = path.join(root, "legal");
  fs.mkdirSync(privateDirectory, { recursive: true });
  const privatePath = path.join(privateDirectory, "private-registry.json");
  fs.closeSync(fs.openSync(privatePath, "w"));

  fs.mkdirSync(path.join(root, "node_modules", "example"), { recursive: true });
  fs.closeSync(
    fs.openSync(
      path.join(root, "node_modules", "example", "private-registry.json"),
      "w"
    )
  );

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("candidate contents must not be read");
  };
  try {
    assert.deepEqual(collectWorkingTreeArtifactPaths(root), [
      "legal/private-registry.json",
    ]);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("repository discovery retains tracked paths after an unstaged deletion", (t) => {
  const root = createTemporaryDirectory(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const trackedPath = path.join(root, "legal", "private-registry.json");
  fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
  fs.closeSync(fs.openSync(trackedPath, "w"));
  execFileSync("git", ["add", "--", "legal/private-registry.json"], {
    cwd: root,
  });
  fs.rmSync(trackedPath);

  assert.ok(
    collectRepositoryArtifactPaths(root).includes(
      "legal/private-registry.json"
    )
  );
});

test("requires an explicit package files allowlist and rejects broad entries", () => {
  assert.equal(findPackageFilesPolicyViolations(undefined)[0].ruleId, "explicit-files-required");
  assert.equal(findPackageFilesPolicyViolations([])[0].ruleId, "explicit-files-required");

  const violations = findPackageFilesPolicyViolations([
    ".",
    "./",
    "*",
    "**/*",
    "legal",
    "./legal/",
    "dist",
  ]);
  assert.deepEqual(
    violations.map(({ entry }) => entry),
    [".", "./", "*", "**/*", "legal", "./legal/"]
  );
  assert.deepEqual(
    findPackageFilesPolicyViolations([
      "dist",
      "legal/CLA.md",
      "legal/INDIVIDUAL_CLA.md",
      "legal/CORPORATE_CLA.md",
    ]),
    []
  );
});

test("compares the final npm path manifest with an exact allowlist", () => {
  assert.deepEqual(
    compareExactPathAllowlist(
      ["package/package.json", "package/dist/index.js", "package/extra.txt"],
      ["package.json", "dist/index.js", "README.md"]
    ),
    {
      missingPaths: ["README.md"],
      unexpectedPaths: ["extra.txt"],
    }
  );
});

function createTemporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-artifact-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
