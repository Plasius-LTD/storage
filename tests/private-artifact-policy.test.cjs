const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectRepositoryArtifactPaths,
  collectWorkingTreeArtifactPaths,
  compareExactPathAllowlist,
  createSafeArtifactPolicyError,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
  formatSafeArtifactPolicyError,
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

test("normalizes compatibility separators before structural path handling", () => {
  for (const candidate of [
    "legal/ＣＯＮＴＲＩＢＵＴＯＲ／ＡＣＣＥＰＴＡＮＣＥＳ／record.json",
    "legal/signed＼contributor＼agreement.pdf",
    "legal/signed﹨contributor﹨agreement.pdf",
  ]) {
    const normalized = normalizeArtifactPath(candidate);
    assert.ok(!/[\\／＼﹨]/u.test(normalized), candidate);
    assert.equal(normalizeArtifactPath(normalized), normalized, candidate);
  }
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

test("rejects hierarchical and compatibility-spelled signed CLA storage", () => {
  const protectedPaths = [
    "legal/signed/CLAs/record.pdf",
    "legal/signed＼clas/record.pdf",
    "legal/CLA/signatures/record.pdf",
    "legal/CLA/acceptances/record.pdf",
    "legal/CLA/submissions/record.pdf",
    "legal/signed/archive/CLAs/record.pdf",
    "legal/CLA/archive/signatures/record.pdf",
    "legal/signedCLA.pdf",
    "legal/claSignatures.json",
    "legal/signedCLABackup.pdf",
    "legal/claSignaturesBackup.json",
    "legal/signed-cla-backup.pdf",
  ];

  for (const candidate of protectedPaths) {
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "signed-cla-storage", candidate);
  }
});

test("rejects contributor record and signed agreement aliases", () => {
  const protectedPaths = [
    "legal/contributor-acceptances.json",
    "legal/contributor-signatures.json",
    "legal/contributor-submission.pdf",
    "legal/contributor/acceptances/record.json",
    "legal/contributors/signature/record.pdf",
    "legal/signed-contributor-agreement.pdf",
    "legal/signed/contributor/agreements/record.pdf",
    "legal/contributor-signed-agreement.pdf",
    "legal/contributor/agreement/signed.pdf",
    "legal/contributor-agreement-signature.pdf",
    "legal/contributor-acceptances-2026.json",
    "legal/contributor-signature-backup.json",
    "legal/signed-contributor-agreement-backup.pdf",
    "legal/contributor-acceptance-process.json",
    "legal/contributor-signature-schema.pdf",
    "legal/contributor-acceptance-process/SYNTHETIC-RECORD.pdf",
    "legal/contributors/2026/acceptances.json",
    "legal/contributor/archive/signatures/record.json",
    "legal/signed/contributor/2026/agreement.pdf",
    "legal/contributor+acceptances.json",
    "legal/contributor‑acceptances.json",
    "legal/contributor-acceptances~backup.json",
    "legal/signed+contributor+agreement.pdf",
    "legal/contributorAcceptances.json",
    "legal/contributorSignatures.json",
    "legal/contributorSubmissions.pdf",
    "legal/signedContributorAgreement.pdf",
    "legal/contributorSignedAgreement.pdf",
    "legal/contributorAgreementSignature.pdf",
    "legal/contributorSignaturesBackup.json",
    "legal/signedContributorAgreementBackup.pdf",
    "legal/ＣＯＮＴＲＩＢＵＴＯＲ／ＡＣＣＥＰＴＡＮＣＥＳ／record.json",
    "legal/signed＼contributor＼agreement.pdf",
    "legal/signed﹨contributor﹨agreement.pdf",
    "docs/contributor-acceptance-process/legal/contributor-signatures.json",
    "package/legal/contributor-signatures.json",
  ];

  for (const candidate of protectedPaths) {
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "contributor-record-storage", candidate);
  }
});

test("allows public CLA templates, contributor documentation, and benign technical registries", () => {
  assert.deepEqual(
    findPrivateArtifactViolations([
      "CONTRIBUTORS.md",
      "legal/CLA.md",
      "legal/INDIVIDUAL_CLA.md",
      "legal/CORPORATE_CLA.md",
      "src/mcp-admin-registry.ts",
      "docs/cla-signing-process.md",
      "docs/contributor-acceptance-process.md",
      "docs/contributor-acceptance-process-v2.md",
      "docs/signed-contributor-agreement-template.md",
      "docs/contributor-submission-policy.md",
      "src/cla-signature-schema.ts",
      "src/contributor-signature-schema.ts",
      "src/contributor-signature-schema-v2.ts",
      "src/contributor-submission-validator.ts",
      "src/contributor-acceptance-format.ts",
      "docs/contributor+acceptance+process.md",
      "src/contributor+signature+schema.ts",
      "docs/contributorAcceptanceProcess.md",
      "docs/signedContributorAgreementTemplate.md",
      "src/contributorSignatureSchema.ts",
      "docs/signed-cla-template.md",
      "docs/signedCLATemplate.md",
      "src/claSignatureSchema.ts",
    ]),
    []
  );
});

test("package inventory uses the shared contributor-record policy", (t) => {
  const root = createTemporaryDirectory(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const packageRoot = path.join(root, ".cache", "pkg");
  fs.mkdirSync(path.join(packageRoot, "legal"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "synthetic-private-package",
      version: "1.0.0",
      files: ["legal"],
    })}\n`,
    "utf8"
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "contributor-signatures.json"), "w")
  );

  const verifier = path.resolve(
    __dirname,
    "../scripts/verify-public-artifacts.cjs"
  );
  const result = spawnSync(
    process.execPath,
    [verifier, "--package-dir", ".cache/pkg"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: path.join(root, ".npm-cache"),
      },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /contributor-record-storage: 1/u);
  assert.doesNotMatch(
    result.stderr,
    /\.cache|legal\/|signatures|\.json/u
  );
});

test(
  "installed coverage run exercises the complete public package verifier",
  {
    skip: process.env.npm_lifecycle_event !== "test:privacy:lcov",
    timeout: 120_000,
  },
  () => {
    const verifier = path.resolve(
      __dirname,
      "../scripts/verify-public-package.cjs"
    );
    const result = spawnSync(process.execPath, [verifier], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Public package check passed/u);
  }
);

test("rejects public-document qualifiers used as private-record directories", () => {
  const protectedPaths = [
    "docs/contributor-acceptance-process.md/SYNTHETIC-RECORD.pdf",
    "docs/contributor-acceptance-process-v2.md/SYNTHETIC-RECORD.pdf",
    "docs/signed-contributor-agreement-template.md/SYNTHETIC-RECORD.pdf",
    "docs/contributor-submission-policy.md/SYNTHETIC-RECORD.pdf",
    "src/contributor-signature-schema.ts/SYNTHETIC-RECORD.pdf",
    "src/contributor-signature-schema-v2.ts/SYNTHETIC-RECORD.pdf",
    "src/contributor-submission-validator.ts/SYNTHETIC-RECORD.pdf",
    "src/contributor-acceptance-format.ts/SYNTHETIC-RECORD.pdf",
  ];

  for (const candidate of protectedPaths) {
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "contributor-record-storage", candidate);
  }
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

test("verifier entry points redact exceptional traversal paths and stacks", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "private-artifact-traversal-")
  );
  const protectedDirectory = path.join(
    root,
    "legal",
    "contributor-acceptances-SYNTHETIC-SENSITIVE"
  );
  fs.mkdirSync(protectedDirectory, { recursive: true });
  fs.chmodSync(protectedDirectory, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(protectedDirectory, 0o700);
    } catch {
      // The temporary directory may already have been removed after a failure.
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const verifiers = [
    {
      args: [
        path.resolve(__dirname, "../scripts/verify-private-artifacts.cjs"),
        root,
      ],
      cwd: process.cwd(),
    },
    {
      args: [
        path.resolve(__dirname, "../scripts/verify-public-artifacts.cjs"),
      ],
      cwd: root,
    },
    {
      args: [path.resolve(__dirname, "../scripts/verify-public-package.cjs")],
      cwd: root,
    },
  ];

  for (const { args, cwd } of verifiers) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /working-tree-enumeration-failed/u);
    assert.doesNotMatch(
      output,
      /SYNTHETIC|contributor|acceptances|EACCES|permission denied|scandir|\n\s*at\s|private-artifact-policy\.cjs:\d+/iu
    );
  }
});

test("safe error formatting rejects untrusted messages and malformed metadata", () => {
  const sensitiveError = new Error(
    "SYNTHETIC-SENSITIVE legal/contributor-acceptances.json"
  );
  assert.equal(
    formatSafeArtifactPolicyError(
      sensitiveError,
      "private-artifact-check-failed"
    ),
    "code=private-artifact-check-failed"
  );

  const safeError = createSafeArtifactPolicyError(
    "private-artifact-policy-rejected",
    "contributor-record-storage: 2, signed-cla-storage: 1"
  );
  assert.equal(
    formatSafeArtifactPolicyError(safeError, "fallback-failed"),
    "code=private-artifact-policy-rejected; counts=contributor-record-storage: 2, signed-cla-storage: 1"
  );
  assert.throws(
    () => createSafeArtifactPolicyError("SYNTHETIC/SENSITIVE"),
    /kebab-case/u
  );
  assert.throws(
    () =>
      createSafeArtifactPolicyError(
        "private-artifact-policy-rejected",
        "legal/contributor-acceptances.json: 1"
      ),
    /invalid shape/u
  );
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

test("repository gates reject staged contributor aliases without logging paths", (t) => {
  const root = createTemporaryDirectory(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const protectedAliases = [
    "legal/contributor-acceptances.json",
    "legal/contributor-signatures.json",
    "legal/signed-contributor-agreement.pdf",
    "legal/contributorSignatures.json",
    "legal/signedContributorAgreement.pdf",
    "legal/signed/CLAs/record.pdf",
    "legal/CLA/signatures/record.pdf",
  ];
  const legitimateControls = [
    "docs/contributor-acceptance-process.md",
    "docs/signed-contributor-agreement-template.md",
    "src/contributor-signature-schema.ts",
    "docs/signedCLATemplate.md",
    "src/claSignatureSchema.ts",
  ];
  for (const artifactPath of [...protectedAliases, ...legitimateControls]) {
    const absolutePath = path.join(root, artifactPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.closeSync(fs.openSync(absolutePath, "w"));
  }
  execFileSync("git", ["add", "-f", "--all"], { cwd: root });

  const verifiers = [
    {
      args: [
        path.resolve(__dirname, "../scripts/verify-private-artifacts.cjs"),
        root,
      ],
      cwd: process.cwd(),
    },
    {
      args: [
        path.resolve(__dirname, "../scripts/verify-public-artifacts.cjs"),
      ],
      cwd: root,
    },
    {
      args: [path.resolve(__dirname, "../scripts/verify-public-package.cjs")],
      cwd: root,
    },
  ];
  for (const { args, cwd } of verifiers) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /contributor-record-storage: 5/u);
    assert.match(result.stderr, /signed-cla-storage: 2/u);
    assert.doesNotMatch(
      result.stderr,
      /legal\/|acceptances|signatures|agreement|\.json|\.pdf/u
    );
  }
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

test("rejects duplicate and normalization-colliding raw package members", () => {
  for (const actualPaths of [
    ["package/README.md", "package/ＲEADME.md"],
    ["package/ＲEADME.md"],
    ["package/README.md", "package/README.md"],
  ]) {
    assert.throws(
      () => compareExactPathAllowlist(actualPaths, ["README.md"]),
      /raw artifact identity or cardinality/u
    );
  }

  assert.deepEqual(
    compareExactPathAllowlist(["package/README.md"], ["README.md"]),
    { missingPaths: [], unexpectedPaths: [] }
  );
});

function createTemporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-artifact-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
