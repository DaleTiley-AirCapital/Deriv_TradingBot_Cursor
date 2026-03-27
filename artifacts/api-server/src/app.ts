import express, { type Express } from "express";
import compression from "compression";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";

const app: Express = express();

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

let currentDir: string;
try {
  currentDir = path.dirname(fileURLToPath(import.meta.url));
} catch {
  currentDir = __dirname || process.cwd();
}

const candidatePaths = [
  path.resolve(currentDir, "../../deriv-quant/dist/public"),
  path.resolve(process.cwd(), "artifacts/deriv-quant/dist/public"),
];

const frontendDist = candidatePaths.find(p => fs.existsSync(p));

if (frontendDist) {
  console.log(`[Frontend] Serving static files from ${frontendDist}`);
  app.use(express.static(frontendDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

export default app;
