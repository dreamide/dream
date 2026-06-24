const fs = require("node:fs/promises");
const path = require("node:path");

const ARCH_BY_NUMBER = {
  1: "x64",
  3: "arm64",
  4: "universal",
};

const PLATFORM_VENDOR_DIRS = {
  darwin: {
    arm64: new Set(["arm64-darwin", "darwin-arm64"]),
    x64: new Set(["darwin-x64", "x64-darwin"]),
    universal: new Set([
      "arm64-darwin",
      "darwin-arm64",
      "darwin-x64",
      "x64-darwin",
    ]),
  },
  linux: {
    arm64: new Set(["arm64-linux", "linux-arm64"]),
    x64: new Set(["linux-x64", "x64-linux"]),
    universal: new Set([
      "arm64-linux",
      "linux-arm64",
      "linux-x64",
      "x64-linux",
    ]),
  },
  win32: {
    arm64: new Set(["arm64-win32", "win32-arm64"]),
    x64: new Set(["win32-x64", "x64-win32"]),
    universal: new Set([
      "arm64-win32",
      "win32-arm64",
      "win32-x64",
      "x64-win32",
    ]),
  },
};

const APP_UPDATE_YML = `provider: github
owner: dreamide
repo: dream
updaterCacheDirName: dream-updater
`;

const SHARP_PLATFORM_PACKAGE_PATTERN =
  /^(sharp|sharp-libvips)-(darwin|linux|linuxmusl|win32)-(arm64|x64|ia32|arm)$/;

const normalizePath = (value) => value.replace(/\\/g, "/");

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { force: true, recursive: true });
}

async function readDirectoryNames(parentPath) {
  try {
    const entries = await fs.readdir(parentPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getTargetArch(context) {
  const appOutDir = normalizePath(context.appOutDir).toLowerCase();
  if (appOutDir.includes("universal")) {
    return "universal";
  }

  const arch = ARCH_BY_NUMBER[context.arch] ?? context.arch;
  if (arch === "arm64" || arch === "x64" || arch === "universal") {
    return arch;
  }

  if (appOutDir.includes("arm64")) {
    return "arm64";
  }
  if (appOutDir.includes("x64")) {
    return "x64";
  }

  return "universal";
}

function isUniversalTempBuild(context) {
  const appOutDir = normalizePath(context.appOutDir).toLowerCase();
  return appOutDir.includes("universal") && appOutDir.includes("-temp");
}

function getPlatformVendorKeepNames(platform, arch) {
  return (
    PLATFORM_VENDOR_DIRS[platform]?.[arch] ??
    PLATFORM_VENDOR_DIRS[platform]?.universal ??
    new Set()
  );
}

async function prunePlatformVendorDirectory(parentPath, platform, arch) {
  const keepNames = getPlatformVendorKeepNames(platform, arch);
  const names = await readDirectoryNames(parentPath);
  for (const name of names) {
    if (keepNames.has(name)) {
      continue;
    }

    if (/(^|[-_])(darwin|linux|win32)([-_]|$)/.test(name)) {
      await removeIfExists(path.join(parentPath, name));
      continue;
    }

    if (/^(arm64|x64|ia32)-/.test(name)) {
      await removeIfExists(path.join(parentPath, name));
    }
  }
}

async function pruneSharpOptionalDependencies(parentPath, platform, arch) {
  const names = await readDirectoryNames(parentPath);
  for (const name of names) {
    const match = name.match(SHARP_PLATFORM_PACKAGE_PATTERN);
    if (!match) {
      continue;
    }

    const packagePlatform = match[2];
    const packageArch = match[3];
    const platformMatches = packagePlatform === platform;
    const archMatches = arch === "universal" || packageArch === arch;

    if (!platformMatches || !archMatches) {
      await removeIfExists(path.join(parentPath, name));
    }
  }
}

async function ensureAppUpdateConfig(resourcesDir) {
  const updateConfigPath = path.join(resourcesDir, "app-update.yml");
  try {
    await fs.access(updateConfigPath);
    return;
  } catch {
    await fs.writeFile(updateConfigPath, APP_UPDATE_YML, "utf8");
  }
}

function getResourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }

  return path.join(context.appOutDir, "resources");
}

exports.default = async function prunePackagedApp(context) {
  const platform = context.electronPlatformName;
  const arch = getTargetArch(context);
  const resourcesDir = getResourcesDirectory(context);

  await ensureAppUpdateConfig(resourcesDir);

  if (platform === "darwin" && isUniversalTempBuild(context)) {
    console.log(
      `Skipped native vendor pruning for ${platform}/${arch} temp app at ${normalizePath(resourcesDir)}`,
    );
    return;
  }

  const unpackedNodeModules = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
  );

  await Promise.all([
    prunePlatformVendorDirectory(
      path.join(
        unpackedNodeModules,
        "@anthropic-ai",
        "claude-agent-sdk",
        "vendor",
        "audio-capture",
      ),
      platform,
      arch,
    ),
    prunePlatformVendorDirectory(
      path.join(
        unpackedNodeModules,
        "@anthropic-ai",
        "claude-agent-sdk",
        "vendor",
        "ripgrep",
      ),
      platform,
      arch,
    ),
    prunePlatformVendorDirectory(
      path.join(
        unpackedNodeModules,
        "@anthropic-ai",
        "claude-agent-sdk",
        "vendor",
        "tree-sitter-bash",
      ),
      platform,
      arch,
    ),
    prunePlatformVendorDirectory(
      path.join(unpackedNodeModules, "node-pty", "prebuilds"),
      platform,
      arch,
    ),
    pruneSharpOptionalDependencies(
      path.join(unpackedNodeModules, "@img"),
      platform,
      arch,
    ),
  ]);

  if (platform !== "win32") {
    await removeIfExists(
      path.join(unpackedNodeModules, "node-pty", "deps", "winpty"),
    );
  }

  console.log(
    `Pruned packaged native vendor files for ${platform}/${arch} at ${normalizePath(resourcesDir)}`,
  );
};
