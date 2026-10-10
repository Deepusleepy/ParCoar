import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = dirname(fileURLToPath(import.meta.url));
copyFileSync(
  resolve(frontendDir, "../../shared/lot.json"),
  resolve(frontendDir, "../public/lot.json"),
);
