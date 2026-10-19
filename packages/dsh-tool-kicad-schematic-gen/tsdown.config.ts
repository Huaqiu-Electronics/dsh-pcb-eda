import {defineConfig} from 'tsdown'

export default defineConfig({
  entry:{index:'./src/index.ts',builder:'./src/builder.ts'},
  format:['esm'],platform:'node',target:'node22',outDir:'lib',fixedExtension:false,
  dts:true,clean:true,tsconfig:'tsconfig.build.json',
  deps:{alwaysBundle:['@deepseek-ai/schemastery','fflate'],
    neverBundle:[/^@deepseek-ai\/(?!schemastery$|cosmokit$)/,'pdfjs-dist','undici','kicad-sexpr-parser','@huaqiu/part-search','sharp']},
})
