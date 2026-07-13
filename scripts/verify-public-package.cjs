#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

async function main() {
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
}

function verifyInstalledTypeScriptBoundary(consumerDirectory) {
  const compilerPath = require.resolve("typescript/lib/tsc.js");
  fs.writeFileSync(
    path.join(consumerDirectory, "node-consumer.mts"),
    [
      'import { createImmutableAssetStore } from "@plasius/storage/immutable-assets";',
      "void createImmutableAssetStore;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumerDirectory, "node-consumer.cts"),
    [
      'import storage = require("@plasius/storage/immutable-assets");',
      "void storage.createImmutableAssetStore;",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumerDirectory, "browser-consumer.ts"),
    [
      'import { createImmutableAssetStore } from "@plasius/storage/immutable-assets";',
      "void createImmutableAssetStore;",
    ].join("\n")
  );

  const nodeConfig = writeTypeScriptConfig(consumerDirectory, "tsconfig.node.json", {
    compilerOptions: compilerOptions("NodeNext", "NodeNext"),
    files: ["node-consumer.mts", "node-consumer.cts"],
  });
  const browserConfig = writeTypeScriptConfig(consumerDirectory, "tsconfig.browser.json", {
    compilerOptions: {
      ...compilerOptions("ESNext", "Bundler"),
      customConditions: ["browser"],
    },
    files: ["browser-consumer.ts"],
  });

  runTypeScriptCompiler(compilerPath, nodeConfig, consumerDirectory);
  let browserTypesRejected = false;
  try {
    runTypeScriptCompiler(compilerPath, browserConfig, consumerDirectory);
  } catch {
    browserTypesRejected = true;
  }
  if (!browserTypesRejected) {
    throw new Error("Browser TypeScript unexpectedly resolved immutable-assets.");
  }
}

function verifyBrowserBoundary(consumerDirectory) {
  let browserBundleRejected = false;
  try {
    buildSync({
      stdin: {
        contents:
          'import * as storage from "@plasius/storage/immutable-assets"; globalThis.__storage = storage;',
        resolveDir: consumerDirectory,
        sourcefile: "immutable-assets-browser-smoke.mjs",
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
    throw new Error("Browser bundling unexpectedly resolved immutable-assets.");
  }
}

function verifyNodeEntrypoints(consumerDirectory) {
  const esmSmoke = `
    const storage = await import("@plasius/storage/immutable-assets");
    if (typeof storage.createImmutableAssetStore !== "function") process.exit(1);
  `;
  const cjsSmoke = `
    const storage = require("@plasius/storage/immutable-assets");
    if (typeof storage.createImmutableAssetStore !== "function") process.exit(1);
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
