/**
 * SIC Pipeline Extension v2.0
 *
 * Powers the foreman's orchestration with:
 * - set_session_objective: Set session objective (displayed in TUI)
 * - create_session_folder: Create .pi/sessions/<name>/ for this run
 * - write_file_sic: Write a per-file .sic contract (YAML format) into the session folder
 * - list_session_sics: List all .sic files in the session folder (with dependency order)
 * - read_file_sic: Read a specific .sic contract from the session folder
 * - resolve_paths: Search for ambiguous file names, show interactive selector if multiple matches
 * - dispatch_agent: Sequential agent dispatch with programmatic retry
 * - dispatch_parallel: Parallel agent dispatch for independent tasks
 * - estimate_pipeline: Estimate cost/time before running the pipeline
 * - assess_complexity: Determine if task needs full pipeline or fast path
 * - clean_sessions: Archive or delete old session folders
 *
 * Keyboard shortcuts:
 * - Ctrl+X: Abort pipeline
 * - F2: Skip current phase
 * - F3: Show pipeline status
 *
 * Improvements over v1:
 * - getPiInvocation() for reliable subprocess spawning (NixOS, Bun, etc.)
 * - --no-extensions on subprocesses to prevent recursion
 * - session_tree event handling for branch navigation
 * - Parallel mason dispatch for independent .sic files
 * - Cost/time estimation before pipeline runs
 * - Session folder lifecycle management (cleanup)
 * - YAML-based contract format (standard parsing)
 * - Programmatic retry with error context injection
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SelectList, Container, Text, Key, DynamicBorder } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { resolve, dirname, relative, join, basename } from "node:path";
import { mkdir, writeFile, readFile, readdir, stat, rm, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface SicContract {
  file: string;
  action: "create" | "modify";
  purpose: string;
  depends_on: string[];
  context?: string;
  modifications: string[];
  location_hints?: string[];
  new_imports?: string[];
  new_exports?: string[];
  constraints: string[];
  done_when: string[];
}

interface PipelineState {
  objective: string | null;
  sessionFolder: string | null;
  sessionName: string | null;
  phaseOutputs: Record<string, string>;
  pipelineActive: boolean;
  pipelineAborted: boolean;
  skipCurrentPhase: boolean;
  currentAgent: string | null;
  complexity: "trivial" | "simple" | "complex" | null;
  startTime: number | null;
}

const MAX_RETRIES = 1;
const MAX_PARALLEL_MASON = 4;

export default function sicPipeline(pi: ExtensionAPI) {
  // ════════════════════════════════════════════════════════════════════════════
  // SHARED STATE
  // ════════════════════════════════════════════════════════════════════════════

  let state: PipelineState = freshState();

  function freshState(): PipelineState {
    return {
      objective: null,
      sessionFolder: null,
      sessionName: null,
      phaseOutputs: {},
      pipelineActive: false,
      pipelineAborted: false,
      skipCurrentPhase: false,
      currentAgent: null,
      complexity: null,
      startTime: null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RELIABLE PI BINARY DISCOVERY (Improvement #2)
  // ════════════════════════════════════════════════════════════════════════════

  function getPiInvocation(args: string[]): { command: string; args: string[] } {
    // Check if we were invoked via a script path (standard Node/Bun)
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

    if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }

    // Check if the runtime binary IS pi (not generic node/bun)
    const execName = basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

    if (!isGenericRuntime) {
      return { command: process.execPath, args };
    }

    // Fallback: hope "pi" is on PATH
    return { command: "pi", args };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STATE RECONSTRUCTION (Improvement #4 — handles session_tree)
  // ════════════════════════════════════════════════════════════════════════════

  function reconstructState(ctx: ExtensionContext) {
    state = freshState();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const d = entry.message.details;
        if (entry.message.toolName === "set_session_objective" && d?.objective) {
          state.objective = d.objective;
        }
        if (entry.message.toolName === "create_session_folder" && d?.folder) {
          state.sessionFolder = d.folder;
          state.sessionName = d.name;
        }
        if (entry.message.toolName === "dispatch_agent" && d?.agent && d?.output) {
          state.phaseOutputs[d.agent] = d.output;
        }
        if (entry.message.toolName === "assess_complexity" && d?.complexity) {
          state.complexity = d.complexity;
        }
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    reconstructState(ctx);
  });

  // Improvement #4: Handle branch navigation
  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(ctx);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerShortcut(Key.ctrl("x"), {
    description: "Abort the SIC pipeline",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!state.pipelineActive) {
        ctx.ui.notify("No pipeline running", "info");
        return;
      }
      state.pipelineAborted = true;
      ctx.ui.notify(`⛔ Aborting pipeline (after ${state.currentAgent} finishes)`, "warning");
    },
  });

  pi.registerShortcut("f2", {
    description: "Skip current pipeline agent",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!state.pipelineActive) {
        ctx.ui.notify("No pipeline running", "info");
        return;
      }
      state.skipCurrentPhase = true;
      ctx.ui.notify(`⏭ Will skip ${state.currentAgent} output`, "info");
    },
  });

  pi.registerShortcut("f3", {
    description: "Show pipeline progress",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!state.pipelineActive) {
        ctx.ui.notify("Pipeline idle", "info");
        return;
      }
      const phases = Object.keys(state.phaseOutputs).join(" → ") || "(none completed)";
      const elapsed = state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0;
      ctx.ui.notify(
        `🔧 Running: ${state.currentAgent}\n🎯 ${state.objective ?? "no objective"}\n✓ Completed: ${phases}\n⏱ Elapsed: ${elapsed}s`,
        "info"
      );
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: assess_complexity (Improvement #1 — Fast Path)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "assess_complexity",
    label: "Assess Task Complexity",
    description: `Assess the complexity of the user's request to determine which pipeline path to use.

Call this BEFORE starting the full pipeline. It determines:
- **trivial**: Single file, obvious change → skip directly to mason (no scribe/scout/auditor/clerk)
- **simple**: 1-2 files, clear spec → use scribe + mason + inspector only (skip scout/auditor/clerk)  
- **complex**: 3+ files, dependencies, architectural decisions → full pipeline

The foreman should ask "What are we doing today?", then call this tool with the answer to decide the execution path.`,
    promptSnippet: "Assess task complexity to choose pipeline path",

    parameters: Type.Object({
      description: Type.String({
        description: "The user's description of what they want to do",
      }),
      file_count: Type.Number({
        description: "Estimated number of files to modify/create (1, 2, 3+)",
      }),
      has_dependencies: Type.Boolean({
        description: "Whether files depend on each other (imports, shared types)",
      }),
      needs_discovery: Type.Boolean({
        description: "Whether the repo conventions are unknown and need scouting",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { description, file_count, has_dependencies, needs_discovery } = params;

      let complexity: "trivial" | "simple" | "complex";
      let path: string;
      let agents: string[];

      if (file_count <= 1 && !has_dependencies && !needs_discovery) {
        complexity = "trivial";
        path = "FAST PATH";
        agents = ["mason", "inspector"];
      } else if (file_count <= 2 && !needs_discovery) {
        complexity = "simple";
        path = "SIMPLE PATH";
        agents = ["scribe", "mason", "inspector"];
      } else {
        complexity = "complex";
        path = "FULL PIPELINE";
        agents = ["scribe", "scout", "mason", "inspector", "auditor", "clerk"];
      }

      state.complexity = complexity;

      const estimate = estimateCostTime(agents, file_count);

      return {
        content: [{ type: "text", text: `═══ COMPLEXITY ASSESSMENT ═══

Task: ${description}
Files: ${file_count}
Dependencies: ${has_dependencies ? "yes" : "no"}
Discovery needed: ${needs_discovery ? "yes" : "no"}

Complexity: ${complexity.toUpperCase()}
Path: ${path}
Agents: ${agents.join(" → ")}

Estimated time: ${estimate.timeMin}-${estimate.timeMax}s
Estimated cost: ~$${estimate.cost.toFixed(3)}

═══ END ASSESSMENT ═══` }],
        details: { complexity, path, agents, estimate },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: estimate_pipeline (Improvement #6 — Cost/Time Estimation)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "estimate_pipeline",
    label: "Estimate Pipeline Cost",
    description: `Estimate the cost and time for the full pipeline run BEFORE starting.

Call this after assess_complexity and before dispatching agents. Shows the user what to expect so they can confirm or abort.`,
    promptSnippet: "Estimate pipeline cost and time",

    parameters: Type.Object({
      agents: Type.Array(Type.String(), {
        description: "List of agents that will be dispatched",
      }),
      file_count: Type.Number({
        description: "Number of .sic files (mason dispatches)",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agents, file_count } = params;
      const estimate = estimateCostTime(agents, file_count);

      return {
        content: [{ type: "text", text: `═══ PIPELINE ESTIMATE ═══

Agents to dispatch: ${agents.join(" → ")}
Mason dispatches: ${file_count} file(s)
Total LLM calls: ~${agents.length + Math.max(0, file_count - 1)}

Estimated time: ${estimate.timeMin}-${estimate.timeMax} seconds
Estimated token cost: ~$${estimate.cost.toFixed(3)}

Note: Actual cost depends on model, context size, and output length.

═══ END ESTIMATE ═══` }],
        details: { estimate, agents, file_count },
      };
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
      state.objective = objective;
      state.startTime = Date.now();

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

      state.sessionFolder = folderPath;
      state.sessionName = slug;

      return {
        content: [{ type: "text", text: `═══ SESSION FOLDER CREATED ═══\n\nPath: .pi/sessions/${slug}/\n\nThe scribe will write per-file .sic contracts here (YAML format), mirroring the repo structure.` }],
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

      const pattern = query.includes("*") ? query : `*${query}*`;
      const matches = await findMatchingFiles(ctx.cwd, pattern, query, signal);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No files found matching "${query}". Ask the user for a more specific path.` }],
          details: { query, matches: [] },
        };
      }

      if (matches.length === 1) {
        return {
          content: [{ type: "text", text: `✓ Resolved: ${matches[0]}` }],
          details: { query, resolved: matches[0] },
        };
      }

      if (!ctx.hasUI) {
        const list = matches.map((m, i) => `  ${i + 1}. ${m}`).join("\n");
        return {
          content: [{ type: "text", text: `Multiple matches for "${query}":\n${list}\n\nAsk the user which file they mean.` }],
          details: { query, matches },
        };
      }

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
  // TOOL: write_file_sic (Improvement #8 — YAML format)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "write_file_sic",
    label: "Write File SIC",
    description: `Write a per-file .sic contract into the session folder using YAML format.

The .sic file mirrors the target file's path within the session folder, but with a .sic extension.

Example: If the target file is "libs/front/tools/helpers.ts", the .sic is written to:
  .pi/sessions/<session>/libs/front/tools/helpers.sic

The contract MUST be valid YAML with these required fields:
  file, action, purpose, modifications, constraints, done_when

Optional fields:
  depends_on, context, location_hints, new_imports, new_exports`,
    promptSnippet: "Write a per-file SIC contract (YAML format) to the session folder",

    parameters: Type.Object({
      target_file: Type.String({
        description: "Relative path of the target file in the repo (e.g., 'libs/front/tools/helpers.ts')",
      }),
      contract: Type.String({
        description: "The full .sic contract content in YAML format",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { target_file, contract } = params;

      if (!state.sessionFolder || !state.sessionName) {
        throw new Error("No session folder created. Call create_session_folder first.");
      }

      // Validate YAML
      let parsed: any;
      try {
        parsed = parseYaml(contract);
      } catch (e: any) {
        throw new Error(`Invalid YAML in contract: ${e.message}`);
      }

      // Validate required fields
      const required = ["file", "action", "purpose", "modifications", "constraints", "done_when"];
      const missing = required.filter(f => !parsed[f]);
      if (missing.length > 0) {
        throw new Error(`Contract missing required fields: ${missing.join(", ")}`);
      }

      if (!["create", "modify"].includes(parsed.action)) {
        throw new Error(`Invalid action "${parsed.action}". Must be "create" or "modify".`);
      }

      const sicPath = target_file.replace(/\.[^.]+$/, ".sic");
      const fullPath = resolve(state.sessionFolder, sicPath);

      await mkdir(dirname(fullPath), { recursive: true });

      const header = `# SIC for: ${target_file}\n# Session: ${state.sessionName}\n# Created: ${new Date().toISOString()}\n# Objective: ${state.objective || "not set"}\n\n`;
      const content = header + contract + "\n";

      await writeFile(fullPath, content, "utf8");

      const relativeSicPath = `.pi/sessions/${state.sessionName}/${sicPath}`;
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

Returns them in dependency order (based on depends_on fields). Files with no dependencies come first. Also identifies which files can be processed in parallel (independent groups).`,
    promptSnippet: "List all SIC contracts in the current session",

    parameters: Type.Object({}),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!state.sessionFolder || !state.sessionName) {
        throw new Error("No session folder. Call create_session_folder first.");
      }

      const sicFiles = await findFiles(state.sessionFolder, ".sic");

      if (sicFiles.length === 0) {
        return {
          content: [{ type: "text", text: "No .sic files found in session folder. The scribe hasn't written contracts yet." }],
          details: { count: 0 },
        };
      }

      const contracts: { path: string; relativePath: string; dependsOn: string[] }[] = [];

      for (const filePath of sicFiles) {
        const content = await readFile(filePath, "utf8");
        const relativePath = relative(state.sessionFolder, filePath);

        // Parse YAML (skip comment header lines)
        const yamlContent = content.split("\n").filter(l => !l.startsWith("#")).join("\n");
        let dependsOn: string[] = [];
        try {
          const parsed = parseYaml(yamlContent);
          if (parsed?.depends_on && Array.isArray(parsed.depends_on)) {
            dependsOn = parsed.depends_on.filter((d: string) => d && d !== "none");
          }
        } catch {
          // Fallback: regex for old format compatibility
          const dependsMatch = content.match(/DEPENDS_ON:\n((?:- .+\n)*)/);
          if (dependsMatch) {
            const lines = dependsMatch[1].split("\n").filter(l => l.startsWith("- "));
            for (const line of lines) {
              const dep = line.replace(/^- /, "").trim();
              if (dep && dep !== "none") dependsOn.push(dep);
            }
          }
        }

        contracts.push({ path: filePath, relativePath, dependsOn });
      }

      const ordered = topologicalSort(contracts);
      const parallelGroups = identifyParallelGroups(ordered);

      let output = `═══ SESSION CONTRACTS ═══\n\n`;
      output += `Session: .pi/sessions/${state.sessionName}/\n`;
      output += `Total contracts: ${ordered.length}\n\n`;
      output += `Execution order:\n`;

      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i];
        const deps = c.dependsOn.length > 0 ? ` (after: ${c.dependsOn.join(", ")})` : "";
        output += `  ${i + 1}. ${c.relativePath}${deps}\n`;
      }

      if (parallelGroups.length > 0) {
        output += `\nParallel groups (independent files that can run together):\n`;
        for (let g = 0; g < parallelGroups.length; g++) {
          output += `  Group ${g + 1}: ${parallelGroups[g].map(c => c.relativePath).join(", ")}\n`;
        }
      }

      output += `\n═══ END LIST ═══`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          count: ordered.length,
          order: ordered.map(c => c.relativePath),
          parallelGroups: parallelGroups.map(g => g.map(c => c.relativePath)),
        },
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

      if (!state.sessionFolder || !state.sessionName) {
        throw new Error("No session folder.");
      }

      const fullPath = resolve(state.sessionFolder, sic_path);

      try {
        const content = await readFile(fullPath, "utf8");
        return {
          content: [{ type: "text", text: content }],
          details: { sicPath: sic_path },
        };
      } catch {
        throw new Error(`Could not read .pi/sessions/${state.sessionName}/${sic_path}`);
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: dispatch_agent (Improvement #10 — Programmatic Retry)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: `Dispatch a single agent and wait for its complete response.

Used by the foreman to execute pipeline phases sequentially. CRITICAL: dispatch ONE agent at a time. Never call multiple times in the same turn.

For the mason: dispatch ONCE PER .sic FILE (or use dispatch_parallel for independent files).

Features:
- Automatic retry on failure (1 retry with error context injected)
- Abort support (Ctrl+X)
- Skip support (F2)
- Progress streaming`,
    promptSnippet: "Dispatch a pipeline agent sequentially",

    parameters: Type.Object({
      agent: Type.String({
        description: "Agent name: scribe, scout, mason, inspector, auditor, or clerk",
      }),
      prompt: Type.String({
        description: "Full prompt including session context, contract content, and previous phase output",
      }),
      retry_context: Type.Optional(Type.String({
        description: "Error context from a previous failed attempt (auto-injected on retry)",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent, prompt, retry_context } = params;
      const validAgents = ["scribe", "scout", "mason", "inspector", "auditor", "clerk"];

      if (!validAgents.includes(agent)) {
        throw new Error(`Invalid agent "${agent}". Valid: ${validAgents.join(", ")}`);
      }

      if (state.pipelineAborted) {
        state.pipelineAborted = false;
        state.pipelineActive = false;
        state.currentAgent = null;
        return {
          content: [{ type: "text", text: "═══ PIPELINE ABORTED ═══\n\nUser requested abort via Ctrl+X." }],
          details: { agent, aborted: true },
        };
      }

      // Build full prompt with context
      let fullPrompt = "";
      if (state.objective) {
        fullPrompt += `═══ SESSION OBJECTIVE ═══\n${state.objective}\n\n`;
      }
      if (state.sessionFolder && state.sessionName) {
        fullPrompt += `═══ SESSION FOLDER ═══\n.pi/sessions/${state.sessionName}/\n\n`;
      }
      if (retry_context) {
        fullPrompt += `═══ RETRY — PREVIOUS ATTEMPT FAILED ═══\n${retry_context}\n\nFix the issues above and try again.\n\n═══ END RETRY CONTEXT ═══\n\n`;
      }
      fullPrompt += prompt;

      // Attempt execution with retry (Improvement #10)
      let lastError: string | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          // Inject error context for retry
          const retryPrompt = `═══ SESSION OBJECTIVE ═══\n${state.objective || ""}\n\n═══ RETRY ATTEMPT ${attempt + 1} ═══\nPrevious attempt failed with:\n${lastError}\n\nFix the issues and try again.\n═══ END RETRY CONTEXT ═══\n\n${prompt}`;
          const result = await runAgent(agent, retryPrompt, signal, onUpdate, ctx);
          if (result.success) {
            state.phaseOutputs[agent] = result.output;
            return {
              content: [{ type: "text", text: `═══ ${agent.toUpperCase()} COMPLETE (retry ${attempt}) ═══\n\n${result.output}\n\n═══ END ${agent.toUpperCase()} ═══` }],
              details: { agent, output: result.output, retried: true, attempt },
            };
          }
          lastError = result.error;
        } else {
          const result = await runAgent(agent, fullPrompt, signal, onUpdate, ctx);
          if (result.success) {
            state.phaseOutputs[agent] = result.output;
            return {
              content: [{ type: "text", text: `═══ ${agent.toUpperCase()} COMPLETE ═══\n\n${result.output}\n\n═══ END ${agent.toUpperCase()} ═══` }],
              details: { agent, output: result.output },
            };
          }
          lastError = result.error;
        }

        // Check if we should retry
        if (attempt < MAX_RETRIES && !state.pipelineAborted) {
          onUpdate?.({
            content: [{ type: "text", text: `[${agent}] Failed, retrying (${attempt + 1}/${MAX_RETRIES})...` }],
            details: { agent, status: "retrying", attempt: attempt + 1 },
          });
        }
      }

      // All retries exhausted
      if (state.pipelineAborted) {
        state.pipelineAborted = false;
        return {
          content: [{ type: "text", text: `═══ ${agent.toUpperCase()} ABORTED ═══\n\nPipeline abort requested.\n\n${lastError?.slice(0, 1000) || ""}` }],
          details: { agent, aborted: true },
        };
      }

      return {
        content: [{ type: "text", text: `═══ ${agent.toUpperCase()} FAILED (after ${MAX_RETRIES + 1} attempts) ═══\n\n${lastError}\n\nThe foreman should report this to the human.` }],
        details: { agent, error: lastError, retries_exhausted: true },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: dispatch_parallel (Improvement #5 — Parallel Mason)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dispatch_parallel",
    label: "Dispatch Agents in Parallel",
    description: `Dispatch multiple INDEPENDENT mason tasks in parallel.

Use this when list_session_sics identifies parallel groups — files that have NO dependencies between them can be implemented simultaneously.

Max concurrency: ${MAX_PARALLEL_MASON} simultaneous agents.

Only use for mason dispatches. All other agents must run sequentially via dispatch_agent.`,
    promptSnippet: "Dispatch independent mason tasks in parallel",

    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        sic_path: Type.String({ description: "Relative path of the .sic file" }),
        prompt: Type.String({ description: "Full prompt for this mason dispatch" }),
      }), {
        description: "Array of independent tasks to run in parallel",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { tasks } = params;

      if (state.pipelineAborted) {
        return {
          content: [{ type: "text", text: "═══ PIPELINE ABORTED ═══" }],
          details: { aborted: true },
        };
      }

      state.pipelineActive = true;
      state.currentAgent = `mason (${tasks.length} parallel)`;

      const results: { sicPath: string; success: boolean; output: string; error?: string }[] = [];

      // Process in batches of MAX_PARALLEL_MASON
      for (let i = 0; i < tasks.length; i += MAX_PARALLEL_MASON) {
        if (state.pipelineAborted) break;

        const batch = tasks.slice(i, i + MAX_PARALLEL_MASON);

        onUpdate?.({
          content: [{ type: "text", text: `[mason] Processing batch ${Math.floor(i / MAX_PARALLEL_MASON) + 1}: ${batch.map(t => t.sic_path).join(", ")}` }],
          details: { status: "parallel", batch: Math.floor(i / MAX_PARALLEL_MASON) + 1 },
        });

        const batchResults = await Promise.all(
          batch.map(async (task) => {
            let fullPrompt = "";
            if (state.objective) fullPrompt += `═══ SESSION OBJECTIVE ═══\n${state.objective}\n\n`;
            fullPrompt += task.prompt;

            const result = await runAgent("mason", fullPrompt, signal, undefined, ctx);
            return {
              sicPath: task.sic_path,
              success: result.success,
              output: result.output,
              error: result.error,
            };
          })
        );

        results.push(...batchResults);
      }

      state.pipelineActive = false;
      state.currentAgent = null;

      const successes = results.filter(r => r.success);
      const failures = results.filter(r => !r.success);

      let output = `═══ PARALLEL MASON COMPLETE ═══\n\n`;
      output += `Total: ${results.length} | Succeeded: ${successes.length} | Failed: ${failures.length}\n\n`;

      for (const r of results) {
        if (r.success) {
          output += `✓ ${r.sicPath}\n${r.output.slice(0, 500)}\n\n`;
        } else {
          output += `✗ ${r.sicPath}\n  Error: ${r.error?.slice(0, 300)}\n\n`;
        }
      }

      output += `═══ END PARALLEL MASON ═══`;

      // Store combined output
      state.phaseOutputs["mason"] = output;

      return {
        content: [{ type: "text", text: output }],
        details: {
          total: results.length,
          successes: successes.length,
          failures: failures.length,
          results: results.map(r => ({ sicPath: r.sicPath, success: r.success })),
          failedPaths: failures.map(r => r.sicPath),
        },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: clean_sessions (Improvement #7 — Session Lifecycle)
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "clean_sessions",
    label: "Clean Old Sessions",
    description: `List and optionally delete old session folders from .pi/sessions/.

Helps manage session folder pollution over time. Can delete by age (days) or interactively select which to remove.`,
    promptSnippet: "Clean old SIC session folders",

    parameters: Type.Object({
      max_age_days: Type.Optional(Type.Number({
        description: "Delete sessions older than this many days. If not set, lists sessions without deleting.",
      })),
      dry_run: Type.Optional(Type.Boolean({
        description: "If true, only show what would be deleted (default: true)",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { max_age_days, dry_run = true } = params;
      const sessionsDir = resolve(ctx.cwd, ".pi", "sessions");

      let entries: string[];
      try {
        entries = await readdir(sessionsDir);
      } catch {
        return {
          content: [{ type: "text", text: "No .pi/sessions/ directory found. Nothing to clean." }],
          details: { count: 0 },
        };
      }

      const sessions: { name: string; created: Date; fileCount: number; path: string }[] = [];

      for (const entry of entries) {
        const entryPath = resolve(sessionsDir, entry);
        try {
          const stats = await stat(entryPath);
          if (!stats.isDirectory()) continue;

          const files = await findFiles(entryPath, ".sic");
          sessions.push({
            name: entry,
            created: stats.birthtime,
            fileCount: files.length,
            path: entryPath,
          });
        } catch {
          continue;
        }
      }

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No sessions found in .pi/sessions/." }],
          details: { count: 0 },
        };
      }

      // Sort oldest first
      sessions.sort((a, b) => a.created.getTime() - b.created.getTime());

      const now = Date.now();
      const msPerDay = 86400000;

      let toDelete: typeof sessions = [];
      if (max_age_days !== undefined) {
        toDelete = sessions.filter(s => (now - s.created.getTime()) > max_age_days * msPerDay);
      }

      let output = `═══ SESSION INVENTORY ═══\n\n`;
      output += `Total sessions: ${sessions.length}\n\n`;

      for (const s of sessions) {
        const age = Math.round((now - s.created.getTime()) / msPerDay);
        const willDelete = toDelete.includes(s);
        const marker = willDelete ? "🗑" : " ";
        output += `${marker} ${s.name} — ${age}d old, ${s.fileCount} contracts\n`;
      }

      if (max_age_days !== undefined) {
        output += `\nSessions older than ${max_age_days} days: ${toDelete.length}\n`;

        if (!dry_run && toDelete.length > 0) {
          for (const s of toDelete) {
            await rm(s.path, { recursive: true, force: true });
          }
          output += `\n✓ Deleted ${toDelete.length} sessions.`;
        } else if (toDelete.length > 0) {
          output += `\n(dry run — call with dry_run: false to actually delete)`;
        }
      }

      output += `\n\n═══ END INVENTORY ═══`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          total: sessions.length,
          toDelete: toDelete.map(s => s.name),
          deleted: !dry_run ? toDelete.length : 0,
        },
      };
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // INTERNAL: Run a single agent subprocess
  // ════════════════════════════════════════════════════════════════════════════

  async function runAgent(
    agent: string,
    prompt: string,
    signal?: AbortSignal,
    onUpdate?: ((update: any) => void),
    ctx?: ExtensionContext,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Write prompt to temp file
    const tmpDir = await mkdtemp(join(tmpdir(), "sic-"));
    const promptFile = join(tmpDir, "prompt.md");
    await writeFile(promptFile, prompt, "utf-8");

    state.pipelineActive = true;
    state.currentAgent = agent;
    state.skipCurrentPhase = false;

    try {
      const cliArgs = [
        "--mode", "json",
        "-p",
        "--no-session",
        "--no-extensions",  // Improvement #3: prevent recursive extension loading
        "--agent", `sic-pipeline/${agent}`,
        promptFile,
      ];

      // Improvement #2: Reliable pi binary discovery
      const invocation = getPiInvocation(cliArgs);

      const result = await new Promise<{ success: boolean; output: string; error?: string }>((resolvePromise, reject) => {
        const proc = spawn(invocation.command, invocation.args, {
          cwd: ctx?.cwd || process.cwd(),
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
              if (event.type === "assistant" && event.message?.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") {
                    output = part.text;
                  }
                }
              }
              if (event.type === "result" && event.result) {
                output = event.result;
              }
            } catch {
              // Non-JSON line, skip
            }
          }

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

        // Process final buffer on close
        proc.on("close", (code: number | null) => {
          // Process remaining buffer
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer);
              if (event.type === "assistant" && event.message?.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") output = part.text;
                }
              }
              if (event.type === "result" && event.result) output = event.result;
            } catch {}
          }

          if (state.skipCurrentPhase) {
            state.skipCurrentPhase = false;
            resolvePromise({
              success: true,
              output: `[SKIPPED by user]\n\nPartial output:\n${output.slice(0, 1000)}`,
            });
          } else if (code === 0) {
            resolvePromise({ success: true, output: output || "(no output)" });
          } else {
            resolvePromise({
              success: false,
              output: output || "",
              error: `Agent ${agent} failed (exit ${code}):\n${stderr.slice(0, 2000)}\n\nPartial output:\n${output.slice(0, 2000)}`,
            });
          }
        });

        proc.on("error", (err: Error) => {
          resolvePromise({
            success: false,
            output: "",
            error: `Failed to spawn agent ${agent}: ${err.message}`,
          });
        });

        // Abort support
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

        // Pipeline abort check
        const abortCheck = setInterval(() => {
          if (state.pipelineAborted) {
            clearInterval(abortCheck);
            proc.kill("SIGTERM");
            setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
          }
        }, 1000);

        proc.on("close", () => clearInterval(abortCheck));
      });

      return result;
    } finally {
      state.pipelineActive = false;
      state.currentAgent = null;

      // Cleanup temp files
      try { await unlink(promptFile); } catch {}
      try { await rmdir(tmpDir); } catch {}
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════════════

  function estimateCostTime(agents: string[], fileCount: number): { timeMin: number; timeMax: number; cost: number } {
    // Rough estimates per agent (seconds)
    const agentTimes: Record<string, [number, number]> = {
      scribe: [15, 40],
      scout: [10, 25],
      mason: [12, 30],
      inspector: [8, 20],
      auditor: [8, 15],
      clerk: [5, 10],
    };

    // Token cost estimates (dollars, assuming Sonnet-class model)
    const agentCosts: Record<string, number> = {
      scribe: 0.015,
      scout: 0.010,
      mason: 0.020,
      inspector: 0.008,
      auditor: 0.010,
      clerk: 0.005,
    };

    let timeMin = 0;
    let timeMax = 0;
    let cost = 0;

    for (const agent of agents) {
      const times = agentTimes[agent] || [10, 20];
      const agentCost = agentCosts[agent] || 0.01;

      if (agent === "mason") {
        // Mason runs once per file
        timeMin += times[0] * fileCount;
        timeMax += times[1] * fileCount;
        cost += agentCost * fileCount;
      } else {
        timeMin += times[0];
        timeMax += times[1];
        cost += agentCost;
      }
    }

    return { timeMin, timeMax, cost: Math.round(cost * 1000) / 1000 };
  }

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

      setTimeout(() => {
        proc.kill("SIGTERM");
        resolvePromise([]);
      }, 10000);
    });
  }

  async function findFiles(dir: string, extension: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await findFiles(fullPath, extension));
        } else if (entry.name.endsWith(extension)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory not readable
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

  // Improvement #5: Identify groups of independent files for parallel execution
  function identifyParallelGroups(
    ordered: { path: string; relativePath: string; dependsOn: string[] }[]
  ): (typeof ordered)[] {
    const groups: (typeof ordered)[] = [];
    const completed = new Set<string>();

    let remaining = [...ordered];

    while (remaining.length > 0) {
      // Find all files whose dependencies are already completed
      const ready = remaining.filter(c =>
        c.dependsOn.every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        // Circular or broken deps — just push remaining as sequential
        for (const c of remaining) {
          groups.push([c]);
          completed.add(c.relativePath);
        }
        break;
      }

      if (ready.length > 1) {
        groups.push(ready);
      } else {
        groups.push(ready);
      }

      for (const c of ready) {
        completed.add(c.relativePath);
      }

      remaining = remaining.filter(c => !completed.has(c.relativePath));
    }

    return groups;
  }
}
