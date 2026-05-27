/**
 * SIC Pipeline Extension
 *
 * Powers the foreman's orchestration with:
 * - set_session_objective: Set session objective (displayed in TUI)
 * - create_session_folder: Create .pi/sessions/<name>/ for this run
 * - write_file_sic: Write a per-file .sic contract into the session folder
 * - list_session_sics: List all .sic files in the session folder (with dependency order)
 * - read_file_sic: Read a specific .sic contract from the session folder
 * - dispatch_agent: Sequential agent dispatch (one at a time)
 */
import type { ExtensionAPI } from "@anthropic-ai/claude-code";
import { Type } from "@sinclair/typebox";
import { resolve, dirname, relative, join } from "node:path";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
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
      // Sanitize
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

      // Convert target file path to .sic path
      // e.g., "libs/front/tools/helpers.ts" → "libs/front/tools/helpers.sic"
      const sicPath = target_file.replace(/\.[^.]+$/, ".sic");
      const fullPath = resolve(sessionFolder, sicPath);

      // Create parent directories
      await mkdir(dirname(fullPath), { recursive: true });

      // Add metadata header
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

Returns them in dependency order (based on DEPENDS_ON fields). Files with no dependencies come first, files that depend on others come after their dependencies.

Use this to know which contracts exist and in what order the mason should process them.`,

    parameters: Type.Object({}),

    async execute() {
      if (!sessionFolder || !sessionName) {
        return "ERROR: No session folder. Call create_session_folder first.";
      }

      // Recursively find all .sic files
      const sicFiles = await findFiles(sessionFolder, ".sic");

      if (sicFiles.length === 0) {
        return "No .sic files found in session folder. The scribe hasn't written contracts yet.";
      }

      // Read each file and parse DEPENDS_ON for ordering
      const contracts: { path: string; relativePath: string; dependsOn: string[] }[] = [];

      for (const filePath of sicFiles) {
        const content = await readFile(filePath, "utf8");
        const relativePath = relative(sessionFolder, filePath);

        // Parse DEPENDS_ON field
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

      // Topological sort by DEPENDS_ON
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
    description: `Read a specific .sic contract from the session folder.

Use this to get the full contract content before dispatching the mason for a specific file.`,

    parameters: Type.Object({
      sic_path: Type.String({
        description: "Relative path of the .sic file within the session folder (e.g., 'libs/front/tools/helpers.sic')",
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

For the mason: dispatch ONCE PER .sic FILE — not all files at once.`,

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

      // Build context preamble
      let fullPrompt = "";
      if (sessionObjective) {
        fullPrompt += `═══ SESSION OBJECTIVE ═══\n${sessionObjective}\n\n`;
      }
      if (sessionFolder && sessionName) {
        fullPrompt += `═══ SESSION FOLDER ═══\n.pi/sessions/${sessionName}/\n\n`;
      }
      fullPrompt += prompt;

      try {
        // Escape for shell
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
        // Circular dependency — just add it
        sorted.push(contract);
        visited.add(contract.relativePath);
        return;
      }

      visiting.add(contract.relativePath);

      // Visit dependencies first
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
