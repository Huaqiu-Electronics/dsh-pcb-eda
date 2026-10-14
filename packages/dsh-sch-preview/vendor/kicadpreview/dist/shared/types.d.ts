export const KICAD_EXTENSIONS = [".kicad_sch", ".kicad_pcb", ".kicad_pro", ".kicad_wks"] as const;

export interface EcadBlob {
    filename: string;
    content: string;
}

export interface EcadSources {
    urls: string[];
    blobs: EcadBlob[];
}

export type ExportImageViewType = "SCH" | "PCB" | "3D" | "BOM";

export interface ExportImageResult {
    image: string;
    width: number;
    height: number;
}

export interface EcadViewerElement extends HTMLElement {
    loaded: boolean;
    project: {
        ov_3d_url?: string;
        pages: Array<unknown>;
        load(sources: EcadSources): Promise<void>;
        on_loaded(): void;
    };
    update(): Promise<void>;
    exportImage(viewType?: ExportImageViewType): Promise<ExportImageResult | null>;
}
