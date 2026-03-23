/**
 * Ingestion crawler for the WEKO/COMCO (Wettbewerbskommission) MCP server.
 *
 * Scrapes competition decisions, merger control decisions, and sector data
 * from weko.admin.ch and populates the SQLite database.
 *
 * Data sources:
 *   - Decision listing page (/de/entscheide) for URL + metadata discovery
 *   - French decision listing page (/fr/decisions) for additional coverage
 *   - Individual decision PDFs (title/date extracted from listing metadata)
 *   - RPW editions (/de/recht-und-politik-des-wettbewerbs-rpw) as future expansion
 *
 * The crawler extracts structured data from the listing page itself (title,
 * date, decision type, PDF URL) and downloads PDFs only for full_text
 * extraction. Most WEKO decisions are published as PDF-only (no HTML detail
 * page), so the listing page metadata plus PDF filename parsing is the
 * primary data extraction path.
 *
 * Usage:
 *   npx tsx scripts/ingest-weko.ts
 *   npx tsx scripts/ingest-weko.ts --dry-run
 *   npx tsx scripts/ingest-weko.ts --resume
 *   npx tsx scripts/ingest-weko.ts --force
 *   npx tsx scripts/ingest-weko.ts --max-items 20
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["COMCO_DB_PATH"] ?? "data/comco.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://www.weko.admin.ch";
const DECISIONS_DE = `${BASE_URL}/de/entscheide`;
const DECISIONS_FR = `${BASE_URL}/fr/decisions`;
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarWEKOCrawler/1.0 (+https://github.com/Ansvar-Systems/swiss-competition-mcp)";

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxItemsArg = process.argv.find((_, i, a) => a[i - 1] === "--max-items");
const maxItems = maxItemsArg ? parseInt(maxItemsArg, 10) : Infinity;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  decisionsIngested: number;
  mergersIngested: number;
  errors: string[];
}

interface ListingEntry {
  title: string;
  pdfUrl: string;
  publicationDate: string | null;
  fileSize: string | null;
  language: "de" | "fr";
}

interface ParsedDecision {
  case_number: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  gwb_articles: string | null;
  status: string;
}

interface ParsedMerger {
  case_number: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiring_party: string | null;
  target: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  turnover: number | null;
}

interface SectorAccumulator {
  [id: string]: {
    name: string;
    name_en: string | null;
    description: string | null;
    decisionCount: number;
    mergerCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-CH,de;q=0.9,fr-CH;q=0.8,fr;q=0.7,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "follow",
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

/**
 * Fetch raw bytes (for PDF downloads). Returns a Buffer or null on failure.
 */
async function rateLimitedFetchBuffer(url: string): Promise<Buffer | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/pdf,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(60_000),
        redirect: "follow",
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for PDF ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for PDF ${url}`);
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] PDF fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    decisionsIngested: 0,
    mergersIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Listing page parsing — discover decision entries from the HTML listing
// ---------------------------------------------------------------------------

/**
 * Parse the WEKO decisions listing page (/de/entscheide or /fr/decisions).
 *
 * The page uses a manual-download-list layout where each decision is a
 * download item with:
 *   - Title (in an <a> tag linking to the PDF)
 *   - Publication date and file size in metadata spans
 *   - Direct PDF download URL
 *
 * The page loads all entries at once (no pagination), though some content
 * may be JavaScript-rendered. We parse whatever the server returns.
 */
function parseListingPage(
  html: string,
  language: "de" | "fr",
): ListingEntry[] {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Strategy 1: Look for download list items with PDF links
  // The page uses <a> tags with href pointing to /dam/ PDF URLs
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();

    // Only process links to WEKO DAM PDF files
    if (!href.includes("/dam/") || !href.toLowerCase().endsWith(".pdf")) {
      return;
    }

    // Skip navigation/header/footer links with very short text
    if (!text || text.length < 10) return;

    // Build the full URL
    const pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    // Try to extract date and file size from surrounding metadata
    const parent = $(el).closest(
      ".download-item, .manual-download-list, .properties, li, div",
    );
    const metaText = parent.find(".metainfos, .date, .size, .meta").text();

    // Extract publication date from metadata or title
    const dateStr = extractDateFromText(metaText) ?? extractDateFromTitle(text);

    // Extract file size
    const sizeMatch = metaText.match(
      /([\d.,]+)\s*(MB|KB|GB|kB)/i,
    );
    const fileSize = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2]}` : null;

    entries.push({
      title: text,
      pdfUrl,
      publicationDate: dateStr,
      fileSize,
      language,
    });
  });

  // Deduplicate by PDF URL (same document may appear multiple times)
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    // Normalize URL for dedup (ignore /de/ vs /fr/ path difference)
    const key = e.pdfUrl.replace(/\/dam\/(de|fr)\//, "/dam/x/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique;
}

// ---------------------------------------------------------------------------
// Date parsing — German and French date formats
// ---------------------------------------------------------------------------

const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  "m\u00e4rz": "03",
  maerz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

const FRENCH_MONTHS: Record<string, string> = {
  janvier: "01",
  "f\u00e9vrier": "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  "ao\u00fbt": "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  "d\u00e9cembre": "12",
  decembre: "12",
};

const ALL_MONTHS: Record<string, string> = {
  ...GERMAN_MONTHS,
  ...FRENCH_MONTHS,
};

/**
 * Parse a German or French date string to ISO format (YYYY-MM-DD).
 * Handles:
 *   - "25. März 2025" / "25. Maerz 2025"
 *   - "25 août 2025"
 *   - "18.12.2025" / "18. Dezember 2025"
 *   - "2025-03-25" (already ISO)
 */
function parseSwissDate(raw: string): string | null {
  if (!raw) return null;

  const cleaned = raw.trim();

  // Already ISO: YYYY-MM-DD
  const isoMatch = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  // Dot-separated: DD.MM.YYYY
  const dotMatch = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Text format: "DD. Month YYYY" or "DD Month YYYY" (German/French)
  const textMatch = cleaned.match(/(\d{1,2})\.?\s+(\S+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthName, year] = textMatch;
    const monthNum = ALL_MONTHS[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  return null;
}

/** Extract a date from free text (metadata spans, etc.). */
function extractDateFromText(text: string): string | null {
  if (!text) return null;

  // Try "DD. Monat YYYY" / "DD Monat YYYY"
  const textMatch = text.match(/(\d{1,2})\.?\s+([\wäöüéèê]+)\s+(\d{4})/i);
  if (textMatch) {
    return parseSwissDate(textMatch[0]);
  }

  // Try DD.MM.YYYY
  const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    return parseSwissDate(dotMatch[0]);
  }

  return null;
}

/**
 * Extract the decision date from the title itself.
 *
 * WEKO titles often include the date:
 *   "Baustoffe und Deponien Bern: Verfügung vom 21. Mai 2024"
 *   "Enduits superficiels et gravillonnage : Décision du 25 août 2025"
 *   "Schlussbericht vom 25. März 2025"
 */
function extractDateFromTitle(title: string): string | null {
  if (!title) return null;

  // German: "vom DD. Monat YYYY"
  const deMatch = title.match(
    /vom\s+(\d{1,2})\.?\s+([\wäöüÄÖÜ]+)\s+(\d{4})/i,
  );
  if (deMatch) {
    return parseSwissDate(`${deMatch[1]}. ${deMatch[2]} ${deMatch[3]}`);
  }

  // French: "du DD mois YYYY"
  const frMatch = title.match(
    /du\s+(\d{1,2})\.?\s+([\wéèêûô]+)\s+(\d{4})/i,
  );
  if (frMatch) {
    return parseSwissDate(`${frMatch[1]}. ${frMatch[2]} ${frMatch[3]}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Decision/merger classification from title and metadata
// ---------------------------------------------------------------------------

/**
 * WEKO decision type keywords (German and French).
 *
 * Title patterns:
 *   - "Verfügung" / "Décision" = formal decision
 *   - "Schlussbericht" / "Rapport final" = final report (sector inquiry)
 *   - "Stellungnahme" / "Prise de position" = merger opinion
 *   - "Zusammenschlussvorhaben" / "Projet de concentration" = merger
 *   - "Sanktion" / "Busse" / "Amende" = fine/sanction
 *   - "Submissionsabsprache" / "Soumissions truquées" = bid rigging
 *   - "Preisabsprache" / "Fixation des prix" = price fixing
 *   - "Marktbeherrschung" / "Position dominante" = abuse of dominance
 *   - "Untersuchung" / "Enquête" = investigation
 */
function classifyEntry(
  title: string,
  _pdfUrl: string,
): {
  isMerger: boolean;
  type: string | null;
  outcome: string | null;
  status: string;
} {
  const t = title.toLowerCase();

  // --- Merger classification ---
  const isMerger =
    t.includes("zusammenschlussvorhaben") ||
    t.includes("zusammenschluss") ||
    t.includes("fusionskontrolle") ||
    t.includes("fusion") ||
    t.includes("projet de concentration") ||
    t.includes("concentration") ||
    (t.includes("stellungnahme") && !t.includes("vernehmlassung"));

  // --- Decision type ---
  let type: string | null = null;

  if (
    t.includes("submissionsabsprache") ||
    t.includes("preisabsprache") ||
    t.includes("kartell") ||
    t.includes("absprache") ||
    t.includes("soumissions truqu") ||
    t.includes("fixation des prix") ||
    t.includes("entente") ||
    t.includes("bid rigging")
  ) {
    type = "cartel";
  } else if (
    t.includes("marktbeherrsch") ||
    t.includes("missbrauch") ||
    t.includes("missbräuchlich") ||
    t.includes("position dominante") ||
    t.includes("abus de position")
  ) {
    type = "abuse_of_dominance";
  } else if (
    t.includes("schlussbericht") ||
    t.includes("sektoruntersuchung") ||
    t.includes("rapport final") ||
    t.includes("enquête sectorielle") ||
    t.includes("marktbeobachtung")
  ) {
    type = "sector_inquiry";
  } else if (
    t.includes("vernehmlassung") ||
    t.includes("consultation") ||
    t.includes("empfehlung") ||
    t.includes("recommandation")
  ) {
    type = "recommendation";
  } else if (isMerger) {
    type = "merger_control";
  } else if (t.includes("verfügung") || t.includes("décision")) {
    type = "decision";
  } else if (
    t.includes("anregung") ||
    t.includes("beratung") ||
    t.includes("avis")
  ) {
    type = "advisory";
  }

  // --- Outcome ---
  let outcome: string | null = null;

  if (
    t.includes("sanktion") ||
    t.includes("busse") ||
    t.includes("amende") ||
    t.includes("bestraft")
  ) {
    outcome = "fine";
  } else if (
    t.includes("genehmig") ||
    t.includes("freigabe") ||
    t.includes("autoris") ||
    t.includes("approuv")
  ) {
    outcome = isMerger ? "cleared_phase1" : "cleared";
  } else if (
    t.includes("auflagen") ||
    t.includes("bedingungen") ||
    t.includes("conditions") ||
    t.includes("verpflichtung")
  ) {
    outcome = "cleared_with_conditions";
  } else if (
    t.includes("untersag") ||
    t.includes("verboten") ||
    t.includes("interdi")
  ) {
    outcome = "blocked";
  } else if (
    t.includes("einstellung") ||
    t.includes("eingestellt") ||
    t.includes("classement")
  ) {
    outcome = "cleared";
  } else if (
    t.includes("stellungnahme") ||
    t.includes("prise de position")
  ) {
    outcome = isMerger ? "cleared_phase1" : "cleared";
  }

  // --- Status ---
  let status = "final";
  if (
    t.includes("eröffnung") ||
    t.includes("ouverture") ||
    t.includes("vorabklärung") ||
    t.includes("examen préalable")
  ) {
    status = "pending";
  }

  return { isMerger, type, outcome, status };
}

// ---------------------------------------------------------------------------
// Sector classification
// ---------------------------------------------------------------------------

const SECTOR_MAPPING: Array<{
  id: string;
  name: string;
  name_en: string;
  patterns: string[];
}> = [
  {
    id: "bau",
    name: "Bauwirtschaft",
    name_en: "Construction",
    patterns: [
      "bau",
      "hochbau",
      "tiefbau",
      "deponien",
      "baustoffe",
      "strassen",
      "belag",
      "asphalt",
      "kies",
      "submission",
      "construction",
      "enduits",
      "gravillonnage",
      "travaux",
      "génie civil",
      "brandschutz",
    ],
  },
  {
    id: "telekommunikation",
    name: "Telekommunikation",
    name_en: "Telecommunications",
    patterns: [
      "swisscom",
      "telecom",
      "telekommunikation",
      "breitband",
      "mobilfunk",
      "wan-anbindung",
      "netzbaustrategie",
      "glasfaser",
      "fibre",
      "sunrise",
      "salt",
      "télécommunication",
    ],
  },
  {
    id: "detailhandel",
    name: "Detailhandel",
    name_en: "Retail",
    patterns: [
      "detailhandel",
      "migros",
      "coop",
      "denner",
      "aldi",
      "lidl",
      "supermarkt",
      "lebensmittel",
      "commerce de détail",
    ],
  },
  {
    id: "energie",
    name: "Energie",
    name_en: "Energy",
    patterns: [
      "energie",
      "strom",
      "gas",
      "axpo",
      "alpiq",
      "bkw",
      "repower",
      "elektrizität",
      "énergie",
      "électricité",
    ],
  },
  {
    id: "gesundheitswesen",
    name: "Gesundheitswesen",
    name_en: "Healthcare",
    patterns: [
      "gesundheit",
      "pharma",
      "spital",
      "hospital",
      "roche",
      "novartis",
      "medikament",
      "arzneimittel",
      "santé",
      "médicament",
      "hôpital",
      "fresenius",
      "kabi",
    ],
  },
  {
    id: "finanzdienstleistungen",
    name: "Finanzdienstleistungen",
    name_en: "Financial Services",
    patterns: [
      "bank",
      "versicherung",
      "interchange",
      "debitkart",
      "kreditkart",
      "mastercard",
      "visa",
      "ubs",
      "credit suisse",
      "finanz",
      "leasing",
      "assurance",
      "banque",
      "baloise",
      "helvetia",
    ],
  },
  {
    id: "verkehr",
    name: "Verkehr und Transport",
    name_en: "Transport",
    patterns: [
      "transport",
      "verkehr",
      "sbb",
      "post",
      "quickmail",
      "luft",
      "schiff",
      "bahn",
      "öv",
      "nova",
      "marchandises",
      "déchets",
    ],
  },
  {
    id: "automobil",
    name: "Automobilindustrie",
    name_en: "Automotive",
    patterns: [
      "bmw",
      "automobil",
      "fahrzeug",
      "auto",
      "ford",
      "mercedes",
      "volkswagen",
      "automobile",
      "voiture",
    ],
  },
  {
    id: "medien",
    name: "Medien und Verlag",
    name_en: "Media & Publishing",
    patterns: [
      "medien",
      "verlag",
      "verzeichnis",
      "buch",
      "presse",
      "madrigall",
      "média",
      "édition",
    ],
  },
  {
    id: "landwirtschaft",
    name: "Landwirtschaft",
    name_en: "Agriculture",
    patterns: [
      "landwirtschaft",
      "agrar",
      "milch",
      "fleisch",
      "agriculture",
      "lait",
      "viande",
    ],
  },
  {
    id: "immobilien",
    name: "Immobilien",
    name_en: "Real Estate",
    patterns: [
      "immobili",
      "wohnbau",
      "grundstück",
      "immobilier",
      "logement",
    ],
  },
  {
    id: "geistiges_eigentum",
    name: "Geistiges Eigentum",
    name_en: "Intellectual Property",
    patterns: [
      "patent",
      "lizenz",
      "urheberrecht",
      "blocking patent",
      "brevet",
      "licence",
    ],
  },
];

function classifySector(title: string): string | null {
  const t = title.toLowerCase();

  for (const { id, patterns } of SECTOR_MAPPING) {
    for (const p of patterns) {
      if (t.includes(p)) return id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Party extraction
// ---------------------------------------------------------------------------

/**
 * Extract party names from a WEKO decision title.
 *
 * Common patterns:
 *   "Swisscom WAN-Anbindung II: Verfügung" -> parties: "Swisscom"
 *   "BMW (Schweiz) AG: Verfügung" -> parties: "BMW (Schweiz) AG"
 *   "Zusammenschlussvorhaben Baloise / Helvetia" -> acquiring: "Baloise", target: "Helvetia"
 *   "Zusammenschlussvorhaben UBS / CS" -> acquiring: "UBS", target: "CS"
 */
function extractParties(
  title: string,
): { parties: string | null; acquiring: string | null; target: string | null } {
  // Merger: "Zusammenschlussvorhaben X / Y: ..."
  const mergerMatch = title.match(
    /(?:Zusammenschlussvorhaben|Projet de concentration)\s+(.+?)\s*[/]\s*(.+?)(?:\s*[:]\s*|\s*$)/i,
  );
  if (mergerMatch) {
    return {
      parties: null,
      acquiring: mergerMatch[1]!.trim(),
      target: mergerMatch[2]!.trim().replace(/\s*:.*$/, ""),
    };
  }

  // Non-merger: "Company Name: Verfügung vom ..."
  const partyMatch = title.match(
    /^(.+?)\s*[:]\s*(?:Verfügung|Décision|Schlussbericht|Rapport)/i,
  );
  if (partyMatch) {
    const raw = partyMatch[1]!.trim();
    // Skip generic titles that are not party names
    if (
      raw.length > 3 &&
      !raw.toLowerCase().startsWith("verwendung") &&
      !raw.toLowerCase().startsWith("interchange") &&
      !raw.toLowerCase().startsWith("debitkarten") &&
      !raw.toLowerCase().startsWith("cross-border") &&
      !raw.toLowerCase().startsWith("vernehmlassung") &&
      !raw.toLowerCase().startsWith("selbstregulierung") &&
      !raw.toLowerCase().startsWith("lohnabsprache")
    ) {
      return { parties: raw, acquiring: null, target: null };
    }
  }

  return { parties: null, acquiring: null, target: null };
}

// ---------------------------------------------------------------------------
// Fine amount extraction
// ---------------------------------------------------------------------------

/**
 * Extract fine/sanction amount from text. Handles Swiss number formatting.
 * Looks for CHF amounts and converts "Millionen"/"millions" multipliers.
 */
function extractFineAmount(text: string): number | null {
  const patterns = [
    // "CHF 24,6 Millionen" / "CHF 24.6 Millionen"
    /([\d.,]+)\s*(?:Millionen|millions?)\s*(?:CHF|Franken|francs)/gi,
    /(?:CHF|Franken|francs)\s*([\d.,]+)\s*(?:Millionen|millions?)/gi,
    // "CHF 1'234'567" (Swiss apostrophe thousands separator)
    /(?:CHF|Franken|francs)\s*([\d'.,]+)/gi,
    // "Busse von CHF ..."
    /(?:Busse|Sanktion|amende|sanction)\s+(?:von\s+)?(?:CHF|Franken|francs)\s*([\d'.,]+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let numStr = match[1];

      // Handle "Millionen" / "millions" multiplier
      if (pattern.source.includes("illion")) {
        numStr = numStr.replace(/'/g, "").replace(/\./g, "").replace(",", ".");
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) return val * 1_000_000;
      }

      // Direct amount: Swiss uses apostrophe as thousands separator
      numStr = numStr.replace(/'/g, "").replace(/\./g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Legal article extraction
// ---------------------------------------------------------------------------

/**
 * Extract cited Swiss competition law (KG/LCart) and EU treaty articles.
 */
function extractLegalArticles(text: string): string[] {
  const articles: Set<string> = new Set();

  // Swiss Kartellgesetz (KG) articles
  // "Art. 5 Abs. 3 KG" / "Art. 7 KG" / "Art. 49a KG"
  const kgPattern =
    /Art(?:ikel)?\.?\s*(\d+[a-z]?)(?:\s*Abs\.?\s*(\d+))?\s*(?:(?:i\.?\s*V\.?\s*m\.?\s*Art\.?\s*(\d+[a-z]?)(?:\s*Abs\.?\s*(\d+))?\s*)?)?KG\b/gi;
  let m: RegExpExecArray | null;
  while ((m = kgPattern.exec(text)) !== null) {
    let article = `Art. ${m[1]} KG`;
    if (m[2]) article = `Art. ${m[1]} Abs. ${m[2]} KG`;
    if (m[3]) {
      let linked = `Art. ${m[3]} KG`;
      if (m[4]) linked = `Art. ${m[3]} Abs. ${m[4]} KG`;
      article = `Art. ${m[1]}${m[2] ? ` Abs. ${m[2]}` : ""} i.V.m. ${linked}`;
    }
    articles.add(article);
  }

  // French: LCart articles
  const lcartPattern =
    /Art(?:icle)?\.?\s*(\d+[a-z]?)(?:\s*al\.?\s*(\d+))?\s*LCart\b/gi;
  while ((m = lcartPattern.exec(text)) !== null) {
    let article = `Art. ${m[1]} KG`;
    if (m[2]) article = `Art. ${m[1]} Abs. ${m[2]} KG`;
    articles.add(article);
  }

  // EU Treaty: Art. 101/102 AEUV/TFEU
  const euPattern =
    /Art(?:ikel)?\.?\s*(101|102)\s*(?:AEUV|TFEU|AEU-Vertrag|TFUE)/gi;
  while ((m = euPattern.exec(text)) !== null) {
    articles.add(`Art. ${m[1]} AEUV`);
  }

  return [...articles];
}

// ---------------------------------------------------------------------------
// Case number generation
// ---------------------------------------------------------------------------

/**
 * Generate a case number from the title and PDF URL.
 *
 * WEKO uses "RPW/DPC YYYY/N" format in the RPW publications.
 * For decisions from the listing page, we derive a case number from
 * the PDF filename and any embedded date.
 */
function generateCaseNumber(title: string, pdfUrl: string, date: string | null): string {
  // Try to extract RPW/DPC reference from title
  const rpwMatch = title.match(/RPW\/DPC\s+(\d{4}\/\d+)/i);
  if (rpwMatch) return `RPW/DPC ${rpwMatch[1]}`;

  // Try to extract from the PDF filename
  const filename = decodeURIComponent(pdfUrl.split("/").pop() ?? "");

  // Generate from title + date: "WEKO-YYYY-slug"
  const year = date?.slice(0, 4) ?? "XXXX";

  // Create a slug from the first meaningful part of the title
  const slug = title
    .replace(/[:]\s*(Verfügung|Décision|Schlussbericht|Rapport|Stellungnahme).*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9äöüéèêàâ]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");

  return `WEKO-${year}/${slug}`;
}

// ---------------------------------------------------------------------------
// PDF text extraction (basic — extracts readable text streams from PDF)
// ---------------------------------------------------------------------------

/**
 * Extract readable text from a PDF buffer.
 *
 * This is a lightweight extractor that reads text streams from the PDF
 * without a full PDF parsing library. It handles most WEKO decisions
 * which are text-based PDFs (not scanned images).
 *
 * For production use, consider adding pdf-parse or pdfjs-dist as a
 * dependency for more reliable extraction.
 */
function extractTextFromPdf(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const textChunks: string[] = [];

  // Extract text between BT (Begin Text) and ET (End Text) operators
  const btEtPattern = /BT\s([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;

  while ((match = btEtPattern.exec(raw)) !== null) {
    const block = match[1] ?? "";
    // Extract parenthesized strings (Tj/TJ operators)
    const stringPattern = /\(([^)]*)\)/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = stringPattern.exec(block)) !== null) {
      const text = strMatch[1] ?? "";
      if (text.length > 0) {
        textChunks.push(text);
      }
    }
  }

  // Also try to extract hex-encoded strings <XXXX>
  const hexPattern = /<([0-9A-Fa-f\s]+)>/g;
  while ((match = hexPattern.exec(raw)) !== null) {
    const hex = (match[1] ?? "").replace(/\s/g, "");
    if (hex.length >= 4 && hex.length <= 1000) {
      try {
        let decoded = "";
        for (let i = 0; i < hex.length; i += 2) {
          const charCode = parseInt(hex.slice(i, i + 2), 16);
          if (charCode >= 32 && charCode < 127) {
            decoded += String.fromCharCode(charCode);
          }
        }
        if (decoded.length > 2) {
          textChunks.push(decoded);
        }
      } catch {
        // Skip malformed hex strings
      }
    }
  }

  // Clean and join
  let text = textChunks
    .join(" ")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();

  // Remove PDF control artifacts
  text = text.replace(/[^\x20-\x7E\xA0-\xFF\u0100-\u017F\n]/g, " ");
  text = text.replace(/\s{3,}/g, "  ").trim();

  return text;
}

// ---------------------------------------------------------------------------
// Full entry processing — build decision or merger record from listing entry
// ---------------------------------------------------------------------------

function processEntry(
  entry: ListingEntry,
  pdfText: string | null,
): { decision: ParsedDecision | null; merger: ParsedMerger | null } {
  const { title, pdfUrl, publicationDate } = entry;

  // Date: prefer date extracted from title, fall back to publication date
  const titleDate = extractDateFromTitle(title);
  const date = titleDate ?? publicationDate;

  // Classification
  const { isMerger, type, outcome, status } = classifyEntry(title, pdfUrl);
  const sector = classifySector(title);
  const { parties, acquiring, target } = extractParties(title);

  // Case number
  const caseNumber = generateCaseNumber(title, pdfUrl, date);

  // Full text: use PDF text if available, otherwise use the title as fallback
  const fullText =
    pdfText && pdfText.length > 100
      ? pdfText
      : `${title}. Quelle: ${pdfUrl}`;

  // Summary: first 500 chars of the full text
  const summary =
    pdfText && pdfText.length > 100
      ? pdfText.slice(0, 500).replace(/\s+/g, " ").trim()
      : title;

  // Legal articles
  const gwbArticles = extractLegalArticles(fullText);

  // Fine amount
  const fineAmount = extractFineAmount(fullText);

  if (isMerger) {
    return {
      decision: null,
      merger: {
        case_number: caseNumber,
        title,
        date,
        sector,
        acquiring_party: acquiring,
        target,
        summary,
        full_text: fullText,
        outcome: outcome ?? "pending",
        turnover: null,
      },
    };
  }

  return {
    decision: {
      case_number: caseNumber,
      title,
      date,
      type,
      sector,
      parties,
      summary,
      full_text: fullText,
      outcome: outcome ?? (fineAmount ? "fine" : "pending"),
      fine_amount: fineAmount,
      gwb_articles: gwbArticles.length > 0 ? gwbArticles.join(", ") : null,
      status,
    },
    merger: null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created data directory: ${dir}`);
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function prepareStatements(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDecision = db.prepare(`
    INSERT INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      type = excluded.type,
      sector = excluded.sector,
      parties = excluded.parties,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      fine_amount = excluded.fine_amount,
      gwb_articles = excluded.gwb_articles,
      status = excluded.status
  `);

  const insertMerger = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMerger = db.prepare(`
    INSERT INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      sector = excluded.sector,
      acquiring_party = excluded.acquiring_party,
      target = excluded.target,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      turnover = excluded.turnover
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = excluded.decision_count,
      merger_count = excluded.merger_count
  `);

  return {
    insertDecision,
    upsertDecision,
    insertMerger,
    upsertMerger,
    upsertSector,
  };
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== WEKO/COMCO Competition Decisions Crawler ===");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Resume:     ${resume}`);
  console.log(`  Force:      ${force}`);
  console.log(`  Max items:  ${maxItems === Infinity ? "unlimited" : maxItems}`);
  console.log("");

  // Load resume state
  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  // -----------------------------------------------------------------------
  // Step 1: Fetch listing pages and discover decision entries
  // -----------------------------------------------------------------------
  console.log("Step 1: Fetching decision listing pages...\n");

  const allEntries: ListingEntry[] = [];

  // Fetch German listing page
  console.log(`  Fetching German listing: ${DECISIONS_DE}`);
  const deHtml = await rateLimitedFetch(DECISIONS_DE);
  if (deHtml) {
    const deEntries = parseListingPage(deHtml, "de");
    console.log(`    Found ${deEntries.length} entries (German)`);
    allEntries.push(...deEntries);
  } else {
    console.warn("  [WARN] Could not fetch German listing page");
  }

  // Fetch French listing page for additional entries
  console.log(`  Fetching French listing: ${DECISIONS_FR}`);
  const frHtml = await rateLimitedFetch(DECISIONS_FR);
  if (frHtml) {
    const frEntries = parseListingPage(frHtml, "fr");
    // Only add French entries not already discovered via German page
    const existingUrls = new Set(
      allEntries.map((e) => e.pdfUrl.replace(/\/dam\/(de|fr)\//, "/dam/x/")),
    );
    let frAdded = 0;
    for (const entry of frEntries) {
      const normalizedUrl = entry.pdfUrl.replace(
        /\/dam\/(de|fr)\//,
        "/dam/x/",
      );
      if (!existingUrls.has(normalizedUrl)) {
        allEntries.push(entry);
        existingUrls.add(normalizedUrl);
        frAdded++;
      }
    }
    console.log(
      `    Found ${frEntries.length} entries (French), ${frAdded} new`,
    );
  } else {
    console.warn("  [WARN] Could not fetch French listing page");
  }

  console.log(`\n  Total unique entries discovered: ${allEntries.length}`);

  // -----------------------------------------------------------------------
  // Step 2: Filter already-processed entries (for --resume)
  // -----------------------------------------------------------------------
  const entriesToProcess = resume
    ? allEntries.filter((e) => !processedSet.has(e.pdfUrl))
    : allEntries;

  // Apply --max-items limit
  const limited = entriesToProcess.slice(0, maxItems);

  console.log(`\nStep 2: Entries to process: ${limited.length}`);
  if (resume && allEntries.length !== entriesToProcess.length) {
    console.log(
      `  Skipping ${allEntries.length - entriesToProcess.length} already-processed entries`,
    );
  }
  if (limited.length < entriesToProcess.length) {
    console.log(
      `  Limited to ${maxItems} entries (${entriesToProcess.length - limited.length} deferred)`,
    );
  }

  if (limited.length === 0) {
    console.log("Nothing to process. Exiting.");
    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Initialize database (unless dry run)
  // -----------------------------------------------------------------------
  let db: Database.Database | null = null;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  if (!dryRun) {
    db = initDb();
    stmts = prepareStatements(db);
  }

  // -----------------------------------------------------------------------
  // Step 4: Process each entry — download PDF, extract text, classify, insert
  // -----------------------------------------------------------------------
  console.log("\nStep 3: Processing entries...\n");

  let decisionsIngested = state.decisionsIngested;
  let mergersIngested = state.mergersIngested;
  let errors = 0;
  let skipped = 0;
  const sectorCounts: SectorAccumulator = {};

  for (let i = 0; i < limited.length; i++) {
    const entry = limited[i]!;
    const progress = `[${i + 1}/${limited.length}]`;

    console.log(`${progress} ${entry.title.slice(0, 90)}`);
    console.log(`         PDF: ${entry.pdfUrl.slice(0, 100)}...`);

    // Download PDF for full text extraction
    let pdfText: string | null = null;
    try {
      const pdfBuffer = await rateLimitedFetchBuffer(entry.pdfUrl);
      if (pdfBuffer) {
        pdfText = extractTextFromPdf(pdfBuffer);
        if (pdfText.length < 50) {
          console.log(
            `  [INFO] PDF text extraction yielded minimal text (${pdfText.length} chars)`,
          );
          pdfText = null;
        } else {
          console.log(
            `  [INFO] Extracted ${pdfText.length} chars from PDF`,
          );
        }
      } else {
        console.log(`  [INFO] Could not download PDF, using title-only data`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  [WARN] PDF extraction error: ${message}`);
    }

    try {
      const { decision, merger } = processEntry(entry, pdfText);

      if (decision) {
        if (dryRun) {
          console.log(
            `  DECISION: ${decision.case_number} | type=${decision.type} | sector=${decision.sector} | outcome=${decision.outcome}`,
          );
          if (decision.fine_amount) {
            console.log(`    Fine: CHF ${decision.fine_amount.toLocaleString()}`);
          }
        } else {
          const stmt = force ? stmts!.upsertDecision : stmts!.insertDecision;
          stmt.run(
            decision.case_number,
            decision.title,
            decision.date,
            decision.type,
            decision.sector,
            decision.parties,
            decision.summary,
            decision.full_text,
            decision.outcome,
            decision.fine_amount,
            decision.gwb_articles,
            decision.status,
          );
          console.log(`  INSERTED decision: ${decision.case_number}`);
        }

        decisionsIngested++;

        if (decision.sector) {
          if (!sectorCounts[decision.sector]) {
            sectorCounts[decision.sector] = {
              name: decision.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[decision.sector]!.decisionCount++;
        }
      } else if (merger) {
        if (dryRun) {
          console.log(
            `  MERGER: ${merger.case_number} | sector=${merger.sector} | outcome=${merger.outcome}`,
          );
          console.log(
            `    ${merger.acquiring_party ?? "?"} -> ${merger.target ?? "?"}`,
          );
        } else {
          const stmt = force ? stmts!.upsertMerger : stmts!.insertMerger;
          stmt.run(
            merger.case_number,
            merger.title,
            merger.date,
            merger.sector,
            merger.acquiring_party,
            merger.target,
            merger.summary,
            merger.full_text,
            merger.outcome,
            merger.turnover,
          );
          console.log(`  INSERTED merger: ${merger.case_number}`);
        }

        mergersIngested++;

        if (merger.sector) {
          if (!sectorCounts[merger.sector]) {
            sectorCounts[merger.sector] = {
              name: merger.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[merger.sector]!.mergerCount++;
        }
      } else {
        console.log(`  SKIP -- could not classify`);
        skipped++;
      }

      // Mark as processed
      processedSet.add(entry.pdfUrl);
      state.processedUrls.push(entry.pdfUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      state.errors.push(`process_error: ${entry.pdfUrl}: ${message}`);
      errors++;
    }

    // Save state periodically (every 25 entries)
    if ((i + 1) % 25 === 0) {
      state.decisionsIngested = decisionsIngested;
      state.mergersIngested = mergersIngested;
      saveState(state);
      console.log(`  [checkpoint] State saved after ${i + 1} entries`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Update sector counts
  // -----------------------------------------------------------------------
  if (!dryRun && db && stmts) {
    const sectorMeta: Record<string, { name: string; name_en: string }> = {};
    for (const s of SECTOR_MAPPING) {
      sectorMeta[s.id] = { name: s.name, name_en: s.name_en };
    }

    // Count decisions and mergers per sector from the database
    const decisionSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;
    const mergerSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;

    const finalSectorCounts: Record<
      string,
      { decisions: number; mergers: number }
    > = {};
    for (const row of decisionSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = { decisions: 0, mergers: 0 };
      finalSectorCounts[row.sector]!.decisions = row.cnt;
    }
    for (const row of mergerSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = { decisions: 0, mergers: 0 };
      finalSectorCounts[row.sector]!.mergers = row.cnt;
    }

    const updateSectors = db.transaction(() => {
      for (const [id, counts] of Object.entries(finalSectorCounts)) {
        const meta = sectorMeta[id];
        stmts!.upsertSector.run(
          id,
          meta?.name ?? id,
          meta?.name_en ?? null,
          null,
          counts.decisions,
          counts.mergers,
        );
      }
    });
    updateSectors();

    console.log(
      `\nUpdated ${Object.keys(finalSectorCounts).length} sector records`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 6: Final state save and summary
  // -----------------------------------------------------------------------
  state.decisionsIngested = decisionsIngested;
  state.mergersIngested = mergersIngested;
  saveState(state);

  if (!dryRun && db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const mergerCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
        cnt: number;
      }
    ).cnt;
    const sectorCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  Decisions in DB:  ${decisionCount}`);
    console.log(`  Mergers in DB:    ${mergerCount}`);
    console.log(`  Sectors in DB:    ${sectorCount}`);
    console.log(`  Decisions added:  ${decisionsIngested}`);
    console.log(`  Mergers added:    ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
    console.log(`  State saved to:   ${STATE_FILE}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Decisions found:  ${decisionsIngested}`);
    console.log(`  Mergers found:    ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
  }

  console.log(`\nDone.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
