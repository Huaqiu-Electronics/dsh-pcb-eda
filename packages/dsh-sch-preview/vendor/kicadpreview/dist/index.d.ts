import type { EcadBlob, EcadSources, EcadViewerElement, ExportImageResult, ExportImageViewType } from "./shared/types";

export type { EcadBlob, EcadSources, EcadViewerElement, ExportImageResult, ExportImageViewType };
export { KICAD_EXTENSIONS } from "./shared/types";

export interface LoadOptions {
    glbUrl?: string;
}

export interface BomItem {
    Reference: string;
    Name: string;
    Datasheet: string;
    Footprint: string;
    Description: string;
    DNP: boolean;
    Qty: number;
    Price: number;
}

export class SchematicViewer {
    constructor(container: HTMLElement);
    loadFromUrls(urls: string[]): Promise<void>;
    loadFromFiles(files: File[] | FileList): Promise<void>;
    fitScreen(): void;
    exportImage(viewType?: ExportImageViewType): Promise<ExportImageResult | null>;
    /** 设为 true 隐藏点击器件时弹出的属性面板，默认 false */
    hidePropertiesPanel: boolean;
    readonly element: HTMLElement | null;
    dispose(): void;
}

export class PCBViewer {
    constructor(container: HTMLElement);
    loadFromUrls(urls: string[]): Promise<void>;
    loadFromFiles(files: File[] | FileList): Promise<void>;
    fitScreen(): void;
    exportImage(viewType?: ExportImageViewType): Promise<ExportImageResult | null>;
    /** 设为 true 隐藏点击器件时弹出的属性面板，默认 false */
    hidePropertiesPanel: boolean;
    readonly element: HTMLElement | null;
    dispose(): void;
}

export class BomViewer {
    constructor(container: HTMLElement);
    loadFromUrls(urls: string[]): Promise<BomItem[]>;
    loadFromFiles(files: File[] | FileList): Promise<BomItem[]>;
    search(query: string): BomItem[];
    readonly bomItems: readonly BomItem[];
    readonly isMobile: boolean;
    toCsv(): string;
    toTsv(): string;
    dispose(): void;
}

export class ECadViewerHelper {
    constructor(container: HTMLElement);
    loadFromUrls(urls: string[], opts?: LoadOptions): Promise<void>;
    loadFromFiles(files: File[] | FileList): Promise<void>;
    fitScreen(): void;
    exportImage(viewType?: ExportImageViewType): Promise<ExportImageResult | null>;
    /** 设为 true 隐藏点击器件时弹出的属性面板，默认 false */
    hidePropertiesPanel: boolean;
    readonly element: HTMLElement | null;
    dispose(): void;
}

export function ensureEcadViewer(): Promise<void>;
