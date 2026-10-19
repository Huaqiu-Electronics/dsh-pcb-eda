import {defineConfig} from 'tsdown'
export default defineConfig({entry:['src/client/index.ts'],outDir:'lib',format:'iife',platform:'browser',clean:false,outputOptions:{entryFileNames:'client.js'}})
