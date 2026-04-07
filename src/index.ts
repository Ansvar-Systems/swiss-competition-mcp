#!/usr/bin/env node

/**
 * Swiss Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying COMCO (Wettbewerbskommission — Swiss
 * Competition Commission) decisions, merger control cases, and sector
 * enforcement activity under Swiss competition law (KG/LCart —
 * Kartellgesetz / Loi sur les cartels).
 *
 * Tool prefix: ch_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { searchDecisions, getDecision, searchMergers, getMerger, listSectors } from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
  pkgVersion = pkg.version;
} catch { /* fallback */ }

const SERVER_NAME = "swiss-competition-mcp";

const TOOLS = [
  {
    name: "ch_comp_search_decisions",
    description: "Full-text search across COMCO (Swiss Competition Commission) enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and KG/LCart articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in German (e.g., 'Marktbeherrschung', 'Preisabrede', 'vertikale Abreden')" },
        type: { type: "string", enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"], description: "Filter by decision type. Optional." },
        sector: { type: "string", description: "Filter by sector ID (e.g., 'telekommunikation', 'energie', 'bau'). Optional." },
        outcome: { type: "string", enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"], description: "Filter by outcome. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_comp_get_decision",
    description: "Get a specific COMCO decision by case number (e.g., 'RPW/DPC 2023/4', 'B-2050/2007').",
    inputSchema: { type: "object" as const, properties: { case_number: { type: "string", description: "COMCO case number (e.g., 'RPW/DPC 2023/4')" } }, required: ["case_number"] },
  },
  {
    name: "ch_comp_search_mergers",
    description: "Search COMCO merger control decisions (Unternehmenszusammenschlüsse). Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in German (e.g., 'Telekommunikation', 'Energieversorgung', 'Detailhandel')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: { type: "string", enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"], description: "Filter by merger outcome. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_comp_get_merger",
    description: "Get a specific merger control decision by case number (e.g., 'RPW/DPC 2022/3 fusion', 'B-3152/2010').",
    inputSchema: { type: "object" as const, properties: { case_number: { type: "string", description: "COMCO merger case number" } }, required: ["case_number"] },
  },
  {
    name: "ch_comp_list_sectors",
    description: "List all sectors with COMCO enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ch_comp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetDecisionArgs = z.object({ case_number: z.string().min(1) });
const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetMergerArgs = z.object({ case_number: z.string().min(1) });

function textContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "ch_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({ query: parsed.query, type: parsed.type, sector: parsed.sector, outcome: parsed.outcome, limit: parsed.limit });
        return textContent({ results, count: results.length });
      }
      case "ch_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) return errorContent(`Decision not found: ${parsed.case_number}`);
        const _citation = buildCitation(
          parsed.case_number,
          (decision as Record<string, unknown>).title as string || parsed.case_number,
          "ch_comp_get_decision",
          { case_number: parsed.case_number },
        );
        return textContent({ ...decision as Record<string, unknown>, _citation });
      }
      case "ch_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({ query: parsed.query, sector: parsed.sector, outcome: parsed.outcome, limit: parsed.limit });
        return textContent({ results, count: results.length });
      }
      case "ch_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) return errorContent(`Merger case not found: ${parsed.case_number}`);
        const _citation = buildCitation(
          parsed.case_number,
          (merger as Record<string, unknown>).title as string || parsed.case_number,
          "ch_comp_get_merger",
          { case_number: parsed.case_number },
        );
        return textContent({ ...merger as Record<string, unknown>, _citation });
      }
      case "ch_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }
      case "ch_comp_about":
        return textContent({
          name: SERVER_NAME, version: pkgVersion,
          description: "COMCO (Wettbewerbskommission — Swiss Competition Commission) MCP server. Provides access to Swiss competition law enforcement decisions, merger control cases, and sector enforcement data under the KG/LCart (Kartellgesetz / Loi sur les cartels).",
          data_source: "COMCO (https://www.weko.admin.ch/)",
          coverage: { decisions: "Abuse of dominance (Marktbeherrschung), cartel enforcement (Preisabreden, vertikale Abreden), sector inquiries", mergers: "Merger control decisions (Unternehmenszusammenschlüsse) — Phase I and Phase II", sectors: "Telekommunikation, Energie, Bau, Detailhandel, Banken, Versicherungen, Gesundheit, Medien" },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorContent(`Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
