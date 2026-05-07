const fs = require("node:fs");
const path = require("node:path");

for (const lockFile of ["package-lock.json", "yarn.lock"]) {
  const lockPath = path.resolve(process.cwd(), lockFile);
  if (fs.existsSync(lockPath)) {
    fs.rmSync(lockPath, { force: true });
  }
}

const userAgent = process.env.npm_config_user_agent || "";
const execPath = (process.env.npm_execpath || "").toLowerCase();
const lifecycleScript = (process.env.npm_lifecycle_script || "").toLowerCase();
const invokedWithPnpm =
  userAgent.startsWith("pnpm/") ||
  execPath.includes("pnpm") ||
  lifecycleScript.includes("pnpm install") ||
  lifecycleScript.includes("pnpm add") ||
  lifecycleScript.includes("pnpm dlx");

if (!invokedWithPnpm) {
  console.error("Use pnpm instead");
  process.exit(1);
}
