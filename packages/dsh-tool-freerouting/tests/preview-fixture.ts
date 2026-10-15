export const previewDsn = `(pcb board (parser (string_quote ")) (resolution um 10) (unit um)
 (structure (layer F.Cu) (layer B.Cu)
 (boundary (path pcb 0 0 -10000 20000 -10000 20000 -30000 0 -30000 0 -10000)))
 (network (net N (pins J1-1 J2-1))))`;
export const previewSes = `(session board (routes (resolution um 10)
 (library_out (padstack Via (shape (circle F.Cu 6000)) (shape (circle B.Cu 6000))))
 (network_out (net N (wire (path F.Cu 2000 10000 -110000 190000 -290000))
 (wire (path B.Cu 2500 10000 -110000 50000 -120000)) (via Via 10000 -110000)))))`;
