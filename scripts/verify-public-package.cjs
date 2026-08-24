#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");
const {
  collectRepositoryArtifactPaths,
  compareExactPathAllowlist,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
} = require("./private-artifact-policy.cjs");

const EXPECTED_PACKAGE_FILES_ENTRIES = Object.freeze([
  "dist",
  "src",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTORS.md",
  "docs",
  "legal/CLA.md",
  "legal/INDIVIDUAL_CLA.md",
  "legal/CORPORATE_CLA.md",
]);

const EXPECTED_PUBLIC_PACKAGE_PATHS = Object.freeze([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTORS.md",
  "src/index.ts",
  "src/immutable-assets.ts",
  "src/immutable-json-packets.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/index.cjs",
  "dist/index.cjs.map",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "dist/immutable-assets.js",
  "dist/immutable-assets.js.map",
  "dist/immutable-assets.cjs",
  "dist/immutable-assets.cjs.map",
  "dist/immutable-assets.d.ts",
  "dist/immutable-assets.d.cts",
  "dist/immutable-json-packets.js",
  "dist/immutable-json-packets.js.map",
  "dist/immutable-json-packets.cjs",
  "dist/immutable-json-packets.cjs.map",
  "dist/immutable-json-packets.d.ts",
  "dist/immutable-json-packets.d.cts",
  "docs/adrs/adr-template.md",
  "docs/adrs/adr-0001-storage-package-scope.md",
  "docs/adrs/adr-0002-public-repo-governance.md",
  "docs/adrs/adr-0003-immutable-asset-version-storage.md",
  "docs/adrs/adr-0004-immutable-schema-backed-json-packet-storage.md",
  "docs/adrs/adr-0005-exact-main-oidc-package-publishing.md",
  "docs/adrs/adr-0006-path-only-private-artifact-prevention-gates.md",
  "docs/adrs/index.md",
  "docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md",
  "docs/tdrs/tdr-0002-immutable-json-packet-storage-protocol.md",
  "legal/CLA.md",
  "legal/INDIVIDUAL_CLA.md",
  "legal/CORPORATE_CLA.md",
]);

async function main() {
  verifyRepositoryPrivateArtifactPolicy();
  verifyPackageFilesAllowlist();

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-packcheck-"));
  try {
    const output = execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
        "--cache",
        path.join(temporaryRoot, "npm-cache"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = parseNpmPackJson(output);
    const packResult = Array.isArray(parsed) ? parsed[0] : undefined;
    const paths = (packResult?.files ?? []).map((entry) => entry.path);

    const privateArtifactViolations = findPrivateArtifactViolations(paths);
    if (privateArtifactViolations.length > 0) {
      throw new Error(
        formatPrivateArtifactViolations(
          "Public package contains prohibited private artifact paths",
          privateArtifactViolations
        )
      );
    }

    const packagePathComparison = compareExactPathAllowlist(
      paths,
      EXPECTED_PUBLIC_PACKAGE_PATHS
    );
    if (
      packagePathComparison.missingPaths.length > 0 ||
      packagePathComparison.unexpectedPaths.length > 0
    ) {
      throw new Error(
        formatAllowlistDifference(
          "Public package path manifest differs from the exact allowlist",
          packagePathComparison
        )
      );
    }

    const requiredPaths = [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "SECURITY.md",
      "dist/index.js",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/immutable-assets.js",
      "dist/immutable-assets.cjs",
      "dist/immutable-assets.d.ts",
      "dist/immutable-assets.d.cts",
      "dist/immutable-json-packets.js",
      "dist/immutable-json-packets.cjs",
      "dist/immutable-json-packets.d.ts",
      "dist/immutable-json-packets.d.cts",
    ];
    const missingPaths = requiredPaths.filter((requiredPath) => !paths.includes(requiredPath));
    if (missingPaths.length > 0) {
      throw new Error(`Public package is missing required paths: ${missingPaths.join(", ")}`);
    }

    const forbiddenTarballPathPatterns = [
      /(?:^|\/)plasius-ltd-site(?:\/|$)/iu,
      /(?:^|\/)(frontend|backend|dashboard|infra)(?:\/|$)/iu,
      /(?:^|\/)local\.settings(?:\.[^/]+)?\.json$/iu,
      /(?:^|\/)host\.json$/iu,
      /(?:^|\/)tsp-output(?:\/|$)/iu,
    ];
    const forbiddenPaths = paths.filter((filePath) =>
      forbiddenTarballPathPatterns.some((pattern) => pattern.test(filePath))
    );
    if (forbiddenPaths.length > 0) {
      throw new Error(`Public package contains forbidden paths: ${forbiddenPaths.join(", ")}`);
    }

    verifyNoForbiddenCodeReferences();

    if (typeof packResult?.filename !== "string") {
      throw new Error("npm pack did not return a package filename.");
    }
    const consumerDirectory = path.join(temporaryRoot, "consumer");
    fs.mkdirSync(consumerDirectory, { recursive: true });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        consumerDirectory,
        "--ignore-scripts",
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(temporaryRoot, "npm-cache"),
        path.join(temporaryRoot, packResult.filename),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    verifyInstalledExportMap(consumerDirectory);
    verifyInstalledTypeScriptBoundary(consumerDirectory);
    verifyBrowserBoundary(consumerDirectory);
    verifyNodeEntrypoints(consumerDirectory);
    console.log("Public package check passed.");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyRepositoryPrivateArtifactPolicy() {
  const violations = findPrivateArtifactViolations(
    collectRepositoryArtifactPaths(process.cwd())
  );
  if (violations.length > 0) {
    throw new Error(
      formatPrivateArtifactViolations(
        "Public package check stopped before npm pack because prohibited repository paths were found",
        violations
      )
    );
  }
}

function verifyPackageFilesAllowlist() {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const policyViolations = findPackageFilesPolicyViolations(manifest.files);
  if (policyViolations.length > 0) {
    throw new Error(
      `package.json files policy failed:\n${policyViolations
        .map((violation) => `- ${violation.entry} (${violation.ruleId})`)
        .join("\n")}`
    );
  }

  const comparison = compareExactPathAllowlist(
    manifest.files,
    EXPECTED_PACKAGE_FILES_ENTRIES
  );
  if (comparison.missingPaths.length > 0 || comparison.unexpectedPaths.length > 0) {
    throw new Error(
      formatAllowlistDifference(
        "package.json files differs from the approved package-surface allowlist",
        comparison
      )
    );
  }
}

function formatPrivateArtifactViolations(label, violations) {
  return `${label}; file contents were not inspected:\n${violations
    .map((violation) => `- ${violation.artifactPath} (${violation.ruleId})`)
    .join("\n")}`;
}

function formatAllowlistDifference(label, comparison) {
  const details = [];
  if (comparison.missingPaths.length > 0) {
    details.push(`missing: ${comparison.missingPaths.join(", ")}`);
  }
  if (comparison.unexpectedPaths.length > 0) {
    details.push(`unexpected: ${comparison.unexpectedPaths.join(", ")}`);
  }
  return `${label}: ${details.join("; ")}`;
}

function verifyInstalledExportMap(consumerDirectory) {
  const manifestPath = path.join(
    consumerDirectory,
    "node_modules",
    "@plasius",
    "storage",
    "package.json"
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const immutableExport = manifest.exports?.["./immutable-assets"];
  if (
    immutableExport?.node?.import?.types !== "./dist/immutable-assets.d.ts" ||
    immutableExport?.node?.import?.default !== "./dist/immutable-assets.js" ||
    immutableExport?.node?.require?.types !== "./dist/immutable-assets.d.cts" ||
    immutableExport?.node?.require?.default !== "./dist/immutable-assets.cjs" ||
    immutableExport?.default !== null
  ) {
    throw new Error("Packed immutable-assets export is not explicitly Node-only.");
  }
  const packetExport = manifest.exports?.["./immutable-json-packets"];
  if (
    packetExport?.node?.import?.types !== "./dist/immutable-json-packets.d.ts" ||
    packetExport?.node?.import?.default !== "./dist/immutable-json-packets.js" ||
    packetExport?.node?.require?.types !== "./dist/immutable-json-packets.d.cts" ||
    packetExport?.node?.require?.default !== "./dist/immutable-json-packets.cjs" ||
    packetExport?.default !== null
  ) {
    throw new Error(
      "Packed immutable-json-packets export is not explicitly Node-only."
    );
  }
}

function verifyInstalledTypeScriptBoundary(consumerDirectory) {
  const compilerPath = require.resolve("typescript/lib/tsc.js");
  fs.writeFileSync(
    path.join(consumerDirectory, "node-consumer.mts"),
    [
      'import { createImmutableAssetStore } from "@plasius/storage/immutable-assets";',
      'import { createImmutableJsonPacketStore } from "@plasius/storage/immutable-json-packets";',
      "void createImmutableAssetStore;",
      "void createImmutableJsonPacketStore;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumerDirectory, "node-consumer.cts"),
    [
      'import storage = require("@plasius/storage/immutable-assets");',
      'import packets = require("@plasius/storage/immutable-json-packets");',
      "void storage.createImmutableAssetStore;",
      "void packets.createImmutableJsonPacketStore;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumerDirectory, "browser-assets-consumer.ts"),
    [
      'import { createImmutableAssetStore } from "@plasius/storage/immutable-assets";',
      "void createImmutableAssetStore;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumerDirectory, "browser-packets-consumer.ts"),
    [
      'import { createImmutableJsonPacketStore } from "@plasius/storage/immutable-json-packets";',
      "void createImmutableJsonPacketStore;",
    ].join("\n")
  );

  const nodeConfig = writeTypeScriptConfig(consumerDirectory, "tsconfig.node.json", {
    compilerOptions: compilerOptions("NodeNext", "NodeNext"),
    files: ["node-consumer.mts", "node-consumer.cts"],
  });
  runTypeScriptCompiler(compilerPath, nodeConfig, consumerDirectory);
  for (const [label, file] of [
    ["immutable-assets", "browser-assets-consumer.ts"],
    ["immutable-json-packets", "browser-packets-consumer.ts"],
  ]) {
    const browserConfig = writeTypeScriptConfig(
      consumerDirectory,
      `tsconfig.browser-${label}.json`,
      {
        compilerOptions: {
          ...compilerOptions("ESNext", "Bundler"),
          customConditions: ["browser"],
        },
        files: [file],
      }
    );
    let browserTypesRejected = false;
    try {
      runTypeScriptCompiler(compilerPath, browserConfig, consumerDirectory);
    } catch {
      browserTypesRejected = true;
    }
    if (!browserTypesRejected) {
      throw new Error(
        `Browser TypeScript unexpectedly resolved ${label}.`
      );
    }
  }
}

function verifyBrowserBoundary(consumerDirectory) {
  for (const [label, entrypoint] of [
    ["immutable-assets", "@plasius/storage/immutable-assets"],
    ["immutable-json-packets", "@plasius/storage/immutable-json-packets"],
  ]) {
    let browserBundleRejected = false;
    try {
      buildSync({
        stdin: {
          contents: `import * as storage from "${entrypoint}"; globalThis.__storage = storage;`,
          resolveDir: consumerDirectory,
          sourcefile: `${label}-browser-smoke.mjs`,
        },
        bundle: true,
        format: "esm",
        logLevel: "silent",
        platform: "browser",
        write: false,
      });
    } catch {
      browserBundleRejected = true;
    }
    if (!browserBundleRejected) {
      throw new Error(`Browser bundling unexpectedly resolved ${label}.`);
    }
  }
}

function verifyNodeEntrypoints(consumerDirectory) {
  const esmSmoke = `
    const storage = await import("@plasius/storage/immutable-assets");
    const packets = await import("@plasius/storage/immutable-json-packets");
    if (typeof storage.createImmutableAssetStore !== "function") process.exit(1);
    if (typeof packets.createImmutableJsonPacketStore !== "function") process.exit(1);
  `;
  const cjsSmoke = `
    const storage = require("@plasius/storage/immutable-assets");
    const packets = require("@plasius/storage/immutable-json-packets");
    if (typeof storage.createImmutableAssetStore !== "function") process.exit(1);
    if (typeof packets.createImmutableJsonPacketStore !== "function") process.exit(1);
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", esmSmoke], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync(process.execPath, ["--eval", cjsSmoke], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function verifyNoForbiddenCodeReferences() {
  const patterns = [
    { label: "private monorepo reference", regex: /\bplasius-ltd-site\b/iu },
    { label: "proprietary PGP reference", regex: /\bpgp[-_a-z0-9]*\b/iu },
    { label: "proprietary Lunari reference", regex: /\blunari\b/iu },
    { label: "proprietary Pixelverse reference", regex: /\bpixelverse\b/iu },
  ];
  const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
  const files = ["src", "tests", "demo"].flatMap((root) =>
    collectFiles(path.resolve(process.cwd(), root), extensions)
  );
  for (const file of files) {
    const contents = fs.readFileSync(file, "utf8");
    const match = patterns.find((pattern) => pattern.regex.test(contents));
    if (match) {
      throw new Error(
        `Public package contains ${match.label} in ${path.relative(process.cwd(), file)}.`
      );
    }
  }
}

function collectFiles(root, extensions) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", "dist", "dist-cjs"]).has(entry.name)) {
        files.push(...collectFiles(fullPath, extensions));
      }
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function compilerOptions(module, moduleResolution) {
  return {
    target: "ES2022",
    module,
    moduleResolution,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
}

function writeTypeScriptConfig(directory, name, config) {
  const configPath = path.join(directory, name);
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function runTypeScriptCompiler(compilerPath, configPath, cwd) {
  execFileSync(process.execPath, [compilerPath, "--project", configPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseNpmPackJson(rawOutput) {
  const start = rawOutput.indexOf("[");
  const end = rawOutput.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error("Could not find npm pack JSON payload in command output.");
  }
  return JSON.parse(rawOutput.slice(start, end + 1));
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
