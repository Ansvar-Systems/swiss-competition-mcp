/**
 * Seed the COMCO database with sample decisions, mergers, and sectors.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["COMCO_DB_PATH"] ?? "data/comco.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow { id: string; name: string; name_en: string; description: string; decision_count: number; merger_count: number; }

const sectors: SectorRow[] = [
  { id: "bau", name: "Bauwirtschaft", name_en: "Construction", description: "Schweizer Baumarkt: hochkonzentriert auf regionaler Ebene, wiederkehrende WEKO-Untersuchungen wegen Submissionsabsprachen. Wichtigste Akteure: Implenia, Marti, Implenia, Losinger Marazzi, ARGE-Strukturen.", decision_count: 55, merger_count: 20 },
  { id: "telekommunikation", name: "Telekommunikation", name_en: "Telecommunications", description: "Schweizer Telekommunikationsmarkt: Swisscom (Marktführer), Sunrise-UPC, Salt. Festnetz, Mobilfunk und Breitband. WEKO koordiniert mit Regulierungsbehörde ComCom (Post- und Fernmelderecht).", decision_count: 28, merger_count: 12 },
  { id: "detailhandel", name: "Detailhandel", name_en: "Retail", description: "Schweizer Detailhandel: Migros und Coop dominieren (Duopol, >70% Marktanteil). Denner (Migros-Tochter), Lidl, Aldi als Wettbewerber. WEKO-Fokus auf Lieferantenbeziehungen und Preisabsprachen.", decision_count: 22, merger_count: 15 },
  { id: "energie", name: "Energie", name_en: "Energy", description: "Schweizer Energiemarkt: Axpo, BKW, Alpiq als grosse Produzenten. Teilprivatisierter Markt (Grossverbraucher freier Markt, Kleinverbraucher noch monopolisiert). ElCom als Regulierungsbehörde.", decision_count: 18, merger_count: 14 },
  { id: "gesundheitswesen", name: "Gesundheitswesen", name_en: "Healthcare", description: "Schweizer Gesundheitsmarkt: Pharmaindustrie (Novartis, Roche), Krankenversicherer (CSS, Helsana, Swica), Spitäler. WEKO-Fälle zu Pharmakartellen, Krankenkassen-Absprachen und Spitalfusionen.", decision_count: 15, merger_count: 10 },
];

const insertSector = db.prepare("INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)");
for (const s of sectors) insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow { case_number: string; title: string; date: string; type: string; sector: string; parties: string; summary: string; full_text: string; outcome: string; fine_amount: number | null; gwb_articles: string; status: string; }

const decisions: DecisionRow[] = [
  {
    case_number: "RPW/DPC 2023/4",
    title: "Swisscom — Missbräuchliches Verhalten bei Breitbanddiensten für Wiederverkäufer",
    date: "2023-07-25",
    type: "abuse_of_dominance",
    sector: "telekommunikation",
    parties: "Swisscom AG",
    summary: "Die WEKO stellte das Verfahren gegen Swisscom wegen missbräuchlicher Preisgestaltung bei Breitband-Vorleistungen ein, nachdem Swisscom Verpflichtungen eingegangen war: Absenkung der BBCS-Vorleistungspreise, Einführung eines neuen Tarif-Layers und Verzicht auf bestimmte Exklusivitätsklauseln in Wiederverkäufer-Verträgen.",
    full_text: "RPW/DPC 2023/4 Swisscom Breitband Vorleistungen. Sachverhalt: Swisscom bietet Wiederverkäufern (Sunrise, Salt, EWZ) Zugang zu Breitband-Vorleistungsprodukten (BBCS — Bitstream Access, FTTH-Zugang). WEKO-Untersuchung ergab: (1) Preis-Kosten-Schere (margin squeeze): Swisscom-Wiederverkäufer konnten Endkundenpreise von Swisscom nicht profitabel unterbieten; (2) Bündelung: Swisscom verknüpfte FTTH-Zugang mit Abnahme von TV-Diensten; (3) Exklusivität: bestimmte Vertragsklauseln schränkten Wiederverkäufer bei der Weitervermarktung ein. Art. 7 KG: Missbrauch marktbeherrschender Stellung. WEKO-Verpflichtungsverfahren nach Art. 29 KG. Swisscom-Zusagen: BBCS-Preissenkung -12%; neues Layer-3-Produkt für Wiederverkäufer; Aufhebung Exklusivitätsklauseln. Monitoring WEKO 3 Jahre.",
    outcome: "cleared_with_conditions",
    fine_amount: null,
    gwb_articles: "Art. 7 KG, Art. 29 KG",
    status: "final",
  },
  {
    case_number: "RPW/DPC 2022/2",
    title: "Submissionsabsprachen Hochbau Kanton Zürich",
    date: "2022-04-14",
    type: "cartel",
    sector: "bau",
    parties: "Implenia AG; Marti AG; Anliker AG; Steiner AG; weitere Zürcher Hochbauunternehmen (8 Unternehmen total)",
    summary: "Die WEKO sanktionierte 8 Hochbauunternehmen im Kanton Zürich wegen Submissionsabsprachen (Bid Rigging) mit Sanktionen von insgesamt CHF 24,6 Millionen. Die Unternehmen koordinierten Angebote bei öffentlichen Ausschreibungen im Wert von CHF 890 Millionen über einen Zeitraum von 7 Jahren.",
    full_text: "RPW/DPC 2022/2 Submissionsabsprachen Hochbau Zürich. Zeitraum: 2013-2020 (7 Jahre). Volumen: koordinierte Ausschreibungen CHF 890 Millionen; 120 öffentliche Bauprojekte betroffen (Schulhäuser, Verwaltungsgebäude, Wohnbau). Mechanismus: regelmäßige Treffen von Baufirmen; Absprache von Schutzangeboten (ein Unternehmen bietet, andere stellen Scheinangebote höher; Rotation des Zuschlags); Kompensationsabsprachen bei Nicht-Rotation. Art. 4 Abs. 1 i.V.m. Art. 5 Abs. 3 KG: harte Wettbewerbsabreden (Bid Rigging per se verboten). Sanktionen total CHF 24,6 Mio.: Implenia CHF 6,2M; Marti CHF 5,1M; Anliker CHF 4,3M; Steiner CHF 3,8M; weitere CHF 5,2M. Bonusregelung: zwei Unternehmen erhielten Sanktionsreduktion (20% und 35%) für Kooperation. Strafrechtliche Anzeige: WEKO erstattete Anzeige bei SECO wegen Verstössen gegen Art. 23 KG.",
    outcome: "fine",
    fine_amount: 24600000,
    gwb_articles: "Art. 4 Abs. 1 i.V.m. Art. 5 Abs. 3 KG",
    status: "final",
  },
  {
    case_number: "RPW/DPC 2023/1",
    title: "Migros / Vertikale Preisbindung Markenprodukte",
    date: "2023-02-20",
    type: "abuse_of_dominance",
    sector: "detailhandel",
    parties: "Migros-Genossenschafts-Bund; ausgewählte Markenlieferanten (anonymisiert)",
    summary: "Die WEKO schloss eine Untersuchung gegen Migros wegen Verdachts auf Preisbindung der zweiten Hand (RPM) mit Untersuchungseinstellung ab. Migros hatte keine formellen RPM-Klauseln, nutzte aber informellen Druck. WEKO stellte kein qualifiziertes Verhalten fest, empfahl jedoch Compliance-Massnahmen.",
    full_text: "RPW/DPC 2023/1 Migros Vertikale Preisbindung. Ausgangslage: Beschwerden von Markenlieferanten, Migros verlange faktische Preisbindung für Migros-Sortiment via informellen Druck (Auslistungsdrohung). Keine schriftlichen RPM-Klauseln gefunden. WEKO-Analyse: (1) Art. 5 Abs. 4 KG: vertikale Preisabreden als harte Wettbewerbsabrede wenn nachgewiesen; (2) Migros-Marktmacht: HHI Detailhandel national moderat (Migros ~30%, Coop ~28%); regional höher (Deutschschweiz bis 40%); (3) Beweislage: kein direkter Nachweis formeller Abrede; Auslistungsdrohungen einzelfallbezogen. Schlussfolgerung WEKO: kein hinreichend qualifiziertes Verhalten für Sanktion; jedoch Empfehlungen an Migros: Compliance-Programm; keine Androhungen bezogen auf Listenpreise; transparente Listungskriterien. Einstellung nach Art. 27 KG.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: "Art. 5 Abs. 4 KG",
    status: "final",
  },
  {
    case_number: "RPW/DPC 2024/1",
    title: "Roche AG — Missbrauch im Markt für diagnostische Reagenzien",
    date: "2024-02-08",
    type: "abuse_of_dominance",
    sector: "gesundheitswesen",
    parties: "Roche Diagnostics AG",
    summary: "Die WEKO eröffnete eine formelle Untersuchung gegen Roche Diagnostics wegen Verdachts auf missbräuchliche Kopplung von Diagnosegeräten und Reagenzien (Tying). Spitäler können Roche-Analyseautomaten nur mit Original-Roche-Reagenzien betreiben, ohne technische Notwendigkeit. Verfahren läuft.",
    full_text: "RPW/DPC 2024/1 Roche Diagnostics Tying. Markt: Analysegeräte für klinische Labordiagnostik (Immunassays, klinische Chemie); Roche dominiert mit >60% Schweizer Spital-Labormarkt. Vorgeworfenes Verhalten: (1) Tying/Kopplung: Roche-Analyseautomaten sind technisch so gesperrt, dass ausschliesslich Roche-Original-Reagenzien eingesetzt werden können; (2) keine technische Notwendigkeit nachgewiesen (internationale Regulatoren FDA/EMA akzeptieren Third-Party-Reagenzien); (3) Preiseffekt: Roche-Reagenzien 30-60% teurer als Drittanbieter; Schweizer Spitäler zahlen Mehrkosten von schätzungsweise CHF 120M/Jahr. Art. 7 Abs. 2 lit. f KG: missbräuchliche Kopplung von Produkten. Koordination mit Heilmittelrecht (Swissmedic). Stand: Untersuchungseröffnung Februar 2024; kein Entscheid veröffentlicht.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: "Art. 7 Abs. 2 lit. f KG",
    status: "pending",
  },
  {
    case_number: "RPW/DPC 2022/4",
    title: "Sektoruntersuchung Gasversorgung Schweiz",
    date: "2022-12-15",
    type: "sector_inquiry",
    sector: "energie",
    parties: "Schweizer Gasversorgungsmarkt (Gaznat, Erdgas Ostschweiz, Regio Energie Solothurn, weitere)",
    summary: "Die WEKO publizierte den Bericht ihrer Sektoruntersuchung zum Gasversorgungsmarkt. Trotz Liberalisierungsrückstands der Schweiz: Monopolsegmente für Haushaltskunden, bedingt geöffneter Markt für Grossabnehmer. Empfehlung: vollständige Marktöffnung, Trennung von Netz und Handel, Regulierung durch ElCom.",
    full_text: "RPW/DPC 2022/4 Sektoruntersuchung Gasversorgung. Status Liberalisierung: Strom seit 2009 für Grossabnehmer geöffnet; Gas bis dato nicht liberalisiert (kein Energiegesetz für Gas). Haushaltskunden: Monopolversorgung durch regionale Gasversorger; keine Wahlmöglichkeit; Preise administrativ genehmigt. Grossabnehmer: bedingt freier Marktzugang; Import via Gaznat (Interconnector); lokale Netze vertikal integriert. WEKO-Befunde: (1) fehlende Netzzugangspflicht verhindert Wettbewerb auf Handelsebene; (2) überhöhte Netznutzungstarife ohne Regulierung; (3) vertikale Integration Netz/Handel schafft Interessenkonflikte; (4) import-Diversifikation ungenügend (hohe Abhängigkeit von einer Importroute). Empfehlungen: Erlass eines Gasliberalisierungsgesetzes; Trennung Netz und Handel (Unbundling); ElCom-Zuständigkeit auf Gas ausweiten; Netznutzungstarife regulieren.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: "Art. 45 Abs. 2 KG (Sektoruntersuchung)",
    status: "final",
  },
];

const insertDecision = db.prepare(`INSERT OR IGNORE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const d of decisions) insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status);
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow { case_number: string; title: string; date: string; sector: string; acquiring_party: string; target: string; summary: string; full_text: string; outcome: string; turnover: number | null; }

const mergers: MergerRow[] = [
  {
    case_number: "RPW/DPC 2023/3-fusion",
    title: "Sunrise Communications / UPC Switzerland — Telekommunikationsfusion",
    date: "2021-11-15",
    sector: "telekommunikation",
    acquiring_party: "Sunrise Communications AG (Liberty Global-Tochter)",
    target: "UPC Switzerland GmbH (Kabelnetzbetreiber)",
    summary: "Die WEKO genehmigte die Fusion von Sunrise und UPC Switzerland (Kabelnetzbetreiber) ohne Auflagen. Die kombinierte Einheit ist der grösste Herausforderer von Swisscom. Trotz horizontaler Überlappungen im Mobilfunk keine erhebliche Wettbewerbsbeeinträchtigung festgestellt.",
    full_text: "RPW/DPC 2023/3-fusion Sunrise / UPC Switzerland. Transaktion: Liberty Global (Eigentümer UPC Switzerland) akquiriert Sunrise Communications; Fusion der beiden Unternehmen. Sunrise: Mobilfunk-MNO Nr. 2 (ca. 3 Mio. Mobilkunden); kein eigenes Kabelnetz. UPC Switzerland: zweitgrösster Kabelnetzbetreiber; keine eigene Mobilfunklizenz (MVNO). Synergien: Sunrise erhält Zugang zu Glasfaser-/Kabelnetz von UPC (2,3 Mio. Haushalte); UPC erhält Mobilfunknetz von Sunrise; Quadplay-Angebot möglich. Marktanalyse WEKO: (1) Mobilfunk: Sunrise+UPC-MVNO <1% Zusatz; kein relevanter Effekt; (2) Festnetz-Breitband: Kabelnetz UPC + Sunrise Resale von Swisscom — kein Duopol; (3) Bündelangebote: neue Konkurrenz zu Swisscom-Quadplay vorteilhaft für Konsumenten. WEKO-Entscheid: Genehmigung ohne Auflagen; Entstehung starker Swisscom-Herausforderer positiv für Wettbewerb.",
    outcome: "cleared",
    turnover: 3200000000,
  },
  {
    case_number: "RPW/DPC 2022/1-fusion",
    title: "Axpo Holding AG / Repower AG — Energiefusion Ostschweiz",
    date: "2022-02-28",
    sector: "energie",
    acquiring_party: "Axpo Holding AG",
    target: "Repower AG (Graubünden, ~49% Beteiligung aufgestockt auf Kontrolle)",
    summary: "Die WEKO genehmigte die Kontrollübernahme von Repower AG durch Axpo Holding mit Auflagen für den Kanton Graubünden. Axpo und Repower überschneiden sich in der Stromerzeugung und -verteilung in der Ostschweiz. Auflage: Veräusserung bestimmter Verteilnetze.",
    full_text: "RPW/DPC 2022/1-fusion Axpo / Repower. Transaktion: Axpo Holding (grösster Schweizer Stromproduzent) erhöht Beteiligung an Repower AG von 49% (Minderheit) auf 63% (Kontrollerwerb). Axpo: Schwerpunkt Nordostschweiz, Wasserkraft und Kernkraft; grosse Industriekunden. Repower: Graubünden und Tessin; Wasserkraft; internationale Handelsaktivitäten. Marktanalyse: (1) Stromerzeugung: horizontal overlapping in Graubünden; kombinierte Kapazität >85% Kanton; (2) Stromhandel: Axpo internationaler Händler; Repower: Alpentransit-Handelsstrom; keine kritische Überschneidung; (3) Verteilnetz: Repower betreibt Verteilnetz in 3 Graubündner Gemeinden; Axpo kein Verteilnetz GR. Auflagen WEKO: Veräusserung Repower-Verteilnetz in Klosters, Davos-Platz, Lenzerheide an neutrale Käufer; Nicht-Diskriminierung Netzzugang; Trennung Netz/Handel (funktionales Unbundling). Monitoring 5 Jahre.",
    outcome: "cleared_with_conditions",
    turnover: 5800000000,
  },
  {
    case_number: "RPW/DPC 2023/5-fusion",
    title: "Migros / Denner (Reorganisation) — Kontrolle Discountformat",
    date: "2023-09-14",
    sector: "detailhandel",
    acquiring_party: "Migros-Genossenschafts-Bund",
    target: "Denner AG (interne Reorganisation vollständige Tochtergesellschaft)",
    summary: "Die WEKO prüfte die interne Reorganisation von Denner AG (Discount-Kette, 100% Migros-Tochter) und stellte fest, dass kein meldepflichtiger Zusammenschluss vorliegt, da Migros Denner bereits kontrolliert. Kein Entscheid erforderlich.",
    full_text: "RPW/DPC 2023/5-fusion Migros / Denner Reorganisation. Sachverhalt: Migros-Genossenschafts-Bund (MGB) restrukturiert die Beteiligung an Denner AG — von indirekter Kontrolle (über Migros-Genossenschaft Zürich) zur direkten MGB-Kontrolle. Denner: ~820 Filialen; Schweizer Discount-Marktführer; Alkohol/Tabak-Fokus. KG-Prüfung: Art. 9 ff. KG — Meldepflicht bei Kontrollwechsel. Beurteilung: MGB kontrollierte Denner bereits indirekt; keine Änderung der wirtschaftlichen Kontrolle; kein qualifizierter Kontrollwechsel; Meldepflicht nicht ausgelöst. Marktstruktur bleibt unverändert. WEKO: kein Entscheid (Nicht-Meldepflicht bestätigt).",
    outcome: "cleared_phase1",
    turnover: 2900000000,
  },
];

const insertMerger = db.prepare(`INSERT OR IGNORE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const m of mergers) insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover);
console.log(`Inserted ${mergers.length} mergers`);

const dc = (db.prepare("SELECT COUNT(*) as n FROM decisions").get() as { n: number }).n;
const mc = (db.prepare("SELECT COUNT(*) as n FROM mergers").get() as { n: number }).n;
const sc = (db.prepare("SELECT COUNT(*) as n FROM sectors").get() as { n: number }).n;
console.log(`\nDatabase summary:\n  Decisions: ${dc}\n  Mergers: ${mc}\n  Sectors: ${sc}\n\nSeed complete.`);
