/**
 * 放置一颗已选定的器件（manufacturerId + mpn 来自 search_hqsch_parts 或 scripts/search-parts.ts）。
 *
 *   MFR_ID=7189 MPN=STM32F103C8T6 REF=U1 VALUE=STM32F103C8T6 X=400 Y=300 npx tsx scripts/place-part.ts
 *
 * 可选 PKG=<封装>：footprint 没有 fileName 时写入 Footprint 属性。
 */
import { hqMainWithProject } from "./lib/hq.js";
import { calibratePageTop, placePartByMpn, waitForIds } from "./modular-lib.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`需要 ${k}=`);
  return v;
};

hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {
  const spec = {
    manufacturerId: env("MFR_ID"),
    mpn: env("MPN"),
    ref: env("REF"),
    value: process.env.VALUE ?? env("MPN"),
    x: Number(env("X")),
    y: Number(env("Y")),
    pkg: process.env.PKG,
  };
  console.log("projectId:", projectId);
  await calibratePageTop(client, ctx).catch(() => { /* keep default */ });

  const { id } = await placePartByMpn(client, ctx, spec);
  await waitForIds(client, ctx, [id], spec.ref);
  console.log(`✓ 已放置 ${spec.ref}（${spec.mpn}）objectId=${id}`);
});
