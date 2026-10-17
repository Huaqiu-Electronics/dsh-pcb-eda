/**
 * 器件选型（只读，不连 HQ EDA）：列出候选，供 agent 选定后再放置。
 * 没有 DSH part-search tool（search_hqsch_parts）时用它代替。
 *
 *   QUERY="0805 100nF" npx tsx scripts/search-parts.ts
 *   QUERY="STM32F103C8" PAGE_SIZE=20 npx tsx scripts/search-parts.ts
 *   MFR_ID=7189 MPN=STM32F103C8T6 npx tsx scripts/search-parts.ts   # 查某一颗的 EDA 模型
 *
 * 选定后把 manufacturerId + mpn 写进放置脚本，用 modular-lib 的 placePartByMpn 或 scripts/place-part.ts。
 */
import { createPartSearchService } from "@huaqiu/huaqiu-client";

const QUERY = process.env.QUERY;
const MFR_ID = process.env.MFR_ID;
const MPN = process.env.MPN;
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 10;
const LANGUAGE = process.env.LANGUAGE ?? "zh";

async function main() {
  const parts = createPartSearchService({ language: LANGUAGE });

  if (MFR_ID && MPN) {
    const models = await parts.getEdaModels({ manufacturerId: MFR_ID, mpn: MPN });
    console.log(`${MPN}（厂商 ${MFR_ID}）`);
    for (const k of ["symbol", "footprint", "model3d", "simulation"] as const) {
      const m = models[k];
      console.log(`  ${k.padEnd(10)} ${m ? `${m.fileName ?? ""} ${m.url}` : "—"}`);
    }
    return;
  }

  if (!QUERY) throw new Error('需要 QUERY="关键词"，或 MFR_ID= + MPN= 查单颗模型');
  const page = await parts.searchParts({
    query: QUERY,
    pageSize: PAGE_SIZE,
    requirements: { symbol: true, footprint: true },
  });
  console.log(`「${QUERY}」共 ${page.total} 条，第 ${page.page}/${page.pages} 页：\n`);
  console.log(["#", "MPN", "manufacturerId", "厂商", "封装", "符号/封装/3D", "描述"].join("\t"));
  page.items.forEach((i, n) => {
    const flags = [i.hasSymbol, i.hasFootprint, i.has3dModel].map((f) => (f ? "✓" : "—")).join("/");
    console.log([n + 1, i.mpn, i.manufacturer.id ?? "?", i.manufacturer.name, i.package ?? "", flags, i.description ?? ""].join("\t"));
  });
  console.log("\n选定后：MFR_ID=<manufacturerId> MPN=<mpn> REF=… VALUE=… X=… Y=… npx tsx scripts/place-part.ts");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
