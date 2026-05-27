/**
 * SIC Pipeline Extension
 *
 * Powers the foreman's orchestration with:
 * - set_session_objective: Set session objective (displayed in TUI)
 * - create_session_folder: Create .pi/sessions/<name>/ for this run
 * - write_file_sic: Write a per-file .sic contract into the session folder
 * - list_session_sics: List all .sic files in the session folder (with dependency order)
 * - read_file_sic: Read a specific .sic contract from the session folder
 * - resolve_paths: Search for ambiguous file names, show interactive selector if multiple matches
 * - dispatch_agent: Sequential agent dispatch (one at a time, non-blocking with abort support)
 *
 * Keyboard shortcuts:
 * - Ctrl+X: Abort pipeline
 * - F2: Skip current phase
 * - F3: Show pipeline status
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SelectList, Container, Text, Key } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolve, dirname, relative, join } from "node:path";
import { mkdir, writeFile, readFile, readdir, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";

export default function sicPipeline(pi: ExtensionAPI) {
  // ════════════════════════════════════════════════════════════════════════════
  // SHARED STATE
  // ════════════════════════════════════════════════════════════════════════════

  let sessionObjective: string | null = null;
  let sessionFolder: string | null = null;
  let sessionName: string | null = null;
  let phaseOutputs: Record<string, string> = {};

  // Pipeline control state (for keyboard shortcuts)
  let pipelineActive = false;
  let pipelineAborted = false;
  let skipCurrentPhase = false;
  let currentAgent: string | null = null;

  // ════════════════════════════════════════════════════════════════════════════
  // STATE RECONSTRUCTION
  // ════════════════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    sessionObjective = null;
    sessionFolder = null;
    sessionName = null;
    phaseOutputs = {};
    pipelineActive = false;
    pipelineAborted = false;
    skipCurrentPhase = false;
    currentAgent = null;

    // Reconstruct state from session branch
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const d = entry.message.details;
        if (entry.message.toolName === "set_session_objective" && d?.objective) {
          sessionObjective = d.objective;
        }
        if (entry.message.toolName === "create_session_folder" && d?.folder) {
          sessionFolder = d.folder;
          sessionName = d.name;
        }
        if (entry.message.toolName === "dispatch_agent" && d?.agent && d?.output) {
          phaseOutputs[d.agent] = d.output;
        }
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerShortcut(Key.ctrl("x"), {
    description: "Abort the SIC pipeline",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!pipelineActive) {
        ctx.ui.notify("No pipeline running", "info");
        return;
      }
      pipelineAborted = true;
      ctx.ui.notify(`⛔ Aborting pipeline (after ${currentAgent} finishes)`, "warning");
    },
  });

  pi.registerShortcut("f2", {
    description: "Skip current pipeline agent",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!pipelineActive) {
        ctx.ui.notify("No pipeline running", "info");
        return;
      }
      skipCurrentPhase = true;
      ctx.ui.notify(`⏭ Will skip ${currentAgent} output`, "info");
    },
  });

  pi.registerShortcut("f3", {
    description: "Show pipeline progress",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!pipelineActive) {
        ctx.ui.notify("Pipeline idle", "info");
        return;
      }
      const phases = Object.keys(phaseOutputs).join(" → ") || "(none completed)";
      ctx.ui.notify(
        `🔧 Running: ${currentAgent}\n🎯 ${sessionObjective ?? "no objective"}\n✓ Completed: ${phases}`,
        "info"
      );
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: set_session_objective
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "set_session_objective",
    label: "Set Session Objective",
    description: `Set the session objective — the human's answer to "What are we doing today?"

This becomes the guiding context for all agents in the pipeline. Call this ONCE at the start after the human answers the foreman's opening question.`,
    promptSnippet: "Set the session objective for the SIC pipeline",

    parameters: Type.Object({
      objective: Type.String({
        description: "The session objective — what we're building today",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { objective } = params;
      sessionObjective = objective;

      return {
        content: [{ type: "text", text: `═══ SESSION OBJECTIVE SET ═══\n\n🎯 ${objective}\n\nThis objective is now visible to all agents in the pipeline.` }],
        details: { objective },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: create_session_folder
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "create_session_folder",
    label: "Create Session Folder",
    description: `Create the session folder at .pi/sessions/<session-name>/.

This folder holds all per-file .sic contracts for this implementation run. The scribe writes into it, the mason reads from it. The folder structure mirrors the repo structure.

Call this ONCE after setting the session objective.`,
    promptSnippet: "Create a session folder for SIC contracts",

    parameters: Type.Object({
      name: Type.String({
        description: "Session name slug (lowercase, hyphens, no spaces). E.g., 'add-sum-to-helpers'",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { name } = params;
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      const folderPath = resolve(ctx.cwd, ".pi", "sessions", slug);
      await mkdir(folderPath, { recursive: true });

      sessionFolder = folderPath;
      sessionName = slug;

      return {
        content: [{ type: "text", text: `═══ SESSION FOLDER CREATED ═══\n\nPath: .pi/sessions/${slug}/\n\nThe scribe will write per-file .sic contracts here, mirroring the repo structure.` }],
        details: { folder: folderPath, name: slug },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: resolve_paths
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "resolve_paths",
    label: "Resolve File Paths",
    description: `Search for files matching a vague or partial name. If multiple matches are found, shows an interactive selector overlay where the user picks the correct file using arrow keys.

Use this when the user mentions a file by partial name (e.g., "helpers.ts", "the controller", "auth middleware") and you need to resolve it to an exact path.

Returns the user's selected path, or the single match if unambiguous.`,
    promptSnippet: "Resolve ambiguous file paths with interactive selection",

    parameters: Type.Object({
      query: Type.String({
        description: "The file name or pattern to search for (e.g., 'helpers.ts', '*auth*controller*')",
      }),
      label: Type.Optional(Type.String({
        description: "Optional label shown in the selector (e.g., 'Which helpers file?'). Defaults to the query.",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { query, label } = params;

      // Search for matching files using spawn (non-blocking)
      const pattern = query.includes("*") ? query : `*${query}*`;
      const matches = await findMatchingFiles(ctx.cwd, pattern, query, signal);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No files found matching "${query}". Ask the user for a more specific path.` }],
          details: { query, matches: [] },
        };
      }

      // Single match — return it directly
      if (matches.length === 1) {
        return {
          content: [{ type: "text", text: `✓ Resolved: ${matches[0]}` }],
          details: { query, resolved: matches[0] },
        };
      }

      // Multiple matches — check if we have UI
      if (!ctx.hasUI) {
        // In headless mode, return the list for the LLM to choose
        const list = matches.map((m, i) => `  ${i + 1}. ${m}`).join("\n");
        return {
          content: [{ type: "text", text: `Multiple matches for "${query}":\n${list}\n\nAsk the user which file they mean.` }],
          details: { query, matches },
        };
      }

      // Multiple matches — show interactive SelectList overlay
      const items = matches.map((path) => ({
        value: path,
        label: path,
        description: dirname(path),
      }));

      const title = label || `Which file for "${query}"?`;

      const selected = await pi.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();

          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          container.addChild(new Text(
            theme.fg("accent", theme.bold(` 📂 ${title}`)),
            1, 0
          ));
          container.addChild(new Text(
            theme.fg("dim", `  ${matches.length} matches found`),
            1, 0
          ));

          const selectList = new SelectList(
            items,
            Math.min(items.length, 15),
            {
              selectedPrefix: (t: string) => theme.fg("accent", t),
              selectedText: (t: string) => theme.fg("accent", t),
              description: (t: string) => theme.fg("dim", t),
              scrollInfo: (t: string) => theme.fg("muted", t),
              noMatch: (t: string) => theme.fg("warning", t),
            }
          );

          selectList.onSelect = (item: any) => done(item.value);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);

          container.addChild(new Text(
            theme.fg("dim", "  ↑↓ navigate • enter select • esc cancel"),
            1, 0
          ));

          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true }
      );

      if (selected) {
        return {
          content: [{ type: "text", text: `✓ User selected: ${selected}` }],
          details: { query, resolved: selected },
        };
      } else {
        return {
          content: [{ type: "text", text: `✗ User cancelled selection for "${query}". Ask for clarification.` }],
          details: { query, cancelled: true },
        };
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: write_file_sic
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "write_file_sic",
    label: "Write File SIC",
    description: `Write a per-file .sic contract into the session folder.

The .sic file mirrors the target file's path within the session folder, but with a .sic extension.

Example: If the target file is "libs/front/tools/helpers.ts", the .sic is written to:
  .pi/sessions/<session>/libs/front/tools/helpers.sic

Each .sic describes modifications to EXACTLY ONE file. The mason reads them one at a time.`,
    promptSnippet: "Write a per-file SIC contract to the session folder",

    parameters: Type.Object({
      target_file: Type.String({
        description: "Relative path of the target file in the repo (e.g., 'libs/front/tools/helpers.ts')",
      }),
      contract: Type.String({
        description: "The full .sic contract content for this file",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { target_file, contract } = params;

      if (!sessionFolder || !sessionName) {
        return {
          content: [{ type: "text", text: "ERROR: No session folder created. Call create_session_folder first." }],
          details: {},
        };
      }

      const sicPath = target_file.replace(/\.[^.]+$/, ".sic");
      const fullPath = resolve(sessionFolder, sicPath);

      await mkdir(dirname(fullPath), { recursive: true });

      const timestamp = new Date().toISOString();
      const header = `# SIC for: ${target_file}\n# Session: ${sessionName}\n# Created: ${timestamp}\n# Objective: ${sessionObjective || "not set"}\n\n`;
      const content = header + contract + "\n";

      await writeFile(fullPath, content, "utf8");

      const relativeSicPath = `.pi/sessions/${sessionName}/${sicPath}`;
      return {
        content: [{ type: "text", text: `✓ Contract written: ${relativeSicPath}` }],
        details: { sicPath: relativeSicPath, targetFile: target_file },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: list_session_sics
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "list_session_sics",
    label: "List Session SICs",
    description: `List all .sic files in the current session folder.

Returns them in dependency order (based on DEPENDS_ON fields). Files with no dependencies come first.

Use this to know which contracts exist and in what order the mason should process them.`,
    promptSnippet: "List all SIC contracts in the current session",

    parameters: Type.Object({}),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!sessionFolder || !sessionName) {
        return {
          content: [{ type: "text", text: "ERROR: No session folder. Call create_session_folder first." }],
          details: {},
        };
      }

      const sicFiles = await findFiles(sessionFolder, ".sic");

      if (sicFiles.length === 0) {
        return {
          content: [{ type: "text", text: "No .sic files found in session folder. The scribe hasn't written contracts yet." }],
          details: { count: 0 },
        };
      }

      const contracts: { path: string; relativePath: string; dependsOn: string[] }[] = [];

      for (const filePath of sicFiles) {
        const content = await readFile(filePath, "utf8");
        const relativePath = relative(sessionFolder, filePath);

        const dependsMatch = content.match(/DEPENDS_ON:\n((?:- .+\n)*)/);
        const dependsOn: string[] = [];
        if (dependsMatch) {
          const lines = dependsMatch[1].split("\n").filter(l => l.startsWith("- "));
          for (const line of lines) {
            const dep = line.replace(/^- /, "").trim();
            if (dep && dep !== "none") {
              dependsOn.push(dep);
            }
          }
        }

        contracts.push({ path: filePath, relativePath, dependsOn });
      }

      const ordered = topologicalSort(contracts);

      let output = `═══ SESSION CONTRACTS ═══\n\n`;
      output += `Session: .pi/sessions/${sessionName}/\n`;
      output += `Total contracts: ${ordered.length}\n\n`;
      output += `Execution order:\n`;

      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i];
        const deps = c.dependsOn.length > 0 ? ` (after: ${c.dependsOn.join(", ")})` : "";
        output += `  ${i + 1}. ${c.relativePath}${deps}\n`;
      }

      output += `\n═══ END LIST ═══`;

      return {
        content: [{ type: "text", text: output }],
        details: { count: ordered.length, order: ordered.map(c => c.relativePath) },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: read_file_sic
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "read_file_sic",
    label: "Read File SIC",
    description: `Read a specific .sic contract from the session folder.`,
    promptSnippet: "Read a SIC contract from the session folder",

    parameters: Type.Object({
      sic_path: Type.String({
        description: "Relative path of the .sic file within the session folder",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { sic_path } = params;

      if (!sessionFolder || !sessionName) {
        return {
          content: [{ type: "text", text: "ERROR: No session folder." }],
          details: {},
        };
      }

      const fullPath = resolve(sessionFolder, sic_path);

      try {
        const content = await readFile(fullPath, "utf8");
        return {
          content: [{ type: "text", text: content }],
          details: { sicPath: sic_path },
        };
      } catch {
        return {
          content: [{ type: "text", text: `ERROR: Could not read .pi/sessions/${sessionName}/${sic_path}` }],
          details: { error: "not_found", sicPath: sic_path },
        };
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: dispatch_agent
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: `Dispatch a single agent and wait for its complete response.

Used by the foreman to execute pipeline phases sequentially. CRITICAL: dispatch ONE agent at a time. Never call multiple times in the same turn.

For the mason: dispatch ONCE PER .sic FILE.

Supports abort (Ctrl+X) and skip (F2) keyboard shortcuts during execution.`,
    promptSnippet: "Dispatch a pipeline agent sequentially",

    parameters: Type.Object({
      agent: Type.String({
        description: "Agent name: scribe, scout, mason, inspector, auditor, or clerk",
      }),
      prompt: Type.String({
        description: "Full prompt including session context, contract content, and previous phase output",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent, prompt } = params;
      const validAgents = ["scribe", "scout", "mason", "inspector", "auditor", "clerk"];

      if (!validAgents.includes(agent)) {
        return {
          content: [{ type: "text", text: `ERROR: Invalid agent "${agent}". Valid: ${validAgents.join(", ")}` }],
          details: { error: "invalid_agent" },
        };
      }

      // Check abort flag
      if (pipelineAborted) {
        pipelineAborted = false;
        pipelineActive = false;
        currentAgent = null;
        return {
          content: [{ type: "text", text: "═══ PIPELINE ABORTED ═══\n\nUser requested abort via Ctrl+X." }],
          details: { agent, aborted: true },
        };
      }

      // Build the full prompt with session context
      let fullPrompt = "";
      if (sessionObjective) {
        fullPrompt += `═══ SESSION OBJECTIVE ═══\n${sessionObjective}\n\n`;
      }
      if (sessionFolder && sessionName) {
        fullPrompt += `═══ SESSION FOLDER ═══\n.pi/sessions/${sessionName}/\n\n`;
      }
      fullPrompt += prompt;

      // Write prompt to temp file (avoids shell escaping issues)
      const tmpDir = await mkdtemp(join(tmpdir(), "sic-"));
      const promptFile = join(tmpDir, "prompt.md");
      await writeFile(promptFile, fullPrompt, "utf-8");

      // Set pipeline state
      pipelineActive = true;
      currentAgent = agent;
      skipCurrentPhase = false;

      try {
        const args = [
          "--mode", "json",
          "-p",
          "--no-session",
          "--agent", `sic-pipeline/${agent}`,
          promptFile,
        ];

        const result = await new Promise<string>((resolvePromise, reject) => {
          const proc = spawn("pi", args, {
            cwd: ctx.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          });

          let output = "";
          let stderr = "";
          let buffer = "";

          proc.stdout.on("data", (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                // Capture assistant text from message events
                if (event.type === "assistant" && event.message?.content) {
                  for (const part of event.message.content) {
                    if (part.type === "text") {
                      output = part.text;
                    }
                  }
                }
                // Also capture from result events
                if (event.type === "result" && event.result) {
                  output = event.result;
                }
              } catch {
                // Non-JSON line, skip
              }
            }

            // Send progress updates
            if (output && onUpdate) {
              onUpdate({
                content: [{ type: "text", text: `[${agent}] ${output.slice(0, 300)}...` }],
                details: { agent, status: "running" },
              });
            }
          });

          proc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });

          proc.on("close", (code: number | null) => {
            if (skipCurrentPhase) {
              skipCurrentPhase = false;
              resolvePromise(`[SKIPPED by user]\n\nPartial output:\n${output.slice(0, 1000)}`);
            } else if (code === 0) {
              resolvePromise(output || "(no output)");
            } else {
              reject(new Error(
                `Agent ${agent} failed (exit ${code}):\n${stderr.slice(0, 2000)}\n\nPartial output:\n${output.slice(0, 2000)}`
              ));
            }
          });

          proc.on("error", (err: Error) => {
            reject(new Error(`Failed to spawn agent ${agent}: ${err.message}`));
          });

          // Abort support via signal
          if (signal) {
            const kill = () => {
              proc.kill("SIGTERM");
              setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
            };
            if (signal.aborted) {
              kill();
            } else {
              signal.addEventListener("abort", kill, { once: true });
            }
          }

          // Also check pipeline abort flag periodically
          const abortCheck = setInterval(() => {
            if (pipelineAborted) {
              clearInterval(abortCheck);
              proc.kill("SIGTERM");
              setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
            }
          }, 1000);

          proc.on("close", () => clearInterval(abortCheck));
        });

        phaseOutputs[agent] = result;

        return {
          content: [{ type: "text", text: `═══ ${agent.toUpperCase()} COMPLETE ═══\n\n${result}\n\n═══ END ${agent.toUpperCase()} ═══` }],
          details: { agent, output: result },
        };
      } catch (error: any) {
        const errorMsg = error.message || String(error);

        if (pipelineAborted) {
          pipelineAborted = false;
          return {
            content: [{ type: "text", text: `═══ ${agent.toUpperCase()} ABORTED ═══\n\nPipeline abort requested.\n\n${errorMsg.slice(0, 1000)}` }],
            details: { agent, aborted: true },
          };
        }

        return {
          content: [{ type: "text", text: `═══ ${agent.toUpperCase()} ERROR ═══\n\n${errorMsg}` }],
          details: { agent, error: errorMsg },
        };
      } finally {
        pipelineActive = false;
        currentAgent = null;

        // Cleanup temp files
        try { await unlink(promptFile); } catch {}
        try { await rmdir(tmpDir); } catch {}
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════════════

  async function findMatchingFiles(
    cwd: string,
    pattern: string,
    rawQuery: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    return new Promise((resolvePromise) => {
      const proc = spawn("find", [
        ".", "-type", "f",
        "-name", pattern,
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/.git/*",
        "-not", "-path", "*/dist/*",
        "-not", "-path", "*/.pi/sessions/*",
      ], { cwd, stdio: ["ignore", "pipe", "pipe"] });

      let output = "";
      proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      proc.on("close", () => {
        const matches = output.trim().split("\n")
          .filter(Boolean)
          .map(p => p.replace(/^\.\//, ""))
          .sort();

        if (matches.length > 0) {
          resolvePromise(matches);
        } else {
          // Retry with exact name (no glob wrapper)
          const proc2 = spawn("find", [
            ".", "-type", "f",
            "-name", rawQuery,
            "-not", "-path", "*/node_modules/*",
            "-not", "-path", "*/.git/*",
          ], { cwd, stdio: ["ignore", "pipe", "pipe"] });

          let output2 = "";
          proc2.stdout.on("data", (data: Buffer) => { output2 += data.toString(); });
          proc2.on("close", () => {
            const matches2 = output2.trim().split("\n")
              .filter(Boolean)
              .map(p => p.replace(/^\.\//, ""))
              .sort();
            resolvePromise(matches2);
          });
          proc2.on("error", () => resolvePromise([]));
        }
      });
      proc.on("error", () => resolvePromise([]));

      // Timeout after 10 seconds
      setTimeout(() => {
        proc.kill("SIGTERM");
        resolvePromise([]);
      }, 10000);
    });
  }

  async function findFiles(dir: string, extension: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findFiles(fullPath, extension));
      } else if (entry.name.endsWith(extension)) {
        results.push(fullPath);
      }
    }

    return results;
  }

  function topologicalSort(
    contracts: { path: string; relativePath: string; dependsOn: string[] }[]
  ): typeof contracts {
    const sorted: typeof contracts = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(contract: typeof contracts[0]) {
      if (visited.has(contract.relativePath)) return;
      if (visiting.has(contract.relativePath)) {
        // Circular dependency — just add it
        sorted.push(contract);
        visited.add(contract.relativePath);
        return;
      }

      visiting.add(contract.relativePath);
      for (const dep of contract.dependsOn) {
        const depContract = contracts.find(c => c.relativePath === dep);
        if (depContract) visit(depContract);
      }
      visiting.delete(contract.relativePath);
      visited.add(contract.relativePath);
      sorted.push(contract);
    }

    for (const c of contracts) visit(c);
    return sorted;
  }
}
