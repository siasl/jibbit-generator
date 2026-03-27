import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = clampPort(process.env.PORT, 8000);
const host = String(process.env.HOST || "127.0.0.1");
const outputDir = path.resolve(process.env.JIBBITZ_OUTPUT_DIR || path.join(os.homedir(), "Downloads"));
const maxBodyBytes = 64 * 1024 * 1024;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function clampPort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new Error("Request body exceeded 64 MB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sanitizeFileName(rawName) {
  const baseName = path
    .basename(String(rawName || "").trim())
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const safeName = baseName || `jibbitz-${Date.now()}.3mf`;
  return safeName.toLowerCase().endsWith(".3mf") ? safeName : `${safeName}.3mf`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

async function launchBambuStudio(filePath) {
  const fileUrl = pathToFileURL(filePath).href;

  if (process.platform === "darwin") {
    try {
      await runCommand("open", ["-a", "Bambu Studio", filePath]);
      return;
    } catch (_err) {
      await runCommand("open", [filePath]);
      return;
    }
  }

  if (process.platform === "win32") {
    const uri = `bambustudio://open?file=${encodeURIComponent(fileUrl)}`;
    try {
      await runCommand("cmd", ["/c", "start", "", uri]);
      return;
    } catch (_err) {
      await runCommand("cmd", ["/c", "start", "", filePath]);
      return;
    }
  }

  if (process.platform === "linux") {
    try {
      await runCommand("xdg-open", [filePath]);
      return;
    } catch (_err) {
      const uri = `bambustudio://open?file=${encodeURIComponent(fileUrl)}`;
      await runCommand("xdg-open", [uri]);
      return;
    }
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function handleOpenInBambu(req, res) {
  try {
    const rawName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
    const fileName = sanitizeFileName(rawName);
    const body = await readRequestBody(req);
    if (!body.length) {
      sendJson(res, 400, { error: "No 3MF data received." });
      return;
    }

    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, body);

    try {
      await launchBambuStudio(filePath);
      sendJson(res, 200, { ok: true, path: filePath, saved: true, launched: true });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        path: filePath,
        saved: true,
        launched: false,
        error: error?.message || "Saved the 3MF, but could not launch Bambu Studio.",
      });
    }
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      saved: false,
      error: error?.message || "Failed to export the 3MF for Bambu Studio.",
    });
  }
}

async function serveStatic(req, res, requestUrl) {
  try {
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relativePath = pathname === "/" ? "/index.html" : pathname;
    const safeTarget = path.resolve(rootDir, `.${relativePath}`);
    if (!safeTarget.startsWith(rootDir + path.sep) && safeTarget !== rootDir) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    let filePath = safeTarget;
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) filePath = path.join(filePath, "index.html");

    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": file.length,
    });
    res.end(file);
  } catch (_error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/capabilities") {
    sendJson(res, 200, {
      openInBambu: true,
      outputDir,
      platform: process.platform,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/open-in-bambu") {
    await handleOpenInBambu(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, requestUrl);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(port, host, () => {
  console.log(`Jibbitz Generator server running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`Bambu Studio exports will be written to ${outputDir}`);
});
