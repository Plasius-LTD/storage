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

test("classifies Windows trailing dot and space aliases without rewriting identity", () => {
  const protectedPaths = [
    "reports/windows-alias.csv. ",
    "reports/windows-alias.CSV...",
    "reports\\windows-alias.csv. ",
    "reports. /windows-alias.csv. ",
    "package/reports/windows-alias.csv. ",
    "reports/windows-alias．csv．　",
  ];

  for (const candidate of protectedPaths) {
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "csv-artifact", candidate);
  }

  assert.equal(
    normalizeArtifactPath("package/reports/windows-alias.csv. "),
    "reports/windows-alias.csv. "
  );
  assert.deepEqual(
    findPrivateArtifactViolations([
      "reports/windows-alias.csv.example",
      "reports/windows-alias.csv .txt",
      "reports/windows-alias.csv..txt",
    ]),
    []
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
    "legal/signedclabackup.pdf",
    "legal/clasignaturesbackup.json",
    "legal/SIGNEDCLABACKUP.PDF",
    "legal/signed-cla-backup.pdf",
  ];

  for (const candidate of protectedPaths) {
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "signed-cla-storage", candidate);
  }
});

test("rejects protected contributor and CLA record terms in every order", () => {
  const protectedPaths = new Map([
    [
      "contributor-record-storage",
      [
        "legal/acceptances-contributors/2026.json",
        "legal/signatures/contributor/backup.pdf",
        "legal/submissions-contributor.json",
        "legal/archiveacceptancescontributorsbackup.json",
        "legal/agreements/signed/contributors/record.pdf",
        "legal/signed/agreements/contributors/record.pdf",
        "legal/agreement-contributor-signed.pdf",
        "legal/signature-contributor-agreement.pdf",
        "legal/signature-agreement-contributor.pdf",
        "legal/archiveagreementsignedcontributorsbackup.pdf",
      ],
    ],
    [
      "signed-cla-storage",
      [
        "legal/CLA/signed/record.pdf",
        "legal/cla-signed.pdf",
        "legal/CLASigned.pdf",
        "legal/clas/signed/record.pdf",
        "legal/archiveclasignedbackup.pdf",
        "legal/signatures/CLAs/record.pdf",
        "legal/acceptances-cla.json",
        "legal/submissionsclas.json",
      ],
    ],
  ]);

  for (const [ruleId, candidates] of protectedPaths) {
    for (const candidate of candidates) {
      const violations = findPrivateArtifactViolations([candidate]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, ruleId, candidate);
    }
  }
});

test("rejects protected families across intervening wrappers and mixed boundaries", () => {
  const protectedPaths = new Map([
    [
      "contributor-record-storage",
      [
        "legal/contributor-backup-acceptances.json",
        "legal/contributor-v2acceptances.json",
        "legal/signed-v2-contributor-agreement.pdf",
      ],
    ],
    [
      "signed-cla-storage",
      [
        "legal/signed-backup-cla.pdf",
        "legal/signedv2cla.pdf",
        "legal/clas-backups-signatures.json",
        "legal/clasv2submissions.json",
      ],
    ],
    [
      "cla-contributor-registry",
      [
        "legal/clabackup-registry.json",
        "legal/cla-backupregistry.json",
        "legal/contributor-v2roster.json",
      ],
    ],
    [
      "private-registry",
      [
        "legal/privatebackup-registry.json",
        "legal/private-backupregistry.json",
        "legal/private-v2registry.json",
      ],
    ],
  ]);

  for (const [ruleId, candidates] of protectedPaths) {
    for (const candidate of candidates) {
      const violations = findPrivateArtifactViolations([candidate]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, ruleId, candidate);
    }
  }
});

test("rejects compact literal numeric word wrappers across NFKC and term order", () => {
  const wrappers = [
    "version2",
    "revision3",
    "generation4",
    "VERSION2",
    "Revision3",
    "Generation4",
    "ｖｅｒｓｉｏｎ２",
    "ｒｅｖｉｓｉｏｎ３",
    "ｇｅｎｅｒａｔｉｏｎ４",
  ];
  const families = [
    {
      ruleId: "contributor-record-storage",
      terms: ["contributor", "acceptances"],
    },
    { ruleId: "signed-cla-storage", terms: ["signed", "cla"] },
    {
      ruleId: "cla-contributor-registry",
      terms: ["contributor", "registry"],
    },
    { ruleId: "private-registry", terms: ["private", "registry"] },
  ];

  for (const wrapper of wrappers) {
    for (const { ruleId, terms } of families) {
      for (const orderedTerms of permutations(terms)) {
        for (
          let insertionIndex = 0;
          insertionIndex <= orderedTerms.length;
          insertionIndex += 1
        ) {
          const atoms = [...orderedTerms];
          atoms.splice(insertionIndex, 0, wrapper);
          const candidate = `legal/${atoms.join("")}.bin`;
          const violations = findPrivateArtifactViolations([candidate]);
          assert.equal(violations.length, 1, candidate);
          assert.equal(violations[0].ruleId, ruleId, candidate);
        }
      }
    }
  }
});

test("rejects third protected markers inside separator-free aliases", () => {
  const protectedPaths = new Map([
    [
      "cla-contributor-registry",
      [
        "legal/privateclaregistry.json",
        "legal/claprivateregistry.json",
        "legal/internalcontributorsroster.json",
        "legal/rosterpiicla.json",
        "legal/archiveprivate2026claregistrybackup.json",
        "legal/privateCLARegistry.json",
        "legal/PIIContributorRoster.json",
      ],
    ],
    [
      "contributor-record-storage",
      [
        "legal/privatecontributoracceptances.json",
        "legal/clacontributorsignatures.json",
      ],
    ],
    [
      "signed-cla-storage",
      ["legal/privatesignedcla.pdf", "legal/piiclassignatures.json"],
    ],
  ]);

  for (const [ruleId, candidates] of protectedPaths) {
    for (const candidate of candidates) {
      const violations = findPrivateArtifactViolations([candidate]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, ruleId, candidate);
    }
  }
});

test("rejects every protected-family permutation with wrappers at every boundary", () => {
  const families = [
    {
      ruleId: "contributor-record-storage",
      terms: ["contributor", "acceptances"],
    },
    {
      ruleId: "contributor-record-storage",
      terms: ["contributors", "signed", "agreement"],
    },
    { ruleId: "signed-cla-storage", terms: ["signed", "cla"] },
    { ruleId: "signed-cla-storage", terms: ["clas", "submissions"] },
    {
      ruleId: "cla-contributor-registry",
      terms: ["contributor", "roster"],
    },
    { ruleId: "cla-contributor-registry", terms: ["cla", "registry"] },
    { ruleId: "private-registry", terms: ["pii", "registry"] },
  ];

  for (const { ruleId, terms } of families) {
    for (const orderedTerms of permutations(terms)) {
      for (const wrapper of ["backup", "v2", "archive2026backup"]) {
        for (
          let insertionIndex = 0;
          insertionIndex <= orderedTerms.length;
          insertionIndex += 1
        ) {
          const atoms = [...orderedTerms];
          atoms.splice(insertionIndex, 0, wrapper);
          const aliases = new Set([
            atoms.join(""),
            atoms.join("-"),
            atoms.join("/"),
            atoms
              .map((atom, index) => (index % 2 === 0 ? capitalize(atom) : atom))
              .join(""),
          ]);

          for (const alias of aliases) {
            const candidate = `legal/${alias}.bin`;
            const violations = findPrivateArtifactViolations([candidate]);
            assert.equal(violations.length, 1, candidate);
            assert.equal(violations[0].ruleId, ruleId, candidate);
          }
        }
      }
    }
  }
});

test("rejects every concatenated signed-CLA suffix across case representations", () => {
  const protectedSuffixes = [
    "acceptance",
    "acceptances",
    "archive",
    "archives",
    "backup",
    "backups",
    "copy",
    "copies",
    "executed",
    "final",
    "record",
    "records",
    "signature",
    "signatures",
    "signed",
    "storage",
    "submission",
    "submissions",
    "process",
    "template",
    "templates",
    "policy",
    "policies",
    "guide",
    "guides",
    "guidance",
    "documentation",
    "doc",
    "docs",
    "instruction",
    "instructions",
    "example",
    "examples",
    "schema",
    "schemas",
    "validator",
    "validators",
    "format",
    "formats",
    "spec",
    "specs",
    "specification",
    "specifications",
    "v1",
    "1",
  ];

  for (const suffix of protectedSuffixes) {
    const camelSuffix = `${suffix[0].toLocaleUpperCase("en-US")}${suffix.slice(1)}`;
    const mixedCaseAlias = `signedcla${suffix}`
      .split("")
      .map((character, index) =>
        index % 2 === 0 ? character.toLocaleUpperCase("en-US") : character
      )
      .join("");
    const candidates = [
      `legal/signedcla${suffix}.bin`,
      `legal/signedCLA${camelSuffix}.bin`,
      `legal/${mixedCaseAlias}.bin`,
      `legal/signedclas${suffix}.bin`,
      `legal/signedCLAs${camelSuffix}.bin`,
    ];

    for (const candidate of candidates) {
      const violations = findPrivateArtifactViolations([candidate]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, "signed-cla-storage", candidate);
    }
  }
});

test("retains case-varied concatenated public CLA documentation", () => {
  const publicDocumentation = [
    ["process", "md"],
    ["template", "md"],
    ["policy", "md"],
    ["guidance", "md"],
    ["documentation", "md"],
    ["instructions", "md"],
    ["examples", "md"],
    ["schema", "ts"],
    ["validator", "ts"],
    ["formats", "ts"],
    ["specifications", "ts"],
  ];

  const candidates = publicDocumentation.map(([qualifier, extension]) => {
    const alias = `signedcla${qualifier}`
      .split("")
      .map((character, index) =>
        index % 2 === 0 ? character.toLocaleUpperCase("en-US") : character
      )
      .join("");
    return `docs/${alias}.${extension}`;
  });
  candidates.push(
    "docs/SignedcladocumentaTIoN.md",
    "docs/SignedclasdocumentATiOn.md",
    "docs/SignedclaspecificaTIoN.ts",
    "docs/SignedclasspecificATiOns.ts"
  );

  assert.deepEqual(findPrivateArtifactViolations(candidates), []);
});

test("retains camel-word fallback after authoritative case-folded classification", () => {
  const privateCandidate = "legal/archiveSignedCLA.bin";
  const violations = findPrivateArtifactViolations([privateCandidate]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].ruleId, "signed-cla-storage");
  assert.deepEqual(
    findPrivateArtifactViolations(["docs/archiveSignedCLATemplate.md"]),
    []
  );
});

test("rejects wrapped direct record aliases independent of case transitions", () => {
  const wrappers = concatenatedPolicyWrappers();
  const protectedAliases = [
    "signedcla",
    "contributoracceptances",
    "contributorsignatures",
    "contributorsubmissions",
    "signedcontributoragreement",
    "contributorsignedagreement",
    "contributoragreementsigned",
    "contributoragreementsignature",
  ];

  for (const wrapper of wrappers) {
    for (const alias of protectedAliases) {
      const candidates = [
        ...caseVariants(`${wrapper}${alias}`),
        `${wrapper}${capitalize(alias)}`,
        ...caseVariants(`${alias}${wrapper}`),
        `${alias}${capitalize(wrapper)}`,
      ];
      for (const candidate of new Set(candidates)) {
        const violations = findPrivateArtifactViolations([
          `legal/${candidate}.bin`,
        ]);
        assert.equal(violations.length, 1, candidate);
        assert.ok(
          violations[0].ruleId === "signed-cla-storage" ||
            violations[0].ruleId === "contributor-record-storage",
          candidate
        );
      }
    }
  }
});

test("rejects concatenated plural CLA record categories across wrappers and case", () => {
  const categories = [
    "acceptance",
    "acceptances",
    "signature",
    "signatures",
    "submission",
    "submissions",
  ];

  for (const category of categories) {
    const pluralAlias = `clas${category}`;
    const candidates = [
      ...caseVariants(pluralAlias),
      `CLAs${capitalize(category)}`,
      `archive${pluralAlias}`,
      `archiveCLAs${capitalize(category)}`,
      `${pluralAlias}backup`,
      `CLAs${capitalize(category)}Backup`,
    ];
    for (const candidate of new Set(candidates)) {
      const violations = findPrivateArtifactViolations([
        `legal/${candidate}.json`,
      ]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, "signed-cla-storage", candidate);
    }
  }
});

test("rejects wrapped separator-free registry marker pairs across case styles", () => {
  const markerPairs = [
    ["private", "registry", "private-registry"],
    ["cla", "registry", "cla-contributor-registry"],
    ["clas", "registry", "cla-contributor-registry"],
    ["contributor", "registry", "cla-contributor-registry"],
    ["contributors", "roster", "cla-contributor-registry"],
  ];

  for (const wrapper of concatenatedPolicyWrappers()) {
    for (const [left, right, ruleId] of markerPairs) {
      const aliases = [
        `${wrapper}${left}${right}`,
        `${left}${wrapper}${right}`,
        `${left}${right}${wrapper}`,
        `${wrapper}${right}${left}`,
        `${right}${wrapper}${left}`,
        `${right}${left}${wrapper}`,
      ];
      for (const alias of aliases) {
        for (const candidate of caseVariants(alias)) {
          const violations = findPrivateArtifactViolations([
            `legal/${candidate}.json`,
          ]);
          assert.equal(violations.length, 1, candidate);
          assert.equal(violations[0].ruleId, ruleId, candidate);
        }
      }
    }
  }
});

test("rejects mixed-case concatenated contributor record families", () => {
  const protectedAliases = [
    "contributoracceptances",
    "contributorsignatures",
    "contributorsubmissions",
    "signedcontributoragreement",
    "contributorsignedagreement",
    "contributoragreementsigned",
    "contributoragreementsignature",
  ].map((alias) =>
    alias
      .split("")
      .map((character, index) =>
        index % 2 === 0 ? character.toLocaleUpperCase("en-US") : character
      )
      .join("")
  );

  for (const alias of protectedAliases) {
    const candidate = `legal/${alias}.bin`;
    const violations = findPrivateArtifactViolations([candidate]);
    assert.equal(violations.length, 1, candidate);
    assert.equal(violations[0].ruleId, "contributor-record-storage", candidate);
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
    "legal/contributorsignaturesbackup.json",
    "legal/signedcontributoragreementbackup.pdf",
    "legal/CONTRIBUTORSIGNATURESBACKUP.JSON",
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
      "docs/signedclatemplate.md",
      "src/clasignatureschema.ts",
      "docs/signedcontributoragreementtemplate.md",
      "src/contributorsignatureschema.ts",
      "docs/signedclauses.md",
      "docs/signedclaimsprocess.md",
      "src/signedclassification.ts",
      "src/signedclasses.ts",
      "docs/archiveSignedCLATemplate.md",
      "docs/archivesignedclatemplate.md",
      "src/backupContributorSignaturesSchema.ts",
      "src/backupcontributorsignaturesschema.ts",
      "docs/2026ContributorAcceptanceProcess.md",
      "docs/2026contributoracceptanceprocess.md",
      "src/CLAsSignaturesSchema.ts",
      "src/classignaturesschema.ts",
      "docs/contributorAcceptanceProcessV2.md",
      "docs/contributoracceptanceprocessv2.md",
      "src/contributorSignatureSchemaV2.ts",
      "src/contributorsignatureschemav2.ts",
      "docs/signedCLATemplateV2.md",
      "docs/signedclatemplatev2.md",
      "src/claSignatureSchemaV2.ts",
      "src/classignatureschemav2.ts",
      "src/CLAsSignaturesSchemaV2.ts",
      "docs/copyrightsignedclauses.md",
      "src/personalizationregistry.ts",
      "src/classificationregistry.ts",
    ]),
    []
  );
});

test("retains terminal public documents across literal numeric word wrappers", () => {
  assert.deepEqual(
    findPrivateArtifactViolations([
      "docs/contributorAcceptanceVERSION2_POLICY.md",
      "docs/contributor-acceptance-policy-version2.md",
      "docs/signedCLAVersion2Template.md",
      "src/contributorSignatureRevision3Schema.ts",
      "docs/signedCLAGeneration4Guidance.md",
      "docs/ｃｏｎｔｒｉｂｕｔｏｒＡｃｃｅｐｔａｎｃｅＶＥＲＳＩＯＮ２＿ＰＯＬＩＣＹ.md",
    ]),
    []
  );
});

test("does not treat unknown text after protected terms as a public-document qualifier", () => {
  const protectedPaths = new Map([
    [
      "signed-cla-storage",
      [
        "docs/signedCLASecretTemplate.md",
        "docs/signed-cla-secret-template.md",
      ],
    ],
    [
      "contributor-record-storage",
      [
        "docs/contributorAcceptanceSecretProcess.md",
        "docs/contributor-acceptance-secret-process.md",
      ],
    ],
  ]);

  for (const [ruleId, candidates] of protectedPaths) {
    for (const candidate of candidates) {
      const violations = findPrivateArtifactViolations([candidate]);
      assert.equal(violations.length, 1, candidate);
      assert.equal(violations[0].ruleId, ruleId, candidate);
    }
  }
});

test("package inventory uses the shared contributor-record policy", (t) => {
  const root = createTemporaryDirectory(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const packageRoot = path.join(root, ".cache", "pkg");
  fs.mkdirSync(path.join(packageRoot, "legal"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "synthetic-private-package",
      version: "1.0.0",
      files: ["docs", "legal", "reports"],
    })}\n`,
    "utf8"
  );
  fs.mkdirSync(path.join(packageRoot, "docs"), { recursive: true });
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "contributor-signatures.json"), "w")
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "reports", "windows-alias.csv. "), "w")
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "signedclabackup.pdf"), "w")
  );
  fs.closeSync(
    fs.openSync(
      path.join(packageRoot, "legal", "acceptances-contributors.json"),
      "w"
    )
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "cla-signed.pdf"), "w")
  );
  fs.closeSync(
    fs.openSync(
      path.join(packageRoot, "legal", "archiveprivate2026claregistrybackup.json"),
      "w"
    )
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "privateversion2registry.json"), "w")
  );
  fs.closeSync(
    fs.openSync(
      path.join(packageRoot, "legal", "contributorrevision3acceptances.json"),
      "w"
    )
  );
  fs.closeSync(
    fs.openSync(path.join(packageRoot, "legal", "signedgeneration4cla.pdf"), "w")
  );
  fs.closeSync(
    fs.openSync(
      path.join(packageRoot, "legal", "registryｖｅｒｓｉｏｎ２contributor.json"),
      "w"
    )
  );
  fs.closeSync(
    fs.openSync(
      path.join(packageRoot, "docs", "contributorAcceptanceVERSION2_POLICY.md"),
      "w"
    )
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
  assert.match(result.stderr, /csv-artifact: 1/u);
  assert.match(result.stderr, /cla-contributor-registry: 2/u);
  assert.match(result.stderr, /contributor-record-storage: 3/u);
  assert.match(result.stderr, /private-registry: 1/u);
  assert.match(result.stderr, /signed-cla-storage: 3/u);
  assert.doesNotMatch(
    result.stderr,
    /\.cache|docs\/|legal\/|reports\/|acceptances|contributors|signatures|signedcla|cla-signed|backup|version|revision|generation|windows-alias|\.json|\.csv/u
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
    "docs/contributorAcceptanceVERSION2_POLICY.md/SYNTHETIC-RECORD.pdf",
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

test("source-only gates reject working-tree and index-only semantic bypass families", (t) => {
  const root = createTemporaryDirectory(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const workingTreeAliases = [
    "legal/privateversion2registry.json",
    "legal/contributorｒｅｖｉｓｉｏｎ３acceptances.json",
  ];
  const indexOnlyAliases = [
    "legal/signedgeneration4cla.pdf",
    "legal/registryｖｅｒｓｉｏｎ２contributor.json",
  ];
  const publicControls = [
    "docs/contributorAcceptanceVERSION2_POLICY.md",
    "docs/contributor-acceptance-policy-version2.md",
  ];
  for (const artifactPath of [
    ...workingTreeAliases,
    ...indexOnlyAliases,
    ...publicControls,
  ]) {
    const absolutePath = path.join(root, artifactPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.closeSync(fs.openSync(absolutePath, "w"));
  }
  execFileSync(
    "git",
    ["add", "-f", "--", ...indexOnlyAliases, ...publicControls],
    { cwd: root }
  );
  for (const artifactPath of indexOnlyAliases) {
    fs.rmSync(path.join(root, artifactPath));
  }

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
        "--source-only",
      ],
      cwd: root,
    },
  ];

  for (const { args, cwd } of verifiers) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cla-contributor-registry: 1/u);
    assert.match(result.stderr, /contributor-record-storage: 1/u);
    assert.match(result.stderr, /private-registry: 1/u);
    assert.match(result.stderr, /signed-cla-storage: 1/u);
    assert.doesNotMatch(
      result.stderr,
      /legal\/|docs\/|acceptances|version[0-9]|revision[0-9]|generation[0-9]|\.json|\.md|\.pdf/iu
    );
  }
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
    "legal/signedclabackup.pdf",
    "legal/contributorsignaturesbackup.json",
    "legal/archivesignedcla.bin",
    "legal/backupcontributorsignatures.json",
    "legal/2026contributoracceptances.json",
    "legal/recordsignedcontributoragreement.pdf",
    "legal/classignatures.json",
    "legal/CLAsSubmissions.json",
    "legal/privateRegistryBackup.json",
    "legal/claRegistryBackup.json",
    "legal/acceptances-contributors.json",
    "legal/signed-v2-contributor-agreement.pdf",
    "legal/privatecontributoracceptances.json",
    "legal/cla-signed.pdf",
    "legal/signedv2cla.pdf",
    "legal/piiclassignatures.json",
    "legal/archiveprivate2026claregistrybackup.json",
    "reports/windows-alias.csv. ",
  ];
  const legitimateControls = [
    "docs/contributor-acceptance-process.md",
    "docs/signed-contributor-agreement-template.md",
    "src/contributor-signature-schema.ts",
    "docs/signedCLATemplate.md",
    "src/claSignatureSchema.ts",
    "docs/contributorAcceptanceProcessV2.md",
    "src/contributorSignatureSchemaV2.ts",
    "docs/signedCLATemplateV2.md",
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
    assert.match(result.stderr, /csv-artifact: 1/u);
    assert.match(result.stderr, /cla-contributor-registry: 2/u);
    assert.match(result.stderr, /contributor-record-storage: 12/u);
    assert.match(result.stderr, /private-registry: 1/u);
    assert.match(result.stderr, /signed-cla-storage: 9/u);
    assert.doesNotMatch(
      result.stderr,
      /legal\/|reports\/|windows-alias|signedcla|backup|acceptances|signatures|submissions|agreement|\.bin|\.json|\.pdf|\.csv/iu
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
  assert.deepEqual(
    compareExactPathAllowlist(["package/README.md. "], ["README.md"]),
    { missingPaths: ["README.md"], unexpectedPaths: ["README.md. "] }
  );
  assert.deepEqual(
    compareExactPathAllowlist(["package/readme.md"], ["README.md"]),
    { missingPaths: ["README.md"], unexpectedPaths: ["readme.md"] }
  );
});

function createTemporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-artifact-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function concatenatedPolicyWrappers() {
  return [
    "acceptance",
    "acceptances",
    "archive",
    "archives",
    "backup",
    "backups",
    "copy",
    "copies",
    "executed",
    "final",
    "record",
    "records",
    "signature",
    "signatures",
    "signed",
    "storage",
    "submission",
    "submissions",
    "process",
    "template",
    "templates",
    "policy",
    "policies",
    "guide",
    "guides",
    "guidance",
    "documentation",
    "doc",
    "docs",
    "instruction",
    "instructions",
    "example",
    "examples",
    "schema",
    "schemas",
    "validator",
    "validators",
    "format",
    "formats",
    "spec",
    "specs",
    "specification",
    "specifications",
    "v1",
    "1",
    "2026",
    "archive2026backup",
    "v2records",
  ];
}

function caseVariants(value) {
  return [
    value.toLocaleLowerCase("en-US"),
    value.toLocaleUpperCase("en-US"),
    value
      .split("")
      .map((character, index) =>
        index % 2 === 0 ? character.toLocaleUpperCase("en-US") : character
      )
      .join(""),
  ];
}

function capitalize(value) {
  return `${value[0].toLocaleUpperCase("en-US")}${value.slice(1)}`;
}

function permutations(values) {
  if (values.length <= 1) {
    return [values];
  }

  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map(
      (suffix) => [value, ...suffix]
    )
  );
}
