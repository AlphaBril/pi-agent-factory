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
 * - dispatch_agent: Sequential agent dispatch (one at a time)
 */
import type { ExtensionAPI } from "@anthropic-ai/claude-code";
import { Type } from "@sinclair/typebox";
import { resolve, dirname, relative, join } from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";

export default function sicPipeline(pi: ExtensionAPI) {
  // ════════════════════════════════════════════════════════════════════════════
  // SHARED STATE
  // ════════════════════════════════════════════════════════════════════════════

  let sessionObjective: string | null = null;
  let sessionFolder: string | null = null;
  let sessionName: string | null = null;
  let phaseOutputs: Record<string, string> = {};

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: set_session_objective
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "set_session_objective",
    description: `Set the session objective — the human's answer to "What are we doing today?"

This becomes the guiding context for all agents in the pipeline. Call this ONCE at the start after the human answers the foreman's opening question.`,

    parameters: Type.Object({
      objective: Type.String({
        description: "The session objective — what we're building today",
      }),
    }),

    async execute({ objective }) {
      sessionObjective = objective;
      return `═══ SESSION OBJECTIVE SET ═══\n\n🎯 ${objective}\n\nThis objective is now visible to all agents in the pipeline.`;
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: create_session_folder
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "create_session_folder",
    description: `Create the session folder at .pi/sessions/<session-name>/.

This folder holds all per-file .sic contracts for this implementation run. The scribe writes into it, the mason reads from it. The folder structure mirrors the repo structure.

Call this ONCE after setting the session objective.`,

    parameters: Type.Object({
      name: Type.String({
        description: "Session name slug (lowercase, hyphens, no spaces). E.g., 'add-sum-to-helpers'",
      }),
    }),

    async execute({ name }) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      const folderPath = resolve(process.cwd(), ".pi", "sessions", slug);
      await mkdir(folderPath, { recursive: true });

      sessionFolder = folderPath;
      sessionName = slug;

      return `═══ SESSION FOLDER CREATED ═══\n\nPath: .pi/sessions/${slug}/\n\nThe scribe will write per-file .sic contracts here, mirroring the repo structure.`;
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: resolve_paths
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "resolve_paths",
    description: `Search for files matching a vague or partial name. If multiple matches are found, shows an interactive selector overlay where the user picks the correct file using arrow keys.

Use this when the user mentions a file by partial name (e.g., "helpers.ts", "the controller", "auth middleware") and you need to resolve it to an exact path.

Returns the user's selected path, or the single match if unambiguous.`,

    parameters: Type.Object({
      query: Type.String({
        description: "The file name or pattern to search for (e.g., 'helpers.ts', '*auth*controller*')",
      }),
      label: Type.Optional(Type.String({
        description: "Optional label shown in the selector (e.g., 'Which helpers file?'). Defaults to the query.",
      })),
    }),

    async execute({ query, label }, { abortSignal, context }) {
      // Search for matching files, excluding node_modules, .git, dist, build
      const pattern = query.includes("*") ? query : `*${query}*`;
      let findCmd = `find . -type f -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.pi/sessions/*" | sort`;

      let output: string;
      try {
        output = execSync(findCmd, { encoding: "utf8", cwd: process.cwd(), timeout: 10000 }).trim();
      } catch {
        return `No files found matching "${query}"`;
      }

      if (!output) {
        // Try broader search without the glob wrapper
        try {
          findCmd = `find . -type f -name "${query}" -not -path "*/node_modules/*" -not -path "*/.git/*" | sort`;
          output = execSync(findCmd, { encoding: "utf8", cwd: process.cwd(), timeout: 10000 }).trim();
        } catch {
          return `No files found matching "${query}"`;
        }
      }

      if (!output) {
        return `No files found matching "${query}". Ask the user for a more specific path.`;
      }

      const matches = output.split("\n").filter(Boolean).map(p => p.replace(/^\.\//, ""));

      // Single match — return it directly
      if (matches.length === 1) {
        return `✓ Resolved: ${matches[0]}`;
      }

      // Multiple matches — show interactive SelectList overlay
      const { SelectList, Container, Text } = await import("@mariozechner/pi-tui");
      const { DynamicBorder } = await import("@mariozechner/pi-coding-agent");

      const items = matches.map((path, i) => ({
        value: path,
        label: path,
        description: dirname(path),
      }));

      const title = label || `Which file for "${query}"?`;

      const selected: string | null = await new Promise((resolvePromise) => {
        context.ui.custom((tui: any, theme: any, _kb: any, done: (val: any) => void) => {
          const container = new Container();

          // Top border
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          // Title
          container.addChild(new Text(
            theme.fg("accent", theme.bold(` 📂 ${title}`)),
            1, 0
          ));
          container.addChild(new Text(
            theme.fg("dim", `  ${matches.length} matches found`),
            1, 0
          ));

          // SelectList
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

          selectList.onSelect = (item: any) => {
            done(item.value);
            resolvePromise(item.value);
          };
          selectList.onCancel = () => {
            done(null);
            resolvePromise(null);
          };

          container.addChild(selectList);

          // Help text
          container.addChild(new Text(
            theme.fg("dim", "  ↑↓ navigate • enter select • esc cancel"),
            1, 0
          ));

          // Bottom border
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        }, { overlay: true });
      });

      if (selected) {
        return `✓ User selected: ${selected}`;
      } else {
        return `✗ User cancelled selection for "${query}". Ask for clarification.`;
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: write_file_sic
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "write_file_sic",
    description: `Write a per-file .sic contract into the session folder.

The .sic file mirrors the target file's path within the session folder, but with a .sic extension.

Example: If the target file is "libs/front/tools/helpers.ts", the .sic is written to:
  .pi/sessions/<session>/libs/front/tools/helpers.sic

Each .sic describes modifications to EXACTLY ONE file. The mason reads them one at a time.`,

    parameters: Type.Object({
      target_file: Type.String({
        description: "Relative path of the target file in the repo (e.g., 'libs/front/tools/helpers.ts')",
      }),
      contract: Type.String({
        description: "The full .sic contract content for this file",
      }),
    }),

    async execute({ target_file, contract }) {
      if (!sessionFolder || !sessionName) {
        return "ERROR: No session folder created. Call create_session_folder first.";
      }

      const sicPath = target_file.replace(/\.[^.]+$/, ".sic");
      const fullPath = resolve(sessionFolder, sicPath);

      await mkdir(dirname(fullPath), { recursive: true });

      const timestamp = new Date().toISOString();
      const header = `# SIC for: ${target_file}\n# Session: ${sessionName}\n# Created: ${timestamp}\n# Objective: ${sessionObjective || "not set"}\n\n`;
      const content = header + contract + "\n";

      await writeFile(fullPath, content, "utf8");

      const relativeSicPath = `.pi/sessions/${sessionName}/${sicPath}`;
      return `✓ Contract written: ${relativeSicPath}`;
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: list_session_sics
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "list_session_sics",
    description: `List all .sic files in the current session folder.

Returns them in dependency order (based on DEPENDS_ON fields). Files with no dependencies come first.

Use this to know which contracts exist and in what order the mason should process them.`,

    parameters: Type.Object({}),

    async execute() {
      if (!sessionFolder || !sessionName) {
        return "ERROR: No session folder. Call create_session_folder first.";
      }

      const sicFiles = await findFiles(sessionFolder, ".sic");

      if (sicFiles.length === 0) {
        return "No .sic files found in session folder. The scribe hasn't written contracts yet.";
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
      return output;
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: read_file_sic
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "read_file_sic",
    description: `Read a specific .sic contract from the session folder.`,

    parameters: Type.Object({
      sic_path: Type.String({
        description: "Relative path of the .sic file within the session folder",
      }),
    }),

    async execute({ sic_path }) {
      if (!sessionFolder || !sessionName) {
        return "ERROR: No session folder.";
      }

      const fullPath = resolve(sessionFolder, sic_path);

      try {
        const content = await readFile(fullPath, "utf8");
        return content;
      } catch {
        return `ERROR: Could not read .pi/sessions/${sessionName}/${sic_path}`;
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TOOL: dispatch_agent
  // ════════════════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "dispatch_agent",
    description: `Dispatch a single agent and wait for its complete response.

Used by the foreman to execute pipeline phases sequentially. CRITICAL: dispatch ONE agent at a time. Never call multiple times in the same turn.

For the mason: dispatch ONCE PER .sic FILE.`,

    parameters: Type.Object({
      agent: Type.String({
        description: "Agent name: scribe, scout, mason, inspector, auditor, or clerk",
      }),
      prompt: Type.String({
        description: "Full prompt including session context, contract content, and previous phase output",
      }),
    }),

    async execute({ agent, prompt }) {
      const validAgents = ["scribe", "scout", "mason", "inspector", "auditor", "clerk"];
      if (!validAgents.includes(agent)) {
        return `ERROR: Invalid agent "${agent}". Valid: ${validAgents.join(", ")}`;
      }

      let fullPrompt = "";
      if (sessionObjective) {
        fullPrompt += `═══ SESSION OBJECTIVE ═══\n${sessionObjective}\n\n`;
      }
      if (sessionFolder && sessionName) {
        fullPrompt += `═══ SESSION FOLDER ═══\n.pi/sessions/${sessionName}/\n\n`;
      }
      fullPrompt += prompt;

      try {
        const escapedPrompt = fullPrompt
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\$/g, "\\$")
          .replace(/`/g, "\\`");

        const result = execSync(
          `pi --agent sic-pipeline/${agent} -p "${escapedPrompt}"`,
          {
            encoding: "utf8",
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 10,
            cwd: process.cwd(),
            env: { ...process.env },
          }
        );

        phaseOutputs[agent] = result;
        return `═══ ${agent.toUpperCase()} COMPLETE ═══\n\n${result}\n\n═══ END ${agent.toUpperCase()} ═══`;
      } catch (error: any) {
        const output = error.stdout || "";
        const stderr = error.stderr || "";

        if (error.killed) {
          return `═══ ${agent.toUpperCase()} TIMEOUT ═══\n\nAgent timed out (5min).\n\nPartial:\n${output.slice(0, 3000)}`;
        }

        return `═══ ${agent.toUpperCase()} ERROR ═══\n\nExit code: ${error.status}\n\nOutput:\n${output.slice(0, 3000)}\n\nStderr:\n${stderr.slice(0, 1000)}`;
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════════════

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
