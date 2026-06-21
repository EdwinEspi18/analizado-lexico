const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { parse } = require("./parser");
const { analyze } = require("./semantic");

const ROOT = path.resolve(__dirname, "..");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PUBLIC_DIR = path.join(ROOT, "public");
app.use(express.static(PUBLIC_DIR));

function runLexer(source) {
  return new Promise((resolve, reject) => {
    const LEXER_BIN = path.join(ROOT, "lexer", "lexer");
    const child = spawn(LEXER_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !out) {
        return reject(new Error(`Lexer salió con código ${code}: ${err}`));
      }
      resolve(out);
    });
    child.stdin.write(source);
    child.stdin.end();
  });
}

function parseLexerOutput(raw) {
  const tokens = [];
  const errors = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts[0] === "TOKEN" && parts.length === 5) {
      tokens.push({
        type: parts[1],
        lexeme: parts[2],
        line: Number(parts[3]),
        column: Number(parts[4]),
      });
    } else if (parts[0] === "ERROR" && parts.length === 5) {
      errors.push({
        message: parts[1],
        lexeme: parts[2],
        line: Number(parts[3]),
        column: Number(parts[4]),
      });
    }
  }
  return { tokens, errors };
}

app.post("/analyze", async (req, res) => {
  const source =
    req.body && typeof req.body.source === "string" ? req.body.source : "";
  try {
    const raw = await runLexer(source);
    const result = parseLexerOutput(raw);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/parse", async (req, res) => {
  const source =
    req.body && typeof req.body.source === "string" ? req.body.source : "";
  try {
    const raw = await runLexer(source);
    const { tokens, errors: lexErrors } = parseLexerOutput(raw);
    const { ast, errors: synErrors } = parse(tokens);
    res.json({ tokens, ast, lexErrors, synErrors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/semantic", async (req, res) => {
  const source =
    req.body && typeof req.body.source === "string" ? req.body.source : "";
  try {
    const raw = await runLexer(source);
    const { tokens, errors: lexErrors } = parseLexerOutput(raw);
    const { ast, errors: synErrors } = parse(tokens);
    const { tablaSimbolos, errores: semErrors } = analyze(ast);
    res.json({ tokens, ast, lexErrors, synErrors, tablaSimbolos, semErrors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Escuchando en http://localhost:${PORT}`);
});
