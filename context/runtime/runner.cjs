"use strict";

// src/localRunner.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");

// src/learning.ts
var ENTRY_FILES = {
  python: "main.py",
  rust: "main.rs",
  c: "main.c",
  cpp: "main.cpp",
  java: "Main.java",
  javascript: "main.js",
  typescript: "main.ts",
  go: "main.go",
  bash: "main.sh",
  zsh: "main.sh",
  pglab: "main.sh",
  sql: "main.sql"
};
function entryFile(language) {
  return ENTRY_FILES[language] ?? "main.txt";
}

// src/localRunner.ts
function assertInCourseContainer() {
  if (process.platform !== "linux" || !((0, import_node_fs.existsSync)("/run/.containerenv") || (0, import_node_fs.existsSync)("/.dockerenv")) || !(0, import_node_fs.existsSync)("/opt/dhimantai/runner.cjs")) {
    throw new Error("Host execution is disabled. Set up the course container or connect a remote runtime.");
  }
}
var RUN_TIMEOUT_MS = 45e3;
var COMPILE_TIMEOUT_MS = 12e4;
var OUTPUT_LIMIT = 2e5;
var windows = process.platform === "win32";
var exe = windows ? "main.exe" : "./main";
function plan(language) {
  switch (language) {
    case "bash":
    case "zsh":
      return { run: { tool: "shell", candidates: [language], args: ["main.sh"] }, install: "Use the course runtime for Bash and Zsh." };
    case "python":
      return { run: { tool: "python", candidates: windows ? ["python", "py"] : ["python3", "python"], args: ["-I", "main.py"] }, install: "Install Python 3 from python.org." };
    case "javascript":
      return { run: { tool: "node", candidates: ["node"], args: ["main.js"] }, install: "Install Node.js from nodejs.org." };
    case "typescript":
      return {
        // Type roots for @types/node are added at run time next to the resolved tsc (see typeRoots).
        compile: { tool: "tsc", candidates: ["tsc"], args: ["main.ts", "--strict", "--noEmitOnError", "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node"] },
        run: { tool: "node", candidates: ["node"], args: ["main.js"] },
        install: "Install Node.js, then run: npm install -g typescript @types/node"
      };
    case "cpp":
      return {
        compile: { tool: "cxx", candidates: ["g++", "clang++", "c++"], args: ["-std=c++17", "-Wall", "-Wextra", "main.cpp", "-o", windows ? "main.exe" : "main"] },
        run: { tool: "cxx", candidates: [exe], args: [] },
        install: "Use the C++ course runtime or install a C++17 compiler."
      };
    case "c":
      return {
        compile: { tool: "cc", candidates: ["gcc", "clang", "cc"], args: ["-std=c17", "-Wall", "-Wextra", "main.c", "-o", windows ? "main.exe" : "main", "-lm"] },
        run: { tool: "cc", candidates: [exe], args: [] },
        install: windows ? "Install a C compiler (MSYS2 gcc or LLVM clang) and add it to PATH." : "Install a C compiler (Xcode Command Line Tools on macOS: xcode-select --install; gcc on Linux)."
      };
    case "rust":
      return {
        compile: { tool: "rustc", candidates: ["rustc"], args: ["--edition=2021", "main.rs", "-o", windows ? "main.exe" : "main"] },
        run: { tool: "rustc", candidates: [exe], args: [] },
        install: "Install Rust from rustup.rs."
      };
    case "go":
      return {
        compile: { tool: "go", candidates: ["go"], args: ["build", "-o", windows ? "main.exe" : "main", "main.go"] },
        run: { tool: "go", candidates: [exe], args: [] },
        install: "Install Go from go.dev/dl."
      };
    case "java":
      return {
        compile: { tool: "javac", candidates: ["javac"], args: ["-encoding", "UTF-8", "Main.java"] },
        run: { tool: "java", candidates: ["java"], args: ["-cp", ".", "Main"] },
        install: "Install a Java 17+ JDK (for example Eclipse Temurin from adoptium.net)."
      };
    default:
      throw new Error(`Running ${language} programs locally is not supported.`);
  }
}
function exec(command, args, cwd, stdin, timeout, env) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", truncated = false, timedOut = false;
    const child = (0, import_node_child_process.spawn)(command, args, { cwd, env, shell: false, windowsHide: true });
    const append = (current, chunk) => {
      if (current.length >= OUTPUT_LIMIT) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > OUTPUT_LIMIT) {
        truncated = true;
        return next.slice(0, OUTPUT_LIMIT);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => stdout = append(stdout, chunk));
    child.stderr.on("data", (chunk) => stderr = append(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut, missing: error.code === "ENOENT", truncated });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const signalled = code === null && signal && !timedOut ? -(import_node_os.constants.signals[signal] ?? 0) || null : code;
      resolve({ code: signalled, stdout, stderr, timedOut, missing: false, truncated });
    });
    child.stdin.on("error", () => void 0);
    child.stdin.end(stdin);
  });
}
async function first(step, toolchains, cwd, stdin, timeout, env, extra = []) {
  const override = step.candidates[0].startsWith(".") || step.candidates[0].endsWith(".exe") ? void 0 : toolchains[step.tool];
  const candidates = override ? [override] : step.candidates;
  let outcome;
  for (const candidate of candidates) {
    const path = candidate.startsWith("./") || candidate === "main.exe" ? (0, import_node_path.join)(cwd, candidate.replace(/^\.\//, "")) : candidate;
    outcome = await exec(path, [...step.args, ...extra], cwd, stdin, timeout, env);
    if (!outcome.missing) return { command: [candidate, ...step.args, ...extra], outcome };
  }
  return { command: [candidates[0], ...step.args, ...extra], outcome };
}
function which(command, path = process.env.PATH ?? "") {
  if ((0, import_node_path.isAbsolute)(command)) return (0, import_node_fs.existsSync)(command) ? command : void 0;
  const extensions = windows ? [".cmd", ".exe", ""] : [""];
  for (const folder of path.split(import_node_path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = (0, import_node_path.join)(folder, command + extension);
      if ((0, import_node_fs.existsSync)(candidate)) return candidate;
    }
  }
  return void 0;
}
function typescript(tsc) {
  const found = which(tsc);
  if (!found) return void 0;
  let script;
  try {
    script = (0, import_node_fs.realpathSync)(found);
  } catch {
    return void 0;
  }
  if (script.endsWith(".cmd")) script = (0, import_node_path.join)((0, import_node_path.dirname)(script), "node_modules", "typescript", "bin", "tsc");
  if (!(0, import_node_fs.existsSync)(script) || !/typescript[\\/]bin[\\/]tsc$/.test(script)) return void 0;
  const modules = (0, import_node_path.dirname)((0, import_node_path.dirname)((0, import_node_path.dirname)(script)));
  return { script, typeArgs: (0, import_node_fs.existsSync)((0, import_node_path.join)(modules, "@types", "node")) ? ["--typeRoots", (0, import_node_path.join)(modules, "@types"), "--types", "node"] : [] };
}
function programEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LANG", "GOPATH", "GOROOT", "GOCACHE", "JAVA_HOME", "CARGO_HOME", "RUSTUP_HOME", "LOCALAPPDATA", "APPDATA"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PYTHONIOENCODING = "utf-8";
  return env;
}
var TRACE_LIMIT = 2e3;
async function traceLocally(tracer, input, toolchains = {}, limit = TRACE_LIMIT) {
  assertInCourseContainer();
  const dir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "dhimantai-trace-"));
  const env = programEnvironment();
  const out = (0, import_node_path.join)(dir, ".trace.json");
  env.DHIMANTAI_TRACE_OUT = out;
  const started = Date.now();
  try {
    await (0, import_promises.writeFile)((0, import_node_path.join)(dir, "main.py"), input.source);
    for (const file of input.files) await (0, import_promises.writeFile)((0, import_node_path.join)(dir, file.name), file.content);
    const step = { tool: "python", candidates: plan("python").run.candidates, args: ["-I", tracer, String(limit), "main.py"] };
    const { command, outcome } = await first(step, toolchains, dir, input.stdin, RUN_TIMEOUT_MS, env, input.argv);
    const execution = {
      status: outcome.missing ? "toolchain_missing" : outcome.timedOut ? "timeout" : "exited",
      exit_code: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.missing ? `${command[0]} was not found. ${plan("python").install}` : outcome.stderr,
      command: ["python3", "main.py", ...input.argv].map(quote).join(" "),
      duration_seconds: (Date.now() - started) / 1e3,
      truncated: outcome.truncated
    };
    let data = { steps: [], stopped: null, error: null, stdout: outcome.stdout };
    try {
      data = JSON.parse(await (0, import_promises.readFile)(out, "utf8"));
    } catch {
    }
    return { ...data, execution };
  } finally {
    await (0, import_promises.rm)(dir, { recursive: true, force: true }).catch(() => void 0);
  }
}
var quote = (part) => /^[\w./:=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
async function runLocally(language, input, toolchains = {}, timeoutMs = RUN_TIMEOUT_MS) {
  assertInCourseContainer();
  const steps = plan(language);
  const dir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "dhimantai-run-"));
  const started = Date.now();
  const env = programEnvironment();
  const result = (status, outcome, command, note = "") => ({
    status,
    exit_code: outcome?.code ?? null,
    stdout: outcome?.stdout ?? "",
    stderr: (outcome?.stderr ?? "") + note,
    command: command.map(quote).join(" "),
    duration_seconds: (Date.now() - started) / 1e3,
    truncated: outcome?.truncated ?? false
  });
  try {
    await (0, import_promises.writeFile)((0, import_node_path.join)(dir, entryFile(language)), input.source);
    for (const file of input.files) await (0, import_promises.writeFile)((0, import_node_path.join)(dir, file.name), file.content);
    if (steps.compile) {
      let compile = steps.compile;
      let extra = [];
      if (language === "typescript") {
        const ts = typescript(toolchains.tsc ?? "tsc");
        if (!ts) return result("toolchain_missing", void 0, ["tsc"], `tsc was not found. ${steps.install}`);
        compile = { tool: "node", candidates: ["node"], args: [ts.script, ...compile.args] };
        extra = ts.typeArgs;
      }
      const { command: command2, outcome: outcome2 } = await first(compile, toolchains, dir, "", COMPILE_TIMEOUT_MS, env, extra);
      if (outcome2.missing) return result("toolchain_missing", void 0, command2, `${command2[0]} was not found. ${steps.install}`);
      const diagnostics = { ...outcome2, code: null, stdout: "", stderr: outcome2.stdout + outcome2.stderr };
      if (outcome2.timedOut) return result("compile_timeout", diagnostics, command2);
      if (outcome2.code !== 0) return result("compile_error", diagnostics, command2);
    }
    const { command, outcome } = await first(steps.run, toolchains, dir, input.stdin, timeoutMs, env, input.argv);
    if (outcome.missing) return result("toolchain_missing", void 0, command, `${command[0]} was not found. ${steps.install}`);
    if (outcome.timedOut) return result("timeout", outcome, command);
    return result("exited", outcome, command);
  } finally {
    await (0, import_promises.rm)(dir, { recursive: true, force: true }).catch(() => void 0);
  }
}
var normalizeLines = (text) => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
async function runPublicTests(language, source, tests, pycall, toolchains = {}) {
  assertInCourseContainer();
  const results = [];
  for (const test of tests) {
    if (test.kind === "function") {
      results.push(await callLocally(source, test, pycall, toolchains));
      continue;
    }
    const execution = await runLocally(language, { source, argv: test.argv ?? [], stdin: test.stdin ?? "", files: test.files ?? [] }, toolchains, 1e4);
    const verdict = execution.status === "compile_error" || execution.status === "compile_timeout" ? "compile_error" : execution.status === "timeout" ? "timeout" : execution.status !== "exited" ? "not_run" : execution.exit_code !== 0 ? "runtime_error" : execution.truncated ? "wrong_answer" : normalizeLines(execution.stdout) === normalizeLines(test.expected) ? "passed" : "wrong_answer";
    results.push({ id: test.id, verdict, actual: execution.stdout, stderr: execution.stderr, duration_seconds: execution.duration_seconds });
  }
  return results;
}
async function callLocally(source, test, pycall, toolchains) {
  const dir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "dhimantai-test-"));
  const started = Date.now();
  try {
    await (0, import_promises.writeFile)((0, import_node_path.join)(dir, "main.py"), source);
    const step = { tool: "python", candidates: plan("python").run.candidates, args: ["-I", pycall, test.call ?? "", test.expected] };
    const { outcome } = await first(step, toolchains, dir, "", 1e4, programEnvironment());
    const base = { id: test.id, stderr: outcome.stderr, duration_seconds: (Date.now() - started) / 1e3 };
    if (outcome.missing) return { ...base, verdict: "not_run", actual: "", stderr: `Python was not found. ${plan("python").install}` };
    if (outcome.timedOut) return { ...base, verdict: "timeout", actual: "" };
    let value;
    try {
      value = JSON.parse(await (0, import_promises.readFile)((0, import_node_path.join)(dir, "_dhimantai_value.json"), "utf8"));
    } catch {
    }
    if (outcome.code !== 0 || !value) return { ...base, verdict: "runtime_error", actual: "" };
    return { ...base, verdict: value.equal ? "passed" : "wrong_answer", actual: value.repr };
  } finally {
    await (0, import_promises.rm)(dir, { recursive: true, force: true }).catch(() => void 0);
  }
}

// scripts/course-runner.ts
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { operation, language, input, tests } = JSON.parse(Buffer.concat(chunks).toString());
  const base = "/opt/dhimantai/";
  let result;
  switch (operation) {
    case "run":
      result = await runLocally(language, input);
      break;
    case "tests":
      result = await runPublicTests(language, input.source, tests, base + "pycall.py");
      break;
    case "trace":
      result = await traceLocally(base + "pytrace.py", input);
      break;
    default:
      throw new Error("Unknown runtime operation");
  }
  process.stdout.write(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
